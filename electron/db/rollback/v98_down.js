// Inverse of migration v98 (electron/db/localDb.js) — UX audit A1.
//
//   1. `ALTER TABLE open_reconciliation_decisions DROP COLUMN payload`. v98 added one nullable column to a
//      device-local, never-synced table and touched nothing else, so the rollback is lossless elsewhere.
//   2. DATA LOSS: each held-back event question loses the event it carries. The question itself stays and
//      can still be dismissed; it can no longer be answered with "Add for all groups".
//
// Usage:  node electron/db/rollback/v98_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const hasColumn = (db, table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)

/**
 * @returns {{ok:true, discarded:{payloads:number}}}
 */
export function rollbackV98(db) {
  const discarded = { payloads: 0 }

  if (hasColumn(db, 'open_reconciliation_decisions', 'payload')) {
    discarded.payloads = db.prepare('SELECT COUNT(*) c FROM open_reconciliation_decisions WHERE payload IS NOT NULL').get().c
    db.exec('ALTER TABLE open_reconciliation_decisions DROP COLUMN payload')
  }

  // `>= 98`, never `= 98` (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 98').run()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v98_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v98_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 98)
  const result = rollbackV98(db)
  db.close()
  console.log(
    `v98 rolled back: dropped open_reconciliation_decisions.payload (${result.discarded.payloads} held-back event(s) lost; the questions remain). ` +
    'This app build still declares schema version 98: reopening it re-adds the column empty.'
  )
}
