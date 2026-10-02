// Inverse of migration v90 (electron/db/localDb.js) — T331, docs/adr/
// 2026-10-02-distributed-revocation-authority.md.
//
//   1. `DROP TABLE applied_authority_log` and `DROP TABLE authority_cache`. v90 added two tables
//      and touched no existing one — same shape as v88_down (peer_last_addresses): nothing to
//      recreate-and-copy, no column to drop out of a CHECK.
//   2. No registry membership restored: neither table was ever added to PROJECTIONS,
//      MODELED_ENTITIES/GENESIS_ENTITIES, DIRECT_CAMP_ENTITIES, or any sync registry. Same ruling
//      as v88_down point 2.
//   3. THESE TABLES DO NOT REPLICATE AT ALL — both are device-local caches derived by replaying
//      the real `camp_authority_log` Automerge collection (electron/automerge/authorityReplay.js).
//      Dropping them loses nothing that cannot be recomputed: the next projection pass re-verifies
//      and re-replays the full collection from scratch and repopulates both tables, same
//      self-healing posture as v88_down point 3.
//
// Usage:  node electron/db/rollback/v90_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

import { assertHighestApplied } from './assertHighestApplied.js'

/**
 * @returns {{ok:true, discarded:{appliedAuthorityLog:number, authorityCache:number}}}
 */
export function rollbackV90(db) {
  const discarded = { appliedAuthorityLog: 0, authorityCache: 0 }

  if (hasTable(db, 'applied_authority_log')) {
    discarded.appliedAuthorityLog = db.prepare('SELECT COUNT(*) c FROM applied_authority_log').get().c
    db.exec('DROP TABLE applied_authority_log')
  }
  if (hasTable(db, 'authority_cache')) {
    discarded.authorityCache = db.prepare('SELECT COUNT(*) c FROM authority_cache').get().c
    db.exec('DROP TABLE authority_cache')
  }

  // `>= 90`, never `= 90` — a bare equality leaves any LATER migration row behind
  // (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 90').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v90_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v90_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v90_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 90)
  const result = rollbackV90(db)
  db.close()
  console.log(
    `v90 rolled back: dropped applied_authority_log (${result.discarded.appliedAuthorityLog} row(s)) ` +
    `and authority_cache (${result.discarded.authorityCache} row(s)). NOTE: neither table replicates ` +
    'at all; both are re-derived from the camp_authority_log document collection on the next ' +
    'projection pass. This app build still declares schema version 90: reopening it re-adds both ' +
    'tables, empty.'
  )
}
