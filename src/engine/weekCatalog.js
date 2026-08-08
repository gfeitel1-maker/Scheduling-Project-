import { assertIdListShape } from './assertIdListShape.js'

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

  if (excludedActivityIds.size === 0 && excludedGroupIds.size === 0) {
    return { groups, activities, anchors, suppressedAnchors: [] }
  }

  const filteredActivities = activities.filter((a) => !excludedActivityIds.has(a.id))
  const filteredGroups = groups.filter((g) => !excludedGroupIds.has(g.id))

  const keptAnchors = []
  const suppressedAnchors = []

  for (const anchor of anchors) {
    if (excludedActivityIds.has(anchor.activity_id ?? anchor.unit_id)) {
      suppressedAnchors.push({ anchor, reason: 'activity-excluded' })
      continue
    }

    // Contract: group_ids is an array of ids. Callers normalize — this engine
    // does not deserialize; see src/screens/schedule/useScheduleData.js.
    // Only suppress if EVERY group in the anchor's group list is excluded.
    if (!anchor.is_all_groups) {
      if (import.meta.env.DEV) assertIdListShape(anchor.group_ids, 'group_ids', anchor.id)
      const anchorGroupIds = anchor.group_ids || []

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
