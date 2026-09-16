import { indexActivitiesByName, resolveAnchorActivityIds } from './anchorActivityLink.js'
import { resolveAnchorGroupIds } from './anchorScope.js'

// Pure pre-pass that resolves the camp-wide catalog against a single week's
// exclusion rows before handing the filtered sets to buildSchedule.
//
// Semantics: a row in activityExclusions/groupExclusions means "this entity
// does NOT run in this week." Absence means it runs (exclude-list model).
// See docs/adr/2026-08-03-multi-week-slices-2-3.md §2.
export function resolveWeekCatalog({
  groups,
  activities,
  anchors,
  weekId,
  activityExclusions,
  groupExclusions,
  locationExclusions,
}) {
  const excludedActivityIds = new Set(
    (activityExclusions || [])
      .filter((e) => e.week_id === weekId)
      .map((e) => e.activity_id)
  )
  const excludedGroupIds = new Set(
    (groupExclusions || [])
      .filter((e) => e.week_id === weekId)
      .map((e) => e.group_id)
  )
  const excludedLocationIds = new Set(
    (locationExclusions || [])
      .filter((e) => e.week_id === weekId)
      .map((e) => e.location_id)
  )

  if (excludedActivityIds.size === 0 && excludedGroupIds.size === 0 && excludedLocationIds.size === 0) {
    return { groups, activities, anchors, suppressedAnchors: [] }
  }

  // The location→activity hop: an activity bound to a closed place is
  // filtered here, at the activity level — filtering the `locations`
  // capacity array alone would be insufficient, since buildSchedule.js
  // treats an unmapped/absent location_id as unconstrained.
  const locationExcludedActivityIds = new Set(
    activities.filter((a) => a.location_id != null && excludedLocationIds.has(a.location_id)).map((a) => a.id)
  )

  const filteredActivities = activities.filter(
    (a) => !excludedActivityIds.has(a.id) && !locationExcludedActivityIds.has(a.id)
  )
  const filteredGroups = groups.filter((g) => !excludedGroupIds.has(g.id))

  const keptAnchors = []
  const suppressedAnchors = []

  // An anchor names its activity, it does not link to it — see
  // anchorActivityLink.js. This read was `anchor.activity_id ?? anchor.unit_id`,
  // which resolved to undefined for every real row (no such column) and then
  // fell back to unit_id — a TIER id, compared against ACTIVITY ids, so it
  // could only ever miss. Both suppression rules below were therefore inert:
  // closing Swim (or the Pool) for a week left the Swim anchor on the grid.
  // Same root cause as the T62 placement bug, same fix, one shared resolver.
  const activitiesByName = indexActivitiesByName(activities)

  for (const anchor of anchors) {
    const anchorActivityIds = resolveAnchorActivityIds(anchor, activitiesByName)
    if (anchorActivityIds.some((id) => excludedActivityIds.has(id))) {
      suppressedAnchors.push({ anchor, reason: 'activity-excluded' })
      continue
    }
    if (anchorActivityIds.some((id) => locationExcludedActivityIds.has(id))) {
      suppressedAnchors.push({ anchor, reason: 'location-excluded' })
      continue
    }

    // Contract: group_ids is an array of ids. Callers normalize — this engine
    // does not deserialize; see src/screens/schedule/useScheduleData.js.
    // Only suppress if EVERY group in the anchor's group list is excluded.
    if (!anchor.is_all_groups) {
      // T180: resolve through the SHARED scope resolver, not group_ids
      // directly — a division-scoped (unit_ids) event carries an empty
      // group_ids, and reading that raw made it impossible to suppress.
      const anchorGroupIds = resolveAnchorGroupIds(anchor, groups)

      if (
        anchorGroupIds.length > 0 &&
        anchorGroupIds.every((gid) => excludedGroupIds.has(gid))
      ) {
        suppressedAnchors.push({ anchor, reason: 'all-groups-excluded' })
        continue
      }
    }

    keptAnchors.push(anchor)
  }

  return {
    groups: filteredGroups,
    activities: filteredActivities,
    anchors: keptAnchors,
    suppressedAnchors,
  }
}
