// Inverse of migration v96 (electron/db/localDb.js) — T376, docs/adr/2026-10-12-shared-signed-device-roster.md.
//
//   1. `DROP TABLE roster_cache`. v96 added one device-local cache and touched no existing table, so the
//      rollback is lossless for every other table.
//   2. DATA LOSS: none that matters. The cache is a derivation of the signed `device_roster` collection in
//      the Automerge document, which a rollback does not touch; a build that still declares v96 re-derives
//      it from the document on the next projection. An older build has no roster and admits by token.
//
// Usage:  node electron/db/rollback/v96_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{rosterRows:number}}}
 */
export function rollbackV96(db) {
  const discarded = { rosterRows: 0 }

  if (hasTable(db, 'roster_cache')) {
    discarded.rosterRows = db.prepare('SELECT COUNT(*) c FROM roster_cache').get().c
    db.exec('DROP TABLE roster_cache')
  }

  // `>= 96`, never `= 96` (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 96').run()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v96_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v96_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 96)
  const result = rollbackV96(db)
  db.close()
  console.log(
    `v96 rolled back: dropped roster_cache (${result.discarded.rosterRows} row(s), re-derived from the document). ` +
    'This app build still declares schema version 96: reopening it recreates the table empty.'
  )
}
