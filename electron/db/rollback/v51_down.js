// Inverse of migration v51 (electron/db/localDb.js): removes
// anchor_activities.kind and its CHECK constraint (the Fixed vs Recurring
// classification, docs/adr/2026-08-28-fixed-vs-recurring-events.md §5).
//
//   1. Recreate the table without `kind` or either CHECK, same
//      recreate-and-copy shape v51 itself used (not v42_down's bare
//      `ALTER TABLE ... DROP COLUMN`): SQLite refuses to DROP COLUMN a
//      column referenced by a table-level CHECK constraint, regardless of
//      bundled SQLite version — confirmed empirically while writing this
//      rollback (v51's cross-column CHECK references `kind` alongside the
//      scope columns, exactly the case ALTER TABLE DROP COLUMN rejects).
//   2. No registry membership left dangling: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), syncClient.js, or
//      localClient.mock.js — those are separate, deliberate code changes a
//      schema-only rollback does not undo. A build still referencing `kind`
//      in those registries would throw on the next write (column doesn't
//      exist), the correct failure mode.
//   3. `kind` was backfilled deterministically from is_all_groups/unit_id/
//      group_ids (no new fact, no director-authored data) — dropping it
//      loses nothing that isn't trivially re-derivable by re-running v51.
//      The full op-log history survives in `operations` regardless.
//
// Usage:  node electron/db/rollback/v51_down.js <path-to-shoresh.sqlite>

export function rollbackV51(db) {
  const discarded = db.pragma('table_info(anchor_activities)').some((c) => c.name === 'kind')
    ? db.prepare("SELECT COUNT(*) c FROM anchor_activities WHERE kind = 'recurring'").get().c
    : 0

  db.transaction(() => {
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    if (cols.includes('kind')) {
      db.pragma('foreign_keys = OFF')
      db.exec(`
        CREATE TABLE anchor_activities_v51down (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          cohort_id TEXT REFERENCES cohorts(id),
          day_id TEXT REFERENCES days_of_operation(id),
          time_block_id TEXT,
          name TEXT,
          unit_id TEXT,
          span_blocks INTEGER,
          is_all_groups INTEGER,
          group_ids TEXT,
          notes TEXT,
          schedule_week_id TEXT REFERENCES schedule_weeks(id),
          recurrence_level TEXT NOT NULL DEFAULT 'daily',
          location_id TEXT
        );
        INSERT INTO anchor_activities_v51down
          SELECT id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks,
                 is_all_groups, group_ids, notes, schedule_week_id, recurrence_level, location_id
          FROM anchor_activities;
        DROP TABLE anchor_activities;
        ALTER TABLE anchor_activities_v51down RENAME TO anchor_activities;
      `)
      db.pragma('foreign_keys = ON')
    }
    db.prepare('DELETE FROM schema_migrations WHERE version = 51').run()
  })()

  return { recurringDiscarded: discarded }
}

// Direct invocation (node electron/db/rollback/v51_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v51_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v51_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV51(db)
  db.close()
  console.log(
    `v51 rolled back: ${result.recurringDiscarded} anchor(s) with kind='recurring' lost their classification`
  )
  console.log(
    'NOTE: this app build still declares schema version 51 — reopening it re-adds the column, ' +
    'deterministically re-backfilled from is_all_groups/unit_id/group_ids. No data is at risk either way; ' +
    'the entities and their full history live untouched in `operations`.'
  )
}
