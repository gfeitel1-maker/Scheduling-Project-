// Inverse of migration v35 (electron/db/localDb.js): drops
// elective_set_activities and elective_sets, and removes template_slots'
// elective_set_id column — the T41 slice 1 data shape
// (docs/work/specs/2026-08-20-group-electives-design.md).
//
// Two steps, not one, because v35 (unlike v34) touches an EXISTING core table
// as well as adding new ones:
//   1. Drop elective_set_activities then elective_sets (children before
//      parent — elective_set_activities REFERENCES elective_sets(id)).
//   2. Drop template_slots.elective_set_id via ALTER TABLE ... DROP COLUMN
//      (supported by the bundled SQLite version — same precedent as v32_down's
//      `ALTER TABLE activities DROP COLUMN location_id`). Any slot that was an
//      elective cell (elective_set_id set) reverts to reading as an ordinary
//      empty activity cell (activity_id was already null/ignored on those
//      rows) — the cell's elective content is genuinely lost, stated rather
//      than hidden.
//   3. No registry membership left dangling: this script does not touch
//      PROJECTIONS, campScopedEntities.js, syncClient.js, or permissions.js —
//      those are separate, deliberate code changes a schema-only rollback
//      does not undo. A build still referencing these entities/column in the
//      registries would throw on the next write (table/column doesn't exist),
//      the correct failure mode.
//   4. No backfill to undo: v35 had none (every camp starts with zero
//      elective sets, every existing slot's elective_set_id defaults NULL),
//      so the worst case on drop is losing any elective sets a director had
//      already created plus any cells they'd marked as electives — full
//      op-log history survives in `operations` regardless.
//
// Usage:  node electron/db/rollback/v35_down.js <path-to-shoresh.sqlite>

export function rollbackV35(db) {
  const countOf = (table) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
      : 0

  const discarded = {
    electiveSetActivities: countOf('elective_set_activities'),
    electiveSets: countOf('elective_sets'),
    electiveSlots: db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'template_slots')
      ? db.prepare("SELECT COUNT(*) c FROM template_slots WHERE elective_set_id IS NOT NULL").get().c
      : 0,
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS elective_set_activities')
    db.exec('DROP TABLE IF EXISTS elective_sets')

    const hasElectiveSetId = db
      .pragma('table_info(template_slots)')
      .some((c) => c.name === 'elective_set_id')
    if (hasElectiveSetId) db.exec('ALTER TABLE template_slots DROP COLUMN elective_set_id')

    db.prepare('DELETE FROM schema_migrations WHERE version = 35').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v35_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v35_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v35_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV35(db)
  db.close()
  console.log(
    `v35 rolled back: ${result.electiveSets} elective set(s), ${result.electiveSetActivities} member ` +
    `activity row(s), ${result.electiveSlots} elective cell(s) on template_slots discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 35 — reopening it recreates elective_sets/' +
    'elective_set_activities and re-adds template_slots.elective_set_id, both empty. No data is at risk ' +
    'either way; the entities and their full history live untouched in `operations`.'
  )
}
