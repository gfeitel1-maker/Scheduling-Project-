// WEEK_CLOSED — "this filled slot holds something the director marked as NOT
// running in this week."
//
// Week-scoped exclusions (week_activity_exclusions, week_group_exclusions) mean
// "this activity / group does not run in this week" (exclude-list model; see
// docs/adr/2026-08-03-multi-week-slices-2-3.md §2). The GENERATE route honors
// them up front via resolveWeekCatalog (src/engine/weekCatalog.js), which drops
// the excluded entities from the catalog before the engine ever runs. The
// MANUAL drag-drop route builds nothing up front — the director places cells by
// hand — so the same rule has to be surfaced AFTER placement instead.
//
// Like OVERLAP (src/utils/computeOverlaps.js), this is derived at render time
// from the slots on screen and the current week's exclusion rows, never
// persisted: it has the same character as the aggregate findings (recomputed
// fresh, no dismissal state), it can never go stale, and it clears from a cell
// the moment the director moves the placement off or re-opens the week.
//
// It is a SOFT flag: the placement is ACCEPTED and marked, never blocked and
// never silently corrected — a director building their own week is never
// refused (CONSTITUTION Art. V), the same posture placeActivityManual already
// takes for capacity clashes. It exists only on the manual route.
//
// Anchors (meals, tefillah, recurring events) and empty cells are skipped — an
// empty cell has nothing placed to be closed, and an anchor is structural
// chrome the exclusion UIs govern differently. This differs from
// computeOverlaps, which no longer blanket-skips `s.is_anchor`: an anchor row
// still occupies its place there (to correctly flag a non-anchor placement
// sharing a full anchor location) even though it is itself never flagged.
//
// LOCATION (week_location_exclusions) is a third exclusion type whose producer
// and generate-route enforcement land with slice M5; the reason-accumulation
// loop below is shaped so a location arm is a small, isolated addition then —
// see docs/work/specs/2026-08-16-manual-route-week-exclusions-design.md §6.

// weekId, when provided, filters the rows defensively (parity with
// resolveWeekCatalog). Callers pass rows already loaded for the current week
// (repo.loadWeekExclusions(weekId)); an omitted weekId matches every row.
function excludedIdSet(rows, idField, weekId) {
  const set = new Set()
  for (const row of rows || []) {
    if (weekId != null && row.week_id !== weekId) continue
    set.add(row[idField])
  }
  return set
}

export function computeWeekClosures({
  slots,
  activities,
  groups,
  locations,
  activityExclusions,
  groupExclusions,
  locationExclusions,
  weekId,
}) {
  const closures = new Map() // slot id -> reason string
  if (!slots) return closures

  const excludedActivityIds = excludedIdSet(activityExclusions, 'activity_id', weekId)
  const excludedGroupIds = excludedIdSet(groupExclusions, 'group_id', weekId)
  // The location arm the header comment anticipated: a slot's activity can sit
  // on a place the director closed this week. It reaches the slot through
  // activity.location_id (the slot itself carries no location), mirroring how
  // resolveWeekCatalog hops location -> activity on the generate route.
  const excludedLocationIds = excludedIdSet(locationExclusions, 'location_id', weekId)
  if (
    excludedActivityIds.size === 0 &&
    excludedGroupIds.size === 0 &&
    excludedLocationIds.size === 0
  ) {
    return closures
  }

  const actName = new Map((activities || []).map(a => [a.id, a.name]))
  const grpName = new Map((groups || []).map(g => [g.id, g.name]))
  const actLocationId = new Map((activities || []).map(a => [a.id, a.location_id]))
  const locName = new Map((locations || []).map(l => [l.id, l.name]))

  for (const s of slots) {
    if (s.is_anchor || !s.activity_id) continue
    const reasons = []
    if (excludedActivityIds.has(s.activity_id)) {
      reasons.push(`${actName.get(s.activity_id) || 'This activity'} is marked closed this week`)
    }
    if (excludedGroupIds.has(s.group_id)) {
      reasons.push(`${grpName.get(s.group_id) || 'This group'} is marked closed this week`)
    }
    const locId = actLocationId.get(s.activity_id)
    if (locId != null && excludedLocationIds.has(locId)) {
      reasons.push(`${locName.get(locId) || 'This location'} is marked closed this week`)
    }
    if (reasons.length) closures.set(s.id, reasons.join('; '))
  }

  return closures
}

// Merges the derived marker into the flags each cell renders from, leaving the
// persisted rows untouched and returning the SAME array reference when nothing
// is closed (mirrors withOverlapFlags, so the screen's useMemo stays stable on
// the common no-exclusions path).
export function withWeekClosureFlags(slots, { activities, groups, locations, activityExclusions, groupExclusions, locationExclusions, weekId }) {
  const closures = computeWeekClosures({ slots, activities, groups, locations, activityExclusions, groupExclusions, locationExclusions, weekId })
  if (closures.size === 0) return slots
  return slots.map(s =>
    closures.has(s.id)
      ? { ...s, flags: { ...(s.flags || {}), WEEK_CLOSED: true, WEEK_CLOSED_reason: closures.get(s.id) } }
      : s
  )
}
