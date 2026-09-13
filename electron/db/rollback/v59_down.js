// Inverse of migration v59 (electron/db/localDb.js): recreates the
// `day_overrides` table and the `schedule_snapshots.day_overrides_json`
// column removed by T145 (docs/work/tickets/T145-remove-day-overrides.md).
//
//   1. Recreate `day_overrides` with the exact DDL schema.sql carried before
//      the migration, including its four NOT NULL foreign keys and the
//      UNIQUE(schedule_week_id, day_id, group_id, time_block_id) constraint.
//   2. Re-add `day_overrides_json` to `schedule_snapshots` as the LAST column,
//      via ALTER — matching how v38 originally added it, and preserving the
//      column-order trap the v53 block's comment documents.
//   3. DATA IS NOT RESTORED, and cannot be. The v59 migration DROPs the table
//      and rebuilds schedule_snapshots without the column, discarding both —
//      a deliberate hard cutover following the v53/overlay precedent
//      (pre-production, no real camp data). This rollback recreates the SHAPE
//      so an older build can run; every override row and every snapshot's
//      captured overrides are gone for good. That is the known cost of the
//      migration, not a defect in this script.
//   4. No registry membership is restored: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), campScopedEntities.js,
//      undoReferences.js, permissions.js, or campDocument.js's
//      MODELED_ENTITIES. Those are separate, deliberate code changes that a
//      schema-only rollback does not undo — same posture as v46_down.
//
//      NOTE the consequence, because it is the one sharp edge here: a build
//      running the v59 CODE against a v58 SCHEMA has the table present but
//      unregistered, which is exactly the window Red Hat flagged during the
//      T145 review — undoReferences no longer blocks a delete that the DB's
//      own FK will then refuse, surfacing a raw `FOREIGN KEY constraint
//      failed` instead of a legible message. If you roll back the schema, roll
//      back the code with it.
//
// Usage:  node electron/db/rollback/v59_down.js <path-to-shoresh.sqlite>

export function rollbackV59(db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS day_overrides (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL REFERENCES camps(id),
      schedule_week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
      day_id TEXT NOT NULL REFERENCES days_of_operation(id),
      group_id TEXT NOT NULL REFERENCES groups(id),
      time_block_id TEXT NOT NULL,
      activity_id TEXT REFERENCES activities(id),
      kind TEXT NOT NULL DEFAULT 'swap',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(schedule_week_id, day_id, group_id, time_block_id)
    )`)

    // ALTER rather than a table rebuild: day_overrides_json was originally
    // ALTER-added (v38) and must land LAST, which ALTER guarantees.
    const cols = db.prepare('PRAGMA table_info(schedule_snapshots)').all()
    if (!cols.some((c) => c.name === 'day_overrides_json')) {
      db.exec('ALTER TABLE schedule_snapshots ADD COLUMN day_overrides_json TEXT')
    }

    // >= 59, not just = 59 (v32_down/v46_down precedent): a later migration's
    // schema_migrations row surviving this rollback would make
    // getSchemaVersion() report higher than 59, which defeats the v59
    // migration's own `>= 58 && < 59` guard on the next initSchema() — the
    // table would never get re-dropped.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 59').run()
  })()

  return { recreated: ['day_overrides', 'schedule_snapshots.day_overrides_json'], dataRestored: false }
}

// Direct invocation (node electron/db/rollback/v59_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v59_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v59_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV59(db)
  console.log(JSON.stringify(result))
  db.close()
}
