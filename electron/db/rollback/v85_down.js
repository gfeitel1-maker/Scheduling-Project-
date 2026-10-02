// Inverse of migration v85 (electron/db/localDb.js) — T321, docs/adr/
// 2026-10-01-camper-id-high-entropy-format.md.
//
//   1. `DROP TABLE camper_identity_keys`, and its one index goes with it. v85
//      added a table and touched no existing one — same shape as v82_down
//      (camp_seedlings): nothing to recreate-and-copy, no column to drop out
//      of a CHECK.
//   2. The index is NOT dropped separately. SQLite drops an index with its
//      table; an explicit `DROP INDEX` after the table is gone is an error
//      rather than a no-op on some builds — stated because the reflex is to
//      mirror the migration statement for statement.
//   3. No registry membership restored: this script does not touch PROJECTIONS
//      (electron/ops/projections.js), MODELED_ENTITIES/GENESIS_ENTITIES
//      (electron/automerge/campDocument.js), DIRECT_CAMP_ENTITIES
//      (electron/ops/campScopedEntities.js), TOMBSTONE_DENYLISTED_ENTITIES
//      (electron/automerge/projector.js) or src/localClient.mock.js. Those are
//      separate, deliberate code changes a schema-only rollback does not undo
//      — same ruling as v82_down point 3 / v83_down point 3.
//   4. THIS ENTITY REPLICATES, and that changes what a rollback means.
//      Dropping the table removes this device's PROJECTION of the rows; it
//      does not remove them from the Automerge document, and it does not tell
//      any peer. A device still on v85 keeps its copy and will re-send it. So
//      this is a local un-projection, not a fleet erasure — if the intent is
//      that no device remembers a mapping, that is a purge
//      (purgeSupportCommand.js's path), not this script.
//   5. Data loss, stated as the consequence rather than the row count: every
//      name/external-id -> camper_id lookup this device knew is forgotten ON
//      THIS DEVICE. The next sheet import that needs to resolve an
//      already-known camper (after this device re-syncs with a peer still on
//      v85, or after re-running this app's own migration) will see the
//      mapping again once it re-projects; until then a fresh import on THIS
//      device alone would mint a NEW random camper_id for a camper it already
//      has — the exact fork this entity exists to prevent. No camper, name or
//      preference row is read or written here; `campers` itself is untouched.
//
// Usage:  node electron/db/rollback/v85_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{keys:number}}}
 */
import { assertHighestApplied } from './assertHighestApplied.js'

export function rollbackV85(db) {
  const discarded = { keys: 0 }

  if (hasTable(db, 'camper_identity_keys')) {
    discarded.keys = db.prepare('SELECT COUNT(*) c FROM camper_identity_keys').get().c
    db.exec('DROP TABLE camper_identity_keys')
  }

  // `>= 85`, never `= 85` — a bare equality leaves any LATER migration row
  // behind, so a database rolled back from a future version would claim a
  // version whose shape it no longer has (bareEqualityRollback.guard.test.js).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 85').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v85_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v85_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v85_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 85)
  const result = rollbackV85(db)
  db.close()
  console.log(
    `v85 rolled back: dropped camper_identity_keys with ${result.discarded.keys} row(s). ` +
    'NOTE: this entity REPLICATES, so this removes only THIS device\'s projection; a peer still on ' +
    'v85 keeps its copy and will re-send it. A fresh sheet import on THIS device alone, before any ' +
    're-sync, could mint a new random camper id for an already-known camper. This app build still ' +
    'declares schema version 85: reopening it re-adds the table, empty.'
  )
}
