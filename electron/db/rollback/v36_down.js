// Inverse of migration v36 (electron/db/localDb.js): drops
// elective_sets.is_reusable, the T110 durability marker
// (docs/adr/2026-08-20-electives-authoring.md D2).
//
// A single ADD COLUMN, so the rollback is a single DROP COLUMN plus the
// schema_migrations row — no dependent structure to unwind (contrast v32,
// which had to repopulate a frozen anchor column first).
//
// DISCLOSED ROLLBACK LOSS: any tier-(a)/(b) designation a director had
// already recorded (is_reusable = 0) is discarded — every elective set reads
// as reusable again once the column is gone. The set rows themselves, their
// members, and their full op-log history are untouched.
//
// Usage:  node electron/db/rollback/v36_down.js <path-to-shoresh.sqlite>

export function rollbackV36(db) {
  const discarded = {
    electiveSets: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'elective_sets'").get()
      ? db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c
      : 0,
  }

  db.transaction(() => {
    const hasIsReusable = db
      .pragma('table_info(elective_sets)')
      .some((c) => c.name === 'is_reusable')
    if (hasIsReusable) db.exec('ALTER TABLE elective_sets DROP COLUMN is_reusable')

    db.prepare('DELETE FROM schema_migrations WHERE version = 36').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v36_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v36_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v36_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV36(db)
  db.close()
  console.log(
    `v36 rolled back: is_reusable dropped from ${result.electiveSets} elective set row(s)`
  )
  console.log(
    'NOTE: this app build still declares schema version 36 — reopening it recreates the ' +
    'is_reusable column (every row defaulting to reusable again). Any one-off/scoped marking a ' +
    'director had set is genuinely lost; the set rows and their full op-log history are not.'
  )
}
