// Inverse of migration v86 (electron/db/localDb.js) — T322 S3a, docs/adr/
// 2026-09-19-multi-device-erasure-propagation.md's "Addendum (2026-10-01,
// Architect, T322 S3a)".
//
//   1. `DROP TABLE peer_tombstone_reports`. v86 added a table and touched no
//      existing one — same shape as v85_down (camper_identity_keys): nothing
//      to recreate-and-copy, no column to drop out of a CHECK.
//   2. No registry membership restored: this table was never added to
//      PROJECTIONS, MODELED_ENTITIES/GENESIS_ENTITIES, DIRECT_CAMP_ENTITIES,
//      TOMBSTONE_DENYLISTED_ENTITIES or src/localClient.mock.js in the first
//      place — it is off-document, local-only, written only from the
//      authenticated sync handshake. Same ruling as v82_down point 3 /
//      v83_down point 3 / v85_down point 3.
//   3. THIS TABLE DOES NOT REPLICATE AT ALL — unlike v85's
//      camper_identity_keys (which re-arrives from a peer via the document),
//      a dropped peer_tombstone_reports row has no document-side copy to
//      re-project from. It is gone until that peer's NEXT `authenticate`
//      handshake, at which point it self-reports again and the row comes
//      back. So this rollback is a genuinely harmless, self-healing local
//      cache clear — not even a "local un-projection of replicated state"
//      the way v85_down's point 4 describes for camper_identity_keys.
//   4. No back-fill to lose: v86's forward migration writes nothing into
//      this table (a peer's applied-tombstone set can only be learned from
//      that peer's own self-report), so there is no data-loss consequence
//      to state beyond "the cache is empty until the next handshake."
//
// Usage:  node electron/db/rollback/v86_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{reports:number}}}
 */
import { assertHighestApplied } from './assertHighestApplied.js'

export function rollbackV86(db) {
  const discarded = { reports: 0 }

  if (hasTable(db, 'peer_tombstone_reports')) {
    discarded.reports = db.prepare('SELECT COUNT(*) c FROM peer_tombstone_reports').get().c
    db.exec('DROP TABLE peer_tombstone_reports')
  }

  // `>= 86`, never `= 86` — a bare equality leaves any LATER migration row
  // behind, so a database rolled back from a future version would claim a
  // version whose shape it no longer has (bareEqualityRollback.guard.test.js).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 86').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v86_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v86_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v86_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 86)
  const result = rollbackV86(db)
  db.close()
  console.log(
    `v86 rolled back: dropped peer_tombstone_reports with ${result.discarded.reports} row(s). ` +
    'NOTE: this table does NOT replicate at all; it is this device\'s own local cache of peers\' ' +
    'self-reports, re-populated the next time each peer completes an authenticate handshake. ' +
    'This app build still declares schema version 86: reopening it re-adds the table, empty.'
  )
}
