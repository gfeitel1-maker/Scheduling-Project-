// Inverse of migration v71 (electron/db/localDb.js): re-adds the
// `recurrence_level` column, DROPped from `anchor_activities` and
// `elective_sets` (T181 — dead data, superseded by `kind`, `day_id`, and
// `schedule_week_id`; docs/work/tickets/T181-recurrence-level-is-dead-data.md).
//
//   1. Re-add both columns via `ALTER TABLE ... ADD COLUMN recurrence_level
//      TEXT NOT NULL DEFAULT 'daily'` — the same shape the column had before
//      v71 removed it. No table rebuild needed either direction: the column
//      sat in no index and no CHECK constraint.
//   2. This restores the column at its DEFAULT only — there is no prior
//      non-default value to lose. That is a structural guarantee, not a
//      query result: the T181 sweep that justified removal established that
//      no application code path ever wrote anything but the schema default
//      to this column on either table, so there is nothing a `COUNT(*)
//      WHERE recurrence_level != 'daily'` could have found even if the
//      column still existed to query.
//   3. No registry membership restored: this script does not touch
//      projections.js or localClient.mock.js — those are separate,
//      deliberate code changes a schema-only rollback does not undo. A
//      build still running the v71 code (which no longer references the
//      column) simply never writes to it; nothing throws.
//
// Usage:  node electron/db/rollback/v71_down.js <path-to-shoresh.sqlite>

export function rollbackV71(db) {
  db.transaction(() => {
    const anchorCols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    if (!anchorCols.includes('recurrence_level')) {
      db.exec("ALTER TABLE anchor_activities ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'")
    }
    const electiveCols = db.pragma('table_info(elective_sets)').map((c) => c.name)
    if (!electiveCols.includes('recurrence_level')) {
      db.exec("ALTER TABLE elective_sets ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'")
    }
    // `>= 71`, not `= 71` — a bare equality strands any HIGHER version in the
    // table, so rolling back v71 on a database that has since migrated
    // further leaves getSchemaVersion() reporting the higher version while
    // v71's column is back — a shape no migration path can produce and none
    // will repair. Convention since v46_down (see T220).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 71').run()
  })()

  return { recreated: ['anchor_activities.recurrence_level', 'elective_sets.recurrence_level'] }
}

// Direct invocation (node electron/db/rollback/v71_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v71_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v71_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV71(db)
  db.close()
  console.log(`v71 rolled back: recreated ${result.recreated.join(', ')}`)
  console.log(
    'NOTE: recurrence_level comes back at its DEFAULT (\'daily\') on every row — no prior ' +
    'non-default value ever existed to restore (structural guarantee, not a query result: no ' +
    'code path in this repo ever wrote anything but the default, which is exactly why v71 ' +
    'removed it). This app build still declares schema version 71 — reopening it re-drops the ' +
    'column.'
  )
}
