// Inverse of migration v94 (electron/db/localDb.js) — docs/adr/2026-10-09-host-succession-simple.md.
//
//   1. `DROP TABLE host_handoff` and `DROP TABLE host_signing_key_pending`. v94 added two device-local
//      tables and touched no existing one, so the rollback is lossless for every other table.
//   2. LOSES ONLY an in-flight handoff's state and, if the successor had received the key but not yet
//      seen COMMIT, the PENDING key. Roll back only with no handoff in flight: a successor that rolls
//      back while holding a pending key loses its only copy if the giver had already committed.
//   3. host_signing_key itself is never touched.
//
// Usage:  node electron/db/rollback/v94_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{handoffRows:number, pendingKeys:number}}}
 */
export function rollbackV94(db) {
  const discarded = { handoffRows: 0, pendingKeys: 0 }

  if (hasTable(db, 'host_handoff')) {
    discarded.handoffRows = db.prepare('SELECT COUNT(*) c FROM host_handoff').get().c
    db.exec('DROP TABLE host_handoff')
  }
  if (hasTable(db, 'host_signing_key_pending')) {
    discarded.pendingKeys = db.prepare('SELECT COUNT(*) c FROM host_signing_key_pending').get().c
    db.exec('DROP TABLE host_signing_key_pending')
  }

  // `>= 94`, never `= 94` (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 94').run()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v94_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v94_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 94)
  const result = rollbackV94(db)
  db.close()
  console.log(
    `v94 rolled back: dropped host_handoff (${result.discarded.handoffRows} row) and host_signing_key_pending (${result.discarded.pendingKeys} pending key).`
  )
}
