// Inverse of migration v89 (electron/db/localDb.js) — T328 Slice 1 correction pass, docs/adr/
// 2026-10-02-wan-discovery-transport-ladder.md.
//
//   1. Collapses peer_last_addresses from v89's composite PRIMARY KEY(peer_id, multiaddr) shape
//      back to v88's PRIMARY KEY(peer_id) shape, recreate-and-copy (same reasoning as the
//      forward migration: no FK references this table).
//   2. DATA LOSS, stated plainly: a peer with more than one remembered address keeps only its
//      MOST RECENT (by last_seen_at) — the rest are discarded, same as any other column/shape
//      narrowing rollback. Recoverable by observation, not by restore: the next time a dropped
//      address's peer completes an authenticated connection, it is remembered again (this table
//      never replicates at all — see v88_down.js point 3 for the identical reasoning).
//   3. No registry membership restored: unchanged from v88_down — never added to PROJECTIONS,
//      MODELED_ENTITIES, DIRECT_CAMP_ENTITIES, or any sync registry.
//
// Usage:  node electron/db/rollback/v89_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const isComposite = (db) =>
  hasTable(db, 'peer_last_addresses') &&
  db.pragma('table_info(peer_last_addresses)').filter((c) => c.pk > 0).length === 2

import { assertHighestApplied } from './assertHighestApplied.js'

/**
 * @returns {{ok:true, discarded:{addresses:number}}}
 */
export function rollbackV89(db) {
  const discarded = { addresses: 0 }

  if (isComposite(db)) {
    const totalBefore = db.prepare('SELECT COUNT(*) c FROM peer_last_addresses').get().c

    db.exec(`
      CREATE TABLE peer_last_addresses_v88 (
        peer_id TEXT PRIMARY KEY,
        multiaddr TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      INSERT INTO peer_last_addresses_v88 (peer_id, multiaddr, last_seen_at)
        SELECT peer_id, multiaddr, last_seen_at FROM peer_last_addresses p
        WHERE p.last_seen_at = (
          SELECT MAX(p2.last_seen_at) FROM peer_last_addresses p2 WHERE p2.peer_id = p.peer_id
        )
        GROUP BY peer_id;
      DROP TABLE peer_last_addresses;
      ALTER TABLE peer_last_addresses_v88 RENAME TO peer_last_addresses;
    `)

    const totalAfter = db.prepare('SELECT COUNT(*) c FROM peer_last_addresses').get().c
    discarded.addresses = totalBefore - totalAfter
  }

  // `>= 89`, never `= 89` — a bare equality leaves any LATER migration row behind
  // (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 89').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v89_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v89_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v89_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 89)
  const result = rollbackV89(db)
  db.close()
  console.log(
    `v89 rolled back: peer_last_addresses collapsed to one row per peer, discarding ` +
    `${result.discarded.addresses} older address(es). NOTE: this table does NOT replicate at ` +
    'all; a discarded address is re-learned the next time that peer completes an authenticated ' +
    'connection. This app build still declares schema version 89: reopening it re-widens the ' +
    'table to the composite-key shape.'
  )
}
