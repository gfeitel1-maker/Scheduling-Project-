// Inverse of migration v93 (electron/db/localDb.js) - T348, docs/adr/2026-10-08-relayless-cross-
// network-reconnect.md (Rung 1).
//
//   1. `DROP TABLE punch_identity` and `DROP TABLE peer_punch_memory`. v93 added two tables and
//      touched no existing one - nothing to recreate-and-copy.
//   2. No registry membership restored: neither table was ever added to PROJECTIONS,
//      MODELED_ENTITIES/GENESIS_ENTITIES, DIRECT_CAMP_ENTITIES, or any sync registry.
//   3. DATA LOSS, stated plainly: `punch_identity` holds this device's DTLS cert/key and pinned port.
//      Dropping it means the device mints a NEW punch identity on next use, and every peer's
//      remembered session for this device goes stale (their zero-signaling redial times out and
//      falls to a signaled rung). Nothing here replicates; peer_punch_memory is re-learned from the
//      next punched session.
//
// Usage:  node electron/db/rollback/v93_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

import { assertHighestApplied } from './assertHighestApplied.js'

/**
 * @returns {{ok:true, discarded:{punchIdentity:number, peerPunchMemory:number}}}
 */
export function rollbackV93(db) {
  const discarded = { punchIdentity: 0, peerPunchMemory: 0 }

  if (hasTable(db, 'punch_identity')) {
    discarded.punchIdentity = db.prepare('SELECT COUNT(*) c FROM punch_identity').get().c
    db.exec('DROP TABLE punch_identity')
  }
  if (hasTable(db, 'peer_punch_memory')) {
    discarded.peerPunchMemory = db.prepare('SELECT COUNT(*) c FROM peer_punch_memory').get().c
    db.exec('DROP TABLE peer_punch_memory')
  }

  // `>= 93`, never `= 91` - a bare equality leaves any LATER migration row behind
  // (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 93').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v93_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v93_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v93_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 93)
  const result = rollbackV93(db)
  db.close()
  console.log(
    `v93 rolled back: dropped punch_identity (${result.discarded.punchIdentity} row(s)) and ` +
    `peer_punch_memory (${result.discarded.peerPunchMemory} row(s)). NOTE: this device's punch ` +
    'identity is gone, so peers\' remembered sessions for it go stale; both tables are re-learned. ' +
    'This app build still declares schema version 93: reopening it re-adds both tables, empty.'
  )
}
