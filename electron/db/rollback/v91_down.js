// Inverse of migration v91 (electron/db/localDb.js) — Amendment 2026-10-03b,
// docs/adr/2026-10-02-distributed-revocation-authority.md's "closing the two-device residual".
//
//   1. `ALTER TABLE devices DROP COLUMN revoked_without_authority_knowledge` — the column sits
//      in no index and no CHECK constraint, so the plain single-statement form applies (v87_down's
//      shape, not v51_down's recreate-and-copy).
//   2. No registry membership to restore: `devices` as a whole is already excluded from the
//      synced document (hostOnlyExclusion.test.js's NON_DOCUMENT_TABLES) and was never added to
//      PROJECTIONS/campScopedEntities.js/campDocument.js's MODELED_ENTITIES for this or any other
//      column. Nothing else changes.
//   3. Data loss: every `revoked_without_authority_knowledge = 1` marker is discarded. There is
//      no prior value to restore — the column did not exist before v91 — and, unlike v87's
//      label_key, this loss is NOT recoverable by regeneration: a device holding that marker
//      loses its one path back to `clearUncorroboratedRevocation` and stays hard-blocked from the
//      target until the target's real grant/revoke history arrives by some OTHER channel (the
//      same bounded residual the amendment names for the case this column doesn't apply to).
//      This script is for rolling back the MIGRATION, not a decision to accept that regression —
//      it is named here so a reader doing an actual rollback knows what they are giving up.
//
// Usage:  node electron/db/rollback/v91_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const hasColumn = (db, table, column) =>
  hasTable(db, table) && db.pragma(`table_info(${table})`).some((c) => c.name === column)

/**
 * @returns {{ok:true, discarded:{uncorroboratedMarkers:number}}}
 */
export function rollbackV91(db) {
  const discarded = {
    uncorroboratedMarkers: hasColumn(db, 'devices', 'revoked_without_authority_knowledge')
      ? db.prepare('SELECT COUNT(*) c FROM devices WHERE revoked_without_authority_knowledge = 1').get().c
      : 0,
  }

  db.transaction(() => {
    if (hasColumn(db, 'devices', 'revoked_without_authority_knowledge')) {
      db.exec('ALTER TABLE devices DROP COLUMN revoked_without_authority_knowledge')
    }
    // `>= 91`, never `= 91` — a bare equality strands any HIGHER version in the table, so
    // rolling back v91 on a database that has since migrated further leaves getSchemaVersion()
    // reporting the higher version while v91's column is gone: a shape no migration path can
    // produce and none will repair (bareEqualityRollback.guard.test.js).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 91').run()
  })()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v91_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v91_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v91_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 91)
  const result = rollbackV91(db)
  db.close()
  console.log(
    `v91 rolled back: discarded ${result.discarded.uncorroboratedMarkers} ` +
    'devices.revoked_without_authority_knowledge marker(s). Unlike a regenerable column, a ' +
    'discarded marker is NOT recoverable — the device(s) it flagged lose their path back to ' +
    'clearUncorroboratedRevocation until their real authority history arrives by some other ' +
    'channel. This app build still declares schema version 91: reopening it re-adds the column, ' +
    'empty.'
  )
}
