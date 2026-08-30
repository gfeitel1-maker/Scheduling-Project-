// Inverse of migration v53 (electron/db/localDb.js): recreates the
// template_overlays table and re-adds schedule_snapshots.overlays — the
// overlay/stamp subsystem retired per
// docs/adr/2026-08-30-retire-overlay-stamp-subsystem.md.
//
//   1. Recreate template_overlays via the exact DDL schema.sql carried before
//      this migration. It comes back EMPTY: per the ADR §1, nothing in the
//      current build ever wrote to it (the authoring path was already dead), so
//      an empty recreation loses nothing that was reachable.
//   2. Re-add schedule_snapshots.overlays as a nullable TEXT column. This does
//      NOT restore prior values — the forward migration (ADR §2b) deliberately
//      discarded every snapshot's overlays JSON, and there is no source to
//      restore it from. Existing snapshot rows come back with overlays = NULL.
//      Unlike v46_down (where there was never data to lose), here there WAS
//      data: it was intentionally discarded per the ADR's hard-cutover
//      decision, and this rollback does not attempt to un-discard it.
//   3. No registry membership restored: this script does not touch
//      projections.js, campScopedEntities.js, restore.js, syncClient.js, the
//      week-op modules, or the render-layer deletes (ADR §3–§5) — those are
//      separate, deliberate code changes a schema-only rollback does not undo.
//      A build still running the v53 code (which no longer references either
//      the table or the column) simply never writes to them; nothing throws. A
//      genuine revert is a `git revert` of the whole PR, not a database
//      rollback plus a stale build.
//
// Usage:  node electron/db/rollback/v53_down.js <path-to-shoresh.sqlite>

export function rollbackV53(db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS template_overlays (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES schedule_templates(id),
      unit_id TEXT,
      day_id TEXT REFERENCES days_of_operation(id),
      from_block_order INTEGER,
      to_block_order INTEGER,
      label TEXT
    )`)
    const cols = db.pragma('table_info(schedule_snapshots)').map((c) => c.name)
    if (!cols.includes('overlays')) {
      // Nullable, no default, appended after the migration's column set. Prior
      // values are gone (discarded by the forward migration) — rows come back NULL.
      db.exec(`ALTER TABLE schedule_snapshots ADD COLUMN overlays TEXT`)
    }
    // >= 53, not just = 53 (v46_down's precedent): a later migration's
    // schema_migrations row surviving this rollback would make
    // getSchemaVersion() report a version higher than 53, defeating the v53
    // migration's own `>= 52 && < 53` guard on the next initSchema() — the
    // table/column would never get re-dropped.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 53').run()
  })()

  return { recreated: ['template_overlays', 'schedule_snapshots.overlays'] }
}

// Direct invocation (node electron/db/rollback/v53_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v53_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v53_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV53(db)
  db.close()
  console.log(`v53 rolled back: recreated ${result.recreated.join(', ')}`)
  console.log(
    'NOTE: template_overlays comes back EMPTY (nothing ever wrote to it) and ' +
    'schedule_snapshots.overlays comes back NULL for every row — the forward migration ' +
    'discarded the prior overlays JSON by design (ADR §2b) and this rollback does not restore it. ' +
    'This app build still declares schema version 53 — reopening it re-drops both.'
  )
}
