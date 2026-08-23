// Inverse of migration v42 (electron/db/localDb.js): removes
// anchor_activities.schedule_week_id and anchor_activities.recurrence_level —
// the unified-schedule-overlay Slice 1 recurrence-axis storage
// (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md).
//
//   1. Drop both columns via ALTER TABLE ... DROP COLUMN (supported by the
//      bundled SQLite version — same precedent as v35_down's
//      `ALTER TABLE template_slots DROP COLUMN elective_set_id`).
//   2. No registry membership left dangling: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), syncClient.js, or
//      localClient.mock.js — those are separate, deliberate code changes a
//      schema-only rollback does not undo. A build still referencing these
//      columns in the registries would throw on the next write (column
//      doesn't exist), the correct failure mode.
//   3. schedule_week_id has no backfill to undo (every existing anchor keeps
//      NULL, preserving today's implicit all-weeks meaning). recurrence_level
//      DOES carry a DEFAULT ('daily'), so every existing anchor reads
//      'daily' after v42 — dropping the column loses that label along with
//      any explicit recurrence level a director had already set. Either way
//      the worst case is losing a week-binding or recurrence level; the full
//      op-log history survives in `operations` regardless.
//
// Usage:  node electron/db/rollback/v42_down.js <path-to-shoresh.sqlite>

export function rollbackV42(db) {
  const countOf = (column) =>
    db.pragma('table_info(anchor_activities)').some((c) => c.name === column)
      ? db.prepare(`SELECT COUNT(*) c FROM anchor_activities WHERE ${column} IS NOT NULL`).get().c
      : 0

  const discarded = {
    scheduleWeekId: countOf('schedule_week_id'),
    recurrenceLevel: countOf('recurrence_level'),
  }

  db.transaction(() => {
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    if (cols.includes('schedule_week_id')) {
      db.exec('ALTER TABLE anchor_activities DROP COLUMN schedule_week_id')
    }
    if (cols.includes('recurrence_level')) {
      db.exec('ALTER TABLE anchor_activities DROP COLUMN recurrence_level')
    }
    db.prepare('DELETE FROM schema_migrations WHERE version = 42').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v42_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v42_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v42_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV42(db)
  db.close()
  console.log(
    `v42 rolled back: ${result.scheduleWeekId} anchor(s) with a week binding, ` +
    `${result.recurrenceLevel} anchor(s) with a recurrence level discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 42 — reopening it re-adds both columns, ' +
    'empty. No data is at risk either way; the entities and their full history live untouched in `operations`.'
  )
}
