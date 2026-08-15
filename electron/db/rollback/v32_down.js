// Inverse of migration v32 (electron/db/localDb.js): removes the camp
// `locations` entity (docs/adr/2026-08-15-camp-locations-entity.md, "Rollback").
//
// Unlike v30/v31 (drop a host-local memory table), v32 introduced STRUCTURE
// that real domain data now points at, so the rollback is three steps, not one:
//
//   1. Repopulate the frozen activities.location column from locations.name via
//      location_id, so rollback is LOSSLESS FOR LOCATION NAMES — including names
//      created or renamed AFTER the upgrade. This is why D5 keeps the frozen
//      column: it is the rollback anchor.
//   2. Drop week_location_exclusions, locations, activities.location_id, and the
//      local review journal.
//   3. Delete the v32 row from schema_migrations.
//
// DISCLOSED ROLLBACK LOSSES (inherent to rolling back a structure-introducing
// migration, stated rather than discovered): per-location capacity, geometry,
// week exclusions, and any merge decisions. Names survive; structure does not.
//
// Usage:  node electron/db/rollback/v32_down.js <path-to-shoresh.sqlite>

export function rollbackV32(db) {
  const has = (table) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)

  const discardedLocations = has('locations')
    ? db.prepare('SELECT COUNT(*) c FROM locations').get().c
    : 0
  const discardedExclusions = has('week_location_exclusions')
    ? db.prepare('SELECT COUNT(*) c FROM week_location_exclusions').get().c
    : 0

  db.transaction(() => {
    const hasLocationId = db
      .pragma('table_info(activities)')
      .some((c) => c.name === 'location_id')

    // Repopulate the frozen column from the entity before dropping either.
    // COALESCE keeps the existing frozen string when location_id dangles — no
    // DB-level FK clears a stale reference, and a NULL subquery result would
    // otherwise destroy the very anchor this rollback exists to preserve.
    if (hasLocationId && has('locations')) {
      db.exec(
        `UPDATE activities
            SET location = COALESCE(
              (SELECT name FROM locations WHERE locations.id = activities.location_id),
              location
            )
          WHERE location_id IS NOT NULL`
      )
    }

    db.exec('DROP INDEX IF EXISTS idx_week_location_exclusions_week_location')
    db.exec('DROP TABLE IF EXISTS week_location_exclusions')
    db.exec('DROP TABLE IF EXISTS locations')
    db.exec('DROP TABLE IF EXISTS location_migration_reviews')
    if (hasLocationId) db.exec('ALTER TABLE activities DROP COLUMN location_id')

    db.prepare('DELETE FROM schema_migrations WHERE version = 32').run()
  })()

  return { discardedLocations, discardedExclusions }
}

// Direct invocation (node electron/db/rollback/v32_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v32_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v32_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV32(db)
  db.close()
  console.log(
    `v32 rolled back: ${result.discardedLocations} location(s) and ` +
    `${result.discardedExclusions} week-exclusion(s) discarded; location names repopulated onto activities.location`
  )
  console.log(
    'NOTE: this app build still declares schema version 32 — reopening it recreates the ' +
    'locations entity and re-runs the deterministic backfill. Per-location capacity, geometry, ' +
    'week exclusions and merge decisions are NOT recoverable; location names are.'
  )
}
