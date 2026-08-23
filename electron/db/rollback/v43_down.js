// Inverse of migration v43 (electron/db/localDb.js): removes the six
// recurring-event binding columns added to elective_sets — day_id,
// time_block_id, is_all_groups, group_ids, schedule_week_id,
// recurrence_level — the unified-schedule-overlay Slice 3a storage shape
// (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md).
//
//   1. Drop all six columns via ALTER TABLE ... DROP COLUMN (supported by the
//      bundled SQLite version — same precedent as v42_down's
//      `ALTER TABLE anchor_activities DROP COLUMN schedule_week_id`).
//   2. No registry membership left dangling: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), syncClient.js, or
//      localClient.mock.js — those are separate, deliberate code changes a
//      schema-only rollback does not undo. A build still referencing these
//      columns in the registries would throw on the next write (column
//      doesn't exist), the correct failure mode.
//   3. None of the five nullable columns carry any backfill to undo (every
//      existing elective_set keeps NULL, preserving today's implicit
//      unbound meaning). recurrence_level DOES carry a DEFAULT ('daily'), so
//      every existing set reads 'daily' after v43 — dropping the column
//      loses that label along with any explicit recurrence level a director
//      had already set. Either way the worst case is losing a binding or
//      recurrence level; the full op-log history survives in `operations`
//      regardless.
//
// Usage:  node electron/db/rollback/v43_down.js <path-to-shoresh.sqlite>

export function rollbackV43(db) {
  const countOf = (column) =>
    db.pragma('table_info(elective_sets)').some((c) => c.name === column)
      ? db.prepare(`SELECT COUNT(*) c FROM elective_sets WHERE ${column} IS NOT NULL`).get().c
      : 0

  const discarded = {
    dayId: countOf('day_id'),
    timeBlockId: countOf('time_block_id'),
    isAllGroups: countOf('is_all_groups'),
    groupIds: countOf('group_ids'),
    scheduleWeekId: countOf('schedule_week_id'),
    recurrenceLevel: countOf('recurrence_level'),
  }

  db.transaction(() => {
    const cols = db.pragma('table_info(elective_sets)').map((c) => c.name)
    for (const column of ['day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id', 'recurrence_level']) {
      if (cols.includes(column)) {
        db.exec(`ALTER TABLE elective_sets DROP COLUMN ${column}`)
      }
    }
    db.prepare('DELETE FROM schema_migrations WHERE version = 43').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v43_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v43_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v43_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV43(db)
  db.close()
  console.log(
    `v43 rolled back: ${result.dayId} elective set(s) with a day binding, ` +
    `${result.timeBlockId} with a time-block binding, ${result.isAllGroups} with an is_all_groups value, ` +
    `${result.groupIds} with a group_ids value, ${result.scheduleWeekId} with a week binding, ` +
    `${result.recurrenceLevel} with a recurrence level discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 43 — reopening it re-adds all six columns, ' +
    'empty. No data is at risk either way; the entities and their full history live untouched in `operations`.'
  )
}
