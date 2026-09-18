// Inverse of migration v68 (electron/db/localDb.js): drops
// elective_set_activities.status — the T195 offering-grid import's
// potential/confirmed column.
//
// One additive column, so the rollback is a single ALTER-column DROP plus
// the schema_migrations row — mirrors v39_down.js's camper_headcount
// rollback.
//
// DISCLOSED ROLLBACK LOSS: every row's potential/confirmed distinction is
// discarded. A director who had NOT yet confirmed a potential offering loses
// that signal from the projection — the row itself, and every other column
// on it, is untouched. Recoverable in principle from the op-log and the
// Automerge document, neither of which a rollback touches.
//
// Usage:  node electron/db/rollback/v68_down.js <path-to-shoresh.sqlite>

export function rollbackV68(db) {
  const discarded = {
    potentialOfferings: db
      .pragma('table_info(elective_set_activities)')
      .some((c) => c.name === 'status')
      ? db.prepare(
          "SELECT COUNT(*) c FROM elective_set_activities WHERE status = 'potential'"
        ).get().c
      : 0,
  }

  db.transaction(() => {
    const hasStatus = db
      .pragma('table_info(elective_set_activities)')
      .some((c) => c.name === 'status')
    if (hasStatus) {
      db.exec('ALTER TABLE elective_set_activities DROP COLUMN status')
    }

    db.prepare('DELETE FROM schema_migrations WHERE version = 68').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v68_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v68_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v68_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV68(db)
  db.close()
  console.log(
    `v68 rolled back: potential/confirmed status discarded from ${result.potentialOfferings} offering(s)`
  )
  console.log(
    'NOTE: this app build still declares schema version 68 — reopening it recreates the ' +
    "status column (default 'confirmed'). Genuinely lost either way: which offerings were " +
    'still potential. Everything else survives.'
  )
}
