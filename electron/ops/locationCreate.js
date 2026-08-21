// T101 (docs/work/tickets/T101-locations-deterministic-id-rename-recollide.md):
// the db-backed wrapper around locationId.js's pure resolveLocationCandidateId,
// used at every deterministic location-create site that has a db handle
// (electron/ops/ingest.js). Queries the camp's current locations once, then
// defers to the pure scan — the array-backed caller (ActivitiesScreen's T81
// importer, which already holds the loaded `locations` list) calls
// resolveLocationCandidateId directly instead of duplicating this query.
import { resolveLocationCandidateId } from './locationId.js'

export function resolveLocationCreateId(db, campId, trimmedName) {
  const existingLocations = db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(campId)
  return resolveLocationCandidateId(campId, trimmedName, existingLocations).id
}
