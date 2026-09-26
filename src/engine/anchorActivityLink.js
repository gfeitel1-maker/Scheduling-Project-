// An anchor (`fixed_events`) references its activity BY NAME, not by id, in
// this module's own resolution logic below — that is still true and is what
// buildSchedule/weekCatalog actually call through. What is NO LONGER true:
// "there is no activity_id column and never has been." T267
// (docs/adr/2026-09-26-fixed-recurring-event-identity-model.md) added a real
// `fixed_events.activity_id` column and backfills it at migration time, but
// PR 1 stops there — no runtime write path sets it yet (the Anchors screen
// still asks the director to TYPE the event, and electron/ops/ingest.js still
// writes name/day/block/scope with no activity link), and this module still
// resolves by name for every real caller. PR 2 is what cuts resolution over to
// `activity_id` and deletes the name-matching fallback below. T62 ("the
// engine places anchor activities a second time as regular slots") was closed
// against an `anchor.activity_id` the row did not carry at the time, so its
// exclusion Set was empty in production for a month while its unit test —
// which hand-built an anchor WITH that field — stayed green. That history is
// the reason PR 2 must prove the cutover against the REAL table, not a
// fixture that assumes the field exists.
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

// The catalog activities one anchor stands for. `activity_id` is honored
// first — real rows CAN carry it now (T267's migration backfill sets it for
// existing data), but no runtime write path sets it yet, so most callers
// still resolve by name in practice. An explicit link always beats a name
// guess. An anchor whose name matches nothing in the catalog ("Mifkad", "Lunch
// + Leave") resolves to [], which is the correct no-op.
export function resolveAnchorActivityIds(anchor, activitiesByName) {
  if (anchor?.activity_id != null) return [anchor.activity_id]
  return activitiesByName.get(anchorNameKey(anchor?.name)) ?? []
}
