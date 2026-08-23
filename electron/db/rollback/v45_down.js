// Inverse of migration v45 (electron/db/localDb.js): removes the
// location_id columns added to anchor_activities and events — the Slice 4
// engine location-contention prerequisite, data-shape-only slice
// (docs/work/specs/2026-08-23-slice4-engine-location-contention.md §1/§6).
//
//   1. Drop both columns via ALTER TABLE ... DROP COLUMN (supported by the
//      bundled SQLite version — same precedent as v44_down's
//      `ALTER TABLE activities DROP COLUMN ...`).
//   2. No registry membership left dangling: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), syncClient.js, or
//      localClient.mock.js — those are separate, deliberate code changes a
//      schema-only rollback does not undo. A build still referencing either
//      column in the registries would throw on the next write (column
//      doesn't exist), the correct failure mode.
//   3. Neither column carries a backfill to undo (every existing row keeps
//      NULL, i.e. unconstrained). The worst case of a rollback is losing any
//      location a director had already set; the full op-log history
//      survives in `operations` regardless.
//
// Usage:  node electron/db/rollback/v45_down.js <path-to-shoresh.sqlite>

export function rollbackV45(db) {
  const countOf = (table, column) =>
    db.pragma(`table_info(${table})`).some((c) => c.name === column)
      ? db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${column} IS NOT NULL`).get().c
      : 0

  const discarded = {
    anchorLocationId: countOf('anchor_activities', 'location_id'),
    eventLocationId: countOf('events', 'location_id'),
  }

  db.transaction(() => {
    const anchorCols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    if (anchorCols.includes('location_id')) {
      db.exec('ALTER TABLE anchor_activities DROP COLUMN location_id')
    }
    const eventCols = db.pragma('table_info(events)').map((c) => c.name)
    if (eventCols.includes('location_id')) {
      db.exec('ALTER TABLE events DROP COLUMN location_id')
    }
    db.prepare('DELETE FROM schema_migrations WHERE version = 45').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v45_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v45_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v45_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV45(db)
  db.close()
  console.log(
    `v45 rolled back: ${result.anchorLocationId} anchor(s) and ${result.eventLocationId} event(s) with a location discarded`
  )
  console.log(
    'NOTE: this app build still declares schema version 45 — reopening it re-adds the columns, empty. ' +
    'No data is at risk either way; the entities and their full history live untouched in `operations`.'
  )
}
