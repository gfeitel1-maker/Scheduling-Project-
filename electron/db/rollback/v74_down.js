// Inverse of migration v74 (electron/db/localDb.js): drops the
// elective_run_outer_snapshots table and the two elective_assignment_runs
// columns (finalized_at, finalized_by) it added (T243,
// docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md).
// Follows the v71_down.js / v39_down.js convention: presence-checked,
// reporting a discarded count, idempotent.
//
// UNLIKE v66's rollback (which destroyed campers/elective_preferences/
// elective_assignments — real PII, unrecoverable from the projection): this
// rollback is NON-DESTRUCTIVE in the sense that matters. Nothing in this
// build writes finalized_at/finalized_by or elective_run_outer_snapshots yet
// (T244+ builds the write path), so there is no PII and no in-flight work a
// director has produced that this rollback could lose. The counts reported
// below exist for completeness and for a future build (once T244+ ships)
// where they would no longer be zero — read them, don't assume zero.
//
// Usage:  node electron/db/rollback/v74_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const countIfPresent = (db, table) =>
  hasTable(db, table) ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c : 0

export function rollbackV74(db) {
  // Count BEFORE destroying, so the report is honest about what went.
  const runCols = db.pragma('table_info(elective_assignment_runs)').map((c) => c.name)
  const discarded = {
    snapshots: countIfPresent(db, 'elective_run_outer_snapshots'),
    finalizedRuns: runCols.includes('finalized_at')
      ? db.prepare(
          "SELECT COUNT(*) c FROM elective_assignment_runs WHERE finalized_at IS NOT NULL OR finalized_by IS NOT NULL"
        ).get().c
      : 0,
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS elective_run_outer_snapshots')

    const runCols = () => db.pragma('table_info(elective_assignment_runs)').map((c) => c.name)
    // finalized_by first: it is the later column, and dropping in reverse
    // declaration order keeps the remaining column order stable.
    if (runCols().includes('finalized_by')) {
      db.exec('ALTER TABLE elective_assignment_runs DROP COLUMN finalized_by')
    }
    if (runCols().includes('finalized_at')) {
      db.exec('ALTER TABLE elective_assignment_runs DROP COLUMN finalized_at')
    }

    // `>= 74`, not `= 74` — this repo's convention since v46_down (see T220):
    // a bare equality strands any HIGHER version in the table, so rolling
    // back v74 on a database that has since migrated further leaves
    // getSchemaVersion() reporting the higher version while v74's table/
    // columns are gone — a shape no migration path can produce and none will
    // repair.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 74').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v74_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v74_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v74_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV74(db)
  db.close()
  console.log(
    `v74 rolled back: discarded ${result.snapshots} snapshot(s), ${result.finalizedRuns} finalized-run marker(s)`
  )
  console.log(
    'NOTE: this app build still declares schema version 74 — reopening it recreates the table and ' +
    'columns. UNLIKE v66, this is not a PII-loss event: nothing writes these fields yet (T244+).'
  )
}
