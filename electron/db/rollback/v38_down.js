// Inverse of migration v38 (electron/db/localDb.js): drops the day_overrides
// table and schedule_snapshots.day_overrides_json — the T108 day-overrides
// re-point (docs/adr/2026-08-21-day-overrides-repoint-shape.md D1/§5.2).
//
// Two additive changes, so the rollback is a table DROP plus a column DROP,
// plus the schema_migrations row — no dependent structure to unwind beyond
// those two (mirrors v34's new-table rollback + v37's ALTER-column rollback,
// combined).
//
// DISCLOSED ROLLBACK LOSS: every day_overrides row (swaps/pulls a director
// authored) is discarded, and any day_overrides_json a snapshot had already
// captured is discarded. schedule_snapshots rows themselves, their slots/
// overlays, and the full op-log history for everything else are untouched.
//
// Usage:  node electron/db/rollback/v38_down.js <path-to-shoresh.sqlite>

export function rollbackV38(db) {
  const discarded = {
    dayOverrides: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'day_overrides'").get()
      ? db.prepare('SELECT COUNT(*) c FROM day_overrides').get().c
      : 0,
    snapshotsWithDayOverridesJson: db
      .pragma('table_info(schedule_snapshots)')
      .some((c) => c.name === 'day_overrides_json')
      ? db.prepare(
          "SELECT COUNT(*) c FROM schedule_snapshots WHERE day_overrides_json IS NOT NULL AND day_overrides_json != ''"
        ).get().c
      : 0,
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS day_overrides')

    const hasDayOverridesJson = db
      .pragma('table_info(schedule_snapshots)')
      .some((c) => c.name === 'day_overrides_json')
    if (hasDayOverridesJson) db.exec('ALTER TABLE schedule_snapshots DROP COLUMN day_overrides_json')

    db.prepare('DELETE FROM schema_migrations WHERE version = 38').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v38_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v38_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v38_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV38(db)
  db.close()
  console.log(
    `v38 rolled back: ${result.dayOverrides} day override(s) discarded, day_overrides_json cleared from ` +
    `${result.snapshotsWithDayOverridesJson} snapshot(s) that had it`
  )
  console.log(
    'NOTE: this app build still declares schema version 38 — reopening it recreates the day_overrides ' +
    'table (empty) and the day_overrides_json column (NULL). Genuinely lost either way: any overrides a ' +
    'director had authored and any override state a snapshot had captured. Everything else survives.'
  )
}
