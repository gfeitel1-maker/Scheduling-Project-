// Inverse of migration v40 (electron/db/localDb.js): drops events and
// removes template_slots' event_id column — the Events overlay placement
// Slice 1 data shape (docs/adr/2026-08-22-events-overlay-placement.md).
//
// Two steps, mirroring v35_down.js's shape:
//   1. Drop events (a single new table, no children referencing it).
//   2. Drop template_slots.event_id via ALTER TABLE ... DROP COLUMN
//      (supported by the bundled SQLite version — same precedent as
//      v35_down's `ALTER TABLE template_slots DROP COLUMN elective_set_id`).
//      Any slot that was an event cell (event_id set) reverts to reading as
//      an ordinary empty activity cell — the cell's event content is
//      genuinely lost, stated rather than hidden.
//   3. No registry membership left dangling: this script does not touch
//      PROJECTIONS, BULK_REPLACE_ENTITIES, UNIQUE_FIELD_ENTITIES,
//      UNIQUE_FIRST_FIELD, or MUTUALLY_EXCLUSIVE_FIELDS — those are separate,
//      deliberate code changes a schema-only rollback does not undo. A build
//      still referencing these registrations would throw on the next write
//      (table/column doesn't exist), the correct failure mode.
//   4. No backfill to undo: v40 had none (every camp starts with zero
//      events, every existing slot's event_id defaults NULL), so the worst
//      case on drop is losing any events a director had already created
//      plus any cells they'd placed events on — full op-log history
//      survives in `operations` regardless.
//
// Usage:  node electron/db/rollback/v40_down.js <path-to-shoresh.sqlite>

export function rollbackV40(db) {
  const countOf = (table) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
      : 0

  const discarded = {
    events: countOf('events'),
    eventSlots: db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'template_slots')
      ? db.prepare("SELECT COUNT(*) c FROM template_slots WHERE event_id IS NOT NULL").get().c
      : 0,
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS events')

    const hasEventId = db
      .pragma('table_info(template_slots)')
      .some((c) => c.name === 'event_id')
    if (hasEventId) db.exec('ALTER TABLE template_slots DROP COLUMN event_id')

    db.prepare('DELETE FROM schema_migrations WHERE version = 40').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v40_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v40_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v40_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV40(db)
  db.close()
  console.log(
    `v40 rolled back: ${result.events} event(s), ${result.eventSlots} event cell(s) on template_slots discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 40 — reopening it recreates events and ' +
    're-adds template_slots.event_id, both empty. No data is at risk either way; the entities and ' +
    'their full history live untouched in `operations`.'
  )
}
