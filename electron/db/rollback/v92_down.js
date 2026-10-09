// Inverse of migration v92 (electron/db/localDb.js) — T350, docs/adr/
// 2026-10-09-special-day-binds-to-a-week-day.md D3.
//
//   1. `DROP TABLE special_day_placements`. v92 added one table and touched no existing one, so
//      the rollback is lossless for every other table.
//   2. LOSES ONLY BINDINGS: which special day replaced which (week, day). The special days, their
//      grids, the weeks and every template slot survive untouched.
//   3. The table's registry entries (PROJECTIONS, PARENT_SCOPED_ENTITIES, GENESIS_ENTITIES, ...)
//      live in code, not in the database; rolling the code back removes them.
//
// Usage:  node electron/db/rollback/v92_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{specialDayPlacements:number}}}
 */
export function rollbackV92(db) {
  const discarded = { specialDayPlacements: 0 }

  if (hasTable(db, 'special_day_placements')) {
    discarded.specialDayPlacements = db.prepare('SELECT COUNT(*) c FROM special_day_placements').get().c
    db.exec('DROP TABLE special_day_placements')
  }

  // `>= 92`, never `= 92` (bareEqualityRollback.guard.test.js's class).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 92').run()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v92_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v92_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 92)
  const result = rollbackV92(db)
  db.close()
  console.log(
    `v92 rolled back: dropped special_day_placements (${result.discarded.specialDayPlacements} binding(s) lost).`
  )
}
