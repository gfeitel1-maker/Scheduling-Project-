// Inverse of migration v34 (electron/db/localDb.js): drops special_day_slots,
// special_day_time_blocks, and special_days — the T40 slice 1 data shape
// (docs/work/specs/2026-08-20-special-days-data-shape-design.md).
//
// Dropping the tables IS the whole rollback, same demonstration v30_down/
// v31_down give for their own tables:
//   - Children before parent (special_day_slots and special_day_time_blocks
//     both REFERENCES special_days(id)) — matching the FK order the v34
//     migration itself creates them in, reversed.
//   - No registry membership left dangling: this script does not touch
//     PROJECTIONS (electron/ops/projections.js), campScopedEntities.js, or
//     permissions.js — those are separate, deliberate code changes a rollback
//     of the schema alone does not undo. A rolled-back-schema build that
//     still references these entities in the registries would throw on the
//     next write (table doesn't exist), which is the correct failure mode.
//   - No backfill to undo: v34 had none (every camp starts with zero special
//     days), so the worst case on drop is losing any special days a director
//     had already created — their full op-log history survives in
//     `operations` regardless.
//
// Usage:  node electron/db/rollback/v34_down.js <path-to-shoresh.sqlite>

export function rollbackV34(db) {
  const countOf = (table) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
      : 0

  const discarded = {
    specialDaySlots: countOf('special_day_slots'),
    specialDayTimeBlocks: countOf('special_day_time_blocks'),
    specialDays: countOf('special_days'),
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS special_day_slots')
    db.exec('DROP TABLE IF EXISTS special_day_time_blocks')
    db.exec('DROP TABLE IF EXISTS special_days')
    db.prepare('DELETE FROM schema_migrations WHERE version = 34').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v34_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v34_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v34_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV34(db)
  db.close()
  console.log(
    `v34 rolled back: ${result.specialDays} special day(s), ${result.specialDayTimeBlocks} time block(s), ` +
    `${result.specialDaySlots} slot(s) discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 34 — reopening it recreates the three tables ' +
    'empty. No data is at risk either way; the entities and their full history live untouched in `operations`.'
  )
}
