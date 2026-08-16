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
// M6 (schema v33, docs/adr/2026-08-16-locations-optional-map.md) added a
// migration LAYERED ON TOP of v32's version number, even though camp_maps
// itself has no structural dependency on locations (it FKs to camps only).
// The migration system is strictly sequential/gated (`>= N && < N+1`), so
// leaving v33's schema_migrations row in place while removing v32's would
// create a version "hole" (31 and 33 present, 32 absent) that permanently
// wedges initSchema: v32's gate (`< 32`) would never re-fire because
// getSchemaVersion() (MAX(version)) reads 33, not 31. Deleting every version
// `>= 32`, not just `= 32`, keeps the state a future initSchema() can always
// recover from cleanly — v32 re-runs (recreating locations/week_location_
// exclusions/location_id), then v33 re-runs (CREATE TABLE IF NOT EXISTS on
// camp_maps, a no-op since this script never drops that table — camp_maps'
// own data is untouched by a locations-only rollback).
//
// BLAST-RADIUS WARNING for the next migration author: `>= 32` grows with
// every future migration layered on top, not just v33. If a future v34
// (independent of locations, e.g. some unrelated table) lands, THIS script
// would delete v34's schema_migrations row too and silently re-run it on next
// launch — harmless only if v34 is itself idempotent, which is not guaranteed
// by construction. When v34 lands, either confirm it's idempotent under a
// re-run, or rename this file (and the `>= 32` bound) to make the widened
// scope explicit, e.g. `v32_and_later_down.js`.
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

    db.prepare('DELETE FROM schema_migrations WHERE version >= 32').run()
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
