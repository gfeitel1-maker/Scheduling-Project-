// Pure model for the indoor/outdoor map pair (schema v50,
// docs/adr/2026-08-26-indoor-outdoor-map-pair-and-sim-seed.md D2).
//
// A camp has zero, one, or two `camp_maps` rows. The ORIGINAL map always has
// id === camp_id (the pre-v50 singleton id); any second map has a minted uuid
// and an explicit `kind` ('indoor' | 'outdoor'). A location's `map_geometry` is
// drawn against the map named by its `map_id`; `map_id = NULL` is a stable
// sentinel meaning "the original map" — so adding a second map never requires
// rewriting map_id on the camp's existing markers (only the original row's
// `kind` is set, for the toggle label). This is deliberate: it sidesteps a
// mass-backfill over every placed location.

// The id that a NULL map_id resolves to: the original map (id === camp_id),
// else the only/first map, else null.
export function primaryMapId(maps, campId) {
  if (!maps || maps.length === 0) return null
  const original = maps.find((m) => m.id === campId)
  return (original ?? maps[0]).id
}

// Which map a location's geometry belongs to.
export function resolveLocationMapId(location, maps, campId) {
  return location?.map_id ?? primaryMapId(maps, campId)
}

// Locations whose geometry belongs to the given map id.
export function locationsOnMap(locations, mapId, maps, campId) {
  if (!mapId) return locations
  return (locations || []).filter((l) => resolveLocationMapId(l, maps, campId) === mapId)
}

// Human label for a map slot. Explicit kinds win; an unlabeled original map is
// just "Map" (only ever shown when a camp has a single, pre-pair map, where no
// toggle renders anyway).
export function mapSlotLabel(map) {
  if (map?.kind === 'indoor') return 'Buildings'
  if (map?.kind === 'outdoor') return 'Grounds'
  return 'Map'
}

// True when the camp has opted into the two-map experience — i.e. more than one
// row exists. A single row (labeled or not) renders exactly as the pre-v50
// single-map tab, no toggle.
export function hasMapPair(maps) {
  return (maps?.length ?? 0) > 1
}

// The map row a director should see selected by default: the primary one.
export function defaultActiveMapId(maps, campId) {
  return primaryMapId(maps, campId)
}
