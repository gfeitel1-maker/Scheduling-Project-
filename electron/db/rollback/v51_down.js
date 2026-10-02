// Inverse of migration v51 (electron/db/localDb.js): removes
// anchor_activities.kind and its CHECK constraint (the Fixed vs Recurring
// classification, docs/adr/2026-08-28-fixed-vs-recurring-events.md §5).
//
//   1. Recreate the table without `kind` or either CHECK, via the shared
//      rebuildTableCarryingColumns helper (same recreate-and-copy shape v51
//      itself used, not v42_down's bare `ALTER TABLE ... DROP COLUMN`):
//      SQLite refuses to DROP COLUMN a column referenced by a table-level
//      CHECK constraint, regardless of bundled SQLite version — confirmed
//      empirically while writing this rollback (v51's cross-column CHECK
//      references `kind` alongside the scope columns, exactly the case
//      ALTER TABLE DROP COLUMN rejects). The helper rebuilds from the LIVE
//      column set with `kind` named in `exclude`, so any column a migration
//      AFTER v51 added (e.g. recurrence_level, or one not yet imagined) is
//      carried forward with its data instead of silently dropped — the same
//      defect class fixed on the v73 rollback path (#721, commit
//      73574fae; docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md).
//   2. No registry membership left dangling: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), campDocument.js, or
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

import { rebuildTableCarryingColumns } from '../rebuildTableCarryingColumns.js'
import { assertHighestApplied } from './assertHighestApplied.js'

export function rollbackV51(db) {
  const discarded = db.pragma('table_info(anchor_activities)').some((c) => c.name === 'kind')
    ? db.prepare("SELECT COUNT(*) c FROM anchor_activities WHERE kind = 'recurring'").get().c
    : 0

  // PRAGMA foreign_keys is a genuine no-op while a transaction is open — toggle BEFORE
  // db.transaction() opens its BEGIN, not inside the callback (v73_down.js's pattern).
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
      if (cols.includes('kind')) {
        // baseColumns is v51's own shape MINUS `kind` (the whole point of this rollback) and
        // minus recurrence_level — recurrence_level (T181/v71) and any column a migration after
        // v51 added are both detected from live table_info and carried forward with their data
        // by the helper, whether or not they exist on this particular db.
        rebuildTableCarryingColumns(db, {
          table: 'anchor_activities',
          baseColumns: [
            'id TEXT PRIMARY KEY',
            'camp_id TEXT NOT NULL REFERENCES camps(id)',
            'cohort_id TEXT REFERENCES cohorts(id)',
            'day_id TEXT REFERENCES days_of_operation(id)',
            'time_block_id TEXT',
            'name TEXT',
            'unit_id TEXT',
            'span_blocks INTEGER',
            'is_all_groups INTEGER',
            'group_ids TEXT',
            'notes TEXT',
            'schedule_week_id TEXT REFERENCES schedule_weeks(id)',
            'location_id TEXT',
          ],
          tableConstraints: [],
          postIndexSql: [],
          exclude: ['kind'],
        })
      }
      // `>= 51`, not `= 51`. A bare equality strands any HIGHER version in the
      // table, so rolling back v51 on a database that has since migrated further
      // leaves getSchemaVersion() reporting the higher version while v51's tables
      // are gone — a shape no migration path can produce and none will repair.
      // Convention since v46_down (see T220).
      db.prepare('DELETE FROM schema_migrations WHERE version >= 51').run()
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }

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
  assertHighestApplied(db, 51)
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
