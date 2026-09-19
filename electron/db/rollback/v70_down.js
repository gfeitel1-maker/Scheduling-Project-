// Inverse of migration v70 (electron/db/localDb.js): drops the
// UNIQUE(camp_id, day_of_week) index and the domain_state_migration_pending
// table it created.
//
// DISCLOSED ROLLBACK LOSS, same shape as v69_down.js's disposable-counter
// disclosure but more consequential here: v70 DEDUPES rows — it deletes
// duplicate/orphaned days_of_operation rows and repoints their referencers
// (template_slots/anchor_activities/elective_sets/elective_occurrences.day_id)
// onto the surviving row. None of that is reversible from this file alone —
// there is no journal of which rows were deleted or which referencers were
// repointed (unlike v24_down.js's migration_v24_repoint_log). Rolling back
// v70 restores the ABILITY to create duplicate weekday rows again; it does
// NOT resurrect any row v70 deleted, nor un-repoint any referencer v70 moved.
// That data is gone from SQLite for good — the Automerge document (if this
// db has one) is the only place that history could still exist.
//
// Usage:  node electron/db/rollback/v70_down.js <path-to-shoresh.sqlite>

export function rollbackV70(db) {
  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_days_of_operation_camp_day')
    db.prepare('DELETE FROM domain_state_migration_pending WHERE version = 70').run()

    // `>= 70`, not `= 70` — a bare equality strands any HIGHER version in the
    // table (T220 convention, electron/db/rollback/bareEqualityRollback.guard.test.js).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 70').run()
  })()
}

// Direct invocation (node electron/db/rollback/v70_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v70_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v70_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  rollbackV70(db)
  db.close()
  console.log(
    'v70 rolled back: UNIQUE(camp_id, day_of_week) index dropped. Deduped rows and repointed ' +
    'referencers were NOT restored — see this file\'s header comment.'
  )
}
