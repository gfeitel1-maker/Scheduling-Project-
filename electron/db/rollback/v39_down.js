// Inverse of migration v39 (electron/db/localDb.js): drops
// elective_set_activities.camper_headcount — the Electives Slice 1 capacity
// column (docs/adr/2026-08-22-nested-schedules-electives-and-events.md §2,
// docs/work/specs/2026-08-22-electives-nested-schedule-slices.md Slice 1).
//
// One additive column, so the rollback is a single ALTER-column DROP plus
// the schema_migrations row — mirrors v37's specialDays.notes rollback.
//
// DISCLOSED ROLLBACK LOSS: every offering's authored capacity is discarded.
// The elective_sets/elective_set_activities rows themselves, and the full
// op-log history for everything else, are untouched.
//
// Usage:  node electron/db/rollback/v39_down.js <path-to-shoresh.sqlite>

export function rollbackV39(db) {
  const discarded = {
    offeringsWithCapacity: db
      .pragma('table_info(elective_set_activities)')
      .some((c) => c.name === 'camper_headcount')
      ? db.prepare(
          'SELECT COUNT(*) c FROM elective_set_activities WHERE camper_headcount IS NOT NULL'
        ).get().c
      : 0,
  }

  db.transaction(() => {
    const hasCamperHeadcount = db
      .pragma('table_info(elective_set_activities)')
      .some((c) => c.name === 'camper_headcount')
    if (hasCamperHeadcount) {
      db.exec('ALTER TABLE elective_set_activities DROP COLUMN camper_headcount')
    }

    db.prepare('DELETE FROM schema_migrations WHERE version = 39').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v39_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v39_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v39_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV39(db)
  db.close()
  console.log(
    `v39 rolled back: capacity discarded from ${result.offeringsWithCapacity} elective offering(s)`
  )
  console.log(
    'NOTE: this app build still declares schema version 39 — reopening it recreates the ' +
    'camper_headcount column (NULL). Genuinely lost either way: any capacity a director had ' +
    'authored. Everything else survives.'
  )
}
