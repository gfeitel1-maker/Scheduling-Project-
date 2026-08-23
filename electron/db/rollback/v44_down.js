// Inverse of migration v44 (electron/db/localDb.js): removes the
// recurrence_truth_status column added to activities — the truth-status ×
// binding-vector activity ontology, data-shape-only slice
// (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md §3.2/§3.5).
//
//   1. Drop the column via ALTER TABLE ... DROP COLUMN (supported by the
//      bundled SQLite version — same precedent as v43_down's
//      `ALTER TABLE elective_sets DROP COLUMN ...`).
//   2. No registry membership left dangling: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), syncClient.js, or
//      localClient.mock.js — those are separate, deliberate code changes a
//      schema-only rollback does not undo. A build still referencing this
//      column in the registries would throw on the next write (column
//      doesn't exist), the correct failure mode.
//   3. The column carries no backfill to undo (every existing activity keeps
//      NULL, i.e. not-yet-classified). The worst case of a rollback is
//      losing any truth-status value a director had already set; the full
//      op-log history survives in `operations` regardless.
//
// Usage:  node electron/db/rollback/v44_down.js <path-to-shoresh.sqlite>

export function rollbackV44(db) {
  const countOf = (column) =>
    db.pragma('table_info(activities)').some((c) => c.name === column)
      ? db.prepare(`SELECT COUNT(*) c FROM activities WHERE ${column} IS NOT NULL`).get().c
      : 0

  const discarded = {
    recurrenceTruthStatus: countOf('recurrence_truth_status'),
  }

  db.transaction(() => {
    const cols = db.pragma('table_info(activities)').map((c) => c.name)
    if (cols.includes('recurrence_truth_status')) {
      db.exec('ALTER TABLE activities DROP COLUMN recurrence_truth_status')
    }
    db.prepare('DELETE FROM schema_migrations WHERE version = 44').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v44_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v44_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v44_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV44(db)
  db.close()
  console.log(
    `v44 rolled back: ${result.recurrenceTruthStatus} activity(ies) with a recurrence truth status discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 44 — reopening it re-adds the column, empty. ' +
    'No data is at risk either way; the entities and their full history live untouched in `operations`.'
  )
}
