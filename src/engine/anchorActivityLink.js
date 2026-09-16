// An anchor (`anchor_activities`) references its activity BY NAME, not by id.
// There is no `activity_id` column and never has been — the Anchors screen has
// asked the director to TYPE the event ("e.g. Mifkad, Lunch, Swim") since the
// first commit, and electron/ops/ingest.js writes name/day/block/scope and no
// activity link. T62 ("the engine places anchor activities a second time as
// regular slots") was closed against an `anchor.activity_id` the row does not
// carry, so its exclusion Set was empty in production for a month while its
// unit test — which hand-built an anchor WITH that field — stayed green.
//
// This module is the one place that link is resolved, so buildSchedule (pass 1
// placement) and weekCatalog (week-exclusion suppression) cannot drift apart.
//
// Matching key: the repo's existing recognition key for entity identity,
// `whitespaceInsensitiveName` (src/ingest/preview.js) — lowercase, whitespace
// stripped. Re-spelled here rather than imported so the engine keeps its
// no-dependencies purity and the ingest layer stays downstream of it. If that
// key ever changes, these two must change together.
export function anchorNameKey(name) {
  return String(name ?? '').toLowerCase().replace(/\s+/g, '')
}

// activities[] → Map<nameKey, activityId[]>. Duplicate spellings of one name
// all map, deliberately: if a camp has two "Lunch" rows, anchoring Lunch must
// exclude both, not arbitrarily one.
export function indexActivitiesByName(activities) {
  const byName = new Map()
  for (const act of (activities || [])) {
    const key = anchorNameKey(act.name)
    if (key === '') continue
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(act.id)
  }
  return byName
}

// The catalog activities one anchor stands for. `activity_id` is still honored
// first — no row carries it today, but callers and fixtures may, and an
// explicit link should always beat a name guess. An anchor whose name matches
// nothing in the catalog ("Mifkad", "Lunch + Leave") resolves to [], which is
// the correct no-op.
export function resolveAnchorActivityIds(anchor, activitiesByName) {
  if (anchor?.activity_id != null) return [anchor.activity_id]
  return activitiesByName.get(anchorNameKey(anchor?.name)) ?? []
}
