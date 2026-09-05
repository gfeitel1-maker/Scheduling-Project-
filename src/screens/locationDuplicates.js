import { normalizeWordKey } from '../utils/normalizeWordKey.js'

// Location identity is trim-only and case-sensitive by deliberate design
// (electron/ops/locationId.js, CONSTITUTION Art. V) — "Gym"/"gym" are
// genuinely distinct rows. This is a DERIVED, never-persisted marker (the
// computeOverlaps precedent) surfacing a near-duplicate on every creation
// path, not just the ones the v32 migration already reviewed into
// location_migration_reviews. Art. V's posture: FLAG, NEVER BLOCK — this
// groups live rows for display only; it never prevents a create.
//
// Reuses normalizeWordKey (electron/ops/locationWordDecisions.js, #288) so
// this comparison never silently disagrees with the "Is <word> a place?"
// held-conflict card's own notion of "the same word".
export function groupDuplicateLocations(locations) {
  const byKey = new Map()
  for (const loc of locations ?? []) {
    const key = normalizeWordKey(loc?.name)
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(loc)
  }
  const groups = new Map()
  for (const [key, rows] of byKey) {
    if (rows.length < 2) continue
    groups.set(key, [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name))))
  }
  return groups
}

// Per-location lookup of "the other rows sharing my normalized name" — what
// the render-time marker and its popover need. Empty array for a location
// with no duplicates.
export function duplicateSiblingsById(locations) {
  const groups = groupDuplicateLocations(locations)
  const map = new Map()
  for (const rows of groups.values()) {
    for (const row of rows) {
      map.set(row.id, rows.filter((r) => r.id !== row.id))
    }
  }
  return map
}
