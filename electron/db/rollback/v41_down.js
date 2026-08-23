// Inverse of migration v41 (electron/db/localDb.js): drops event_slots,
// event_time_blocks, and event_groups — the Events internal sub-schedule
// Slice 2 shape (docs/adr/2026-08-22-event-internal-subschedule.md).
//
// Dropping the tables IS the whole rollback, same demonstration v34_down
// gives for special_days' three tables:
//   - Children before parent — event_slots FKs both event_groups and
//     event_time_blocks (soft references, no SQL REFERENCES, but the
//     logical dependency still runs that direction), so it drops first.
//     event_time_blocks and event_groups drop after, order between them
//     unconstrained (neither FKs the other). events itself is Slice 1's
//     table and is untouched by this rollback.
//   - No registry membership left dangling: this script does not touch
//     PROJECTIONS (electron/ops/projections.js), campScopedEntities.js, or
//     permissions.js — those are separate, deliberate code changes a
//     rollback of the schema alone does not undo.
//   - No backfill to undo: v41 had none (every event starts with zero time
//     blocks/groups/slots), so the worst case on drop is losing any
//     internal sub-schedule a director had already authored — their full
//     op-log history survives in `operations` regardless.
//
// Usage:  node electron/db/rollback/v41_down.js <path-to-shoresh.sqlite>

export function rollbackV41(db) {
  const countOf = (table) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
      : 0

  const discarded = {
    eventSlots: countOf('event_slots'),
    eventTimeBlocks: countOf('event_time_blocks'),
    eventGroups: countOf('event_groups'),
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS event_slots')
    db.exec('DROP TABLE IF EXISTS event_time_blocks')
    db.exec('DROP TABLE IF EXISTS event_groups')
    db.prepare('DELETE FROM schema_migrations WHERE version = 41').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v41_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v41_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v41_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV41(db)
  db.close()
  console.log(
    `v41 rolled back: ${result.eventTimeBlocks} time block(s), ${result.eventGroups} group(s), ` +
    `${result.eventSlots} slot(s) discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 41 — reopening it recreates the three tables ' +
    'empty. No data is at risk either way; the entities and their full history live untouched in `operations`.'
  )
}
