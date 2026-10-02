// Inverse of migration v88 (electron/db/localDb.js) — T328 Slice 1, docs/adr/
// 2026-10-02-wan-discovery-transport-ladder.md, Slice 1.
//
//   1. `DROP TABLE peer_last_addresses`. v88 added a table and touched no existing one — same
//      shape as v86_down (peer_tombstone_reports): nothing to recreate-and-copy, no column to
//      drop out of a CHECK.
//   2. No registry membership restored: this table was never added to PROJECTIONS,
//      MODELED_ENTITIES/GENESIS_ENTITIES, DIRECT_CAMP_ENTITIES, TOMBSTONE_DENYLISTED_ENTITIES or
//      src/localClient.mock.js — it is off-document, device-local only, written only from the
//      authenticated sync handshake (syncNode.js's onPeerAdmitted). Same ruling as v86_down point 2.
//   3. THIS TABLE DOES NOT REPLICATE AT ALL — a dropped peer_last_addresses row has no
//      document-side copy to re-project from. It is gone until that peer's NEXT authenticated
//      connection, at which point it is remembered again. Same self-healing local-cache-clear
//      reasoning as v86_down point 3.
//   4. No back-fill to lose: v88's forward migration writes nothing into this table (a peer's
//      address can only be learned from a live authenticated connection), so there is no
//      data-loss consequence beyond "the cache is empty until the next reconnect" — losing it
//      only means the next startup falls through to discovery (mDNS/rendezvous) sooner, exactly
//      the pre-Slice-1 behavior.
//
// Usage:  node electron/db/rollback/v88_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

import { assertHighestApplied } from './assertHighestApplied.js'

/**
 * @returns {{ok:true, discarded:{addresses:number}}}
 */
export function rollbackV88(db) {
  const discarded = { addresses: 0 }

  if (hasTable(db, 'peer_last_addresses')) {
    discarded.addresses = db.prepare('SELECT COUNT(*) c FROM peer_last_addresses').get().c
    db.exec('DROP TABLE peer_last_addresses')
  }

  // `>= 88`, never `= 88` — a bare equality leaves any LATER migration row behind, so a database
  // rolled back from a future version would claim a version whose shape it no longer has
  // (bareEqualityRollback.guard.test.js).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 88').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v88_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v88_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v88_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 88)
  const result = rollbackV88(db)
  db.close()
  console.log(
    `v88 rolled back: dropped peer_last_addresses with ${result.discarded.addresses} row(s). ` +
    'NOTE: this table does NOT replicate at all; it is this device\'s own local cache of trusted ' +
    'peers\' last-observed addresses, re-populated the next time each peer completes an ' +
    'authenticated connection. This app build still declares schema version 88: reopening it ' +
    're-adds the table, empty.'
  )
}
