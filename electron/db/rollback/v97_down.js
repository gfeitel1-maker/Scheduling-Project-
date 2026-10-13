// Inverse of migration v97 (electron/db/localDb.js) — the persistent "Undo last import" record.
//
//   1. `DROP TABLE last_import_undo`. v97 added one device-local table and touched no existing table, so
//      the rollback is lossless for every other table.
//   2. DATA LOSS: the stored undo record of the last import, so that import can no longer be undone from
//      Roots. The import itself and everything it wrote are untouched. An older build kept the record in
//      memory only, which is the behaviour it returns to.
//
// Usage:  node electron/db/rollback/v97_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{undoRows:number}}}
 */
export function rollbackV97(db) {
  const discarded = { undoRows: 0 }

  if (hasTable(db, 'last_import_undo')) {
    discarded.undoRows = db.prepare('SELECT COUNT(*) c FROM last_import_undo').get().c
    db.exec('DROP TABLE last_import_undo')
  }

  // `>= 97`, never `= 97` (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 97').run()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v97_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v97_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 97)
  const result = rollbackV97(db)
  db.close()
  console.log(
    `v97 rolled back: dropped last_import_undo (${result.discarded.undoRows} row(s); that import can no longer be undone from Roots). ` +
    'This app build still declares schema version 97: reopening it recreates the table empty.'
  )
}
