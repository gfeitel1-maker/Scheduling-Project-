// Inverse of migration v37 (electron/db/localDb.js): drops special_days.notes,
// the T106 record/print field (docs/adr/2026-08-20-special-days-authoring-
// and-day-override-repoint.md D2).
//
// A single ADD COLUMN, so the rollback is a single DROP COLUMN plus the
// schema_migrations row — no dependent structure to unwind (mirrors v36's
// rollback shape).
//
// DISCLOSED ROLLBACK LOSS: any notes text a director had already typed on a
// special day is discarded. The special_days rows themselves, their time
// blocks/slots, and their full op-log history are untouched.
//
// Usage:  node electron/db/rollback/v37_down.js <path-to-shoresh.sqlite>

export function rollbackV37(db) {
  const discarded = {
    specialDaysWithNotes: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'special_days'").get()
      ? db.prepare("SELECT COUNT(*) c FROM special_days WHERE notes IS NOT NULL AND notes != ''").get().c
      : 0,
  }

  db.transaction(() => {
    const hasNotes = db
      .pragma('table_info(special_days)')
      .some((c) => c.name === 'notes')
    if (hasNotes) db.exec('ALTER TABLE special_days DROP COLUMN notes')

    db.prepare('DELETE FROM schema_migrations WHERE version = 37').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v37_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v37_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v37_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV37(db)
  db.close()
  console.log(
    `v37 rolled back: notes dropped from ${result.specialDaysWithNotes} special day row(s) that had text`
  )
  console.log(
    'NOTE: this app build still declares schema version 37 — reopening it recreates the ' +
    'notes column (NULL). Any recorded text a director had typed is genuinely lost; the ' +
    'special_days rows and their full op-log history are not.'
  )
}
