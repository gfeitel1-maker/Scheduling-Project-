// Inverse of migration v46 (electron/db/localDb.js): recreates
// day_override_templates and day_override_template_slots — the confirmed-
// dead table pair dropped per docs/adr/2026-08-23-override-family-model.md
// §6a.
//
//   1. Recreate both tables via the exact DDL schema.sql carried before this
//      migration (parent first, then child, matching the FK direction).
//   2. No data to restore: the migration confirmed no writer ever existed
//      for either table (grep across src/ and electron/, cited in the ADR),
//      so both tables were empty on every real device before the drop. This
//      rollback recreates them EMPTY — that is not a data loss, there was
//      never data to lose.
//   3. No registry membership restored: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), campScopedEntities.js,
//      permissions.js, syncClient.js, or the other plumbing files the v46
//      migration's own PR updated — those are separate, deliberate code
//      changes a schema-only rollback does not undo. A build still running
//      the v46 code (which no longer references either table) simply never
//      writes to them; nothing throws, matching the "already unused" state
//      the tables were in before this migration.
//
// Usage:  node electron/db/rollback/v46_down.js <path-to-shoresh.sqlite>

export function rollbackV46(db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS day_override_templates (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL REFERENCES camps(id),
      cohort_id TEXT REFERENCES cohorts(id),
      name TEXT NOT NULL,
      frequency_mode TEXT
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS day_override_template_slots (
      id TEXT PRIMARY KEY,
      day_override_template_id TEXT NOT NULL REFERENCES day_override_templates(id),
      time_block_id TEXT,
      activity_id TEXT
    )`)
    // >= 46, not just = 46 (v32_down's precedent): a later migration's
    // schema_migrations row surviving this rollback would make
    // getSchemaVersion() report a version higher than 46, which defeats the
    // v46 migration's own `>= 45 && < 46` guard on the next initSchema() —
    // the tables would never get re-dropped. Surfaced by adding v47 on top
    // (declinedTwoRowSplits) — see declinedTwoRowSplits work.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 46').run()
  })()

  return { recreated: ['day_override_templates', 'day_override_template_slots'] }
}

// Direct invocation (node electron/db/rollback/v46_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v46_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v46_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV46(db)
  db.close()
  console.log(`v46 rolled back: recreated ${result.recreated.join(', ')} (empty — neither table ever had a writer)`)
  console.log(
    'NOTE: this app build still declares schema version 46 — reopening it re-drops both tables. ' +
    'No data is at risk either way; nothing ever wrote to them.'
  )
}
