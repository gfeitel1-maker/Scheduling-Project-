import { resolveFixedEventActivityIds } from './fixedEventActivityLink.js'
import { resolveFixedEventGroupIds } from './fixedEventScope.js'

// Pure pre-pass that resolves the camp-wide catalog against a single week's
// exclusion rows before handing the filtered sets to buildSchedule.
//
// Semantics: a row in activityExclusions/groupExclusions means "this entity
// does NOT run in this week." Absence means it runs (exclude-list model).
// See docs/adr/2026-08-03-multi-week-slices-2-3.md §2.
export function resolveWeekCatalog({
  groups,
  activities,
  fixedEvents,
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
    return { groups, activities, fixedEvents, suppressedFixedEvents: [] }
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

  const keptFixedEvents = []
  const suppressedFixedEvents = []

  // A fixed event links to its activity via `fixed_events.activity_id` — see
  // fixedEventActivityLink.js. T267 PR2 cuts this over from the earlier
  // name-matching fallback to a direct id lookup.
  for (const fixedEvent of fixedEvents) {
    const fixedEventActivityIds = resolveFixedEventActivityIds(fixedEvent)
    if (fixedEventActivityIds.some((id) => excludedActivityIds.has(id))) {
      suppressedFixedEvents.push({ fixedEvent, reason: 'activity-excluded' })
      continue
    }
    if (fixedEventActivityIds.some((id) => locationExcludedActivityIds.has(id))) {
      suppressedFixedEvents.push({ fixedEvent, reason: 'location-excluded' })
      continue
    }

    // Contract: group_ids is an array of ids. Callers normalize — this engine
    // does not deserialize; see src/screens/schedule/useScheduleData.js.
    // Only suppress if EVERY group in the fixedEvent's group list is excluded.
    if (!fixedEvent.is_all_groups) {
      // T180: resolve through the SHARED scope resolver, not group_ids
      // directly — a division-scoped (unit_ids) event carries an empty
      // group_ids, and reading that raw made it impossible to suppress.
      const fixedEventGroupIds = resolveFixedEventGroupIds(fixedEvent, groups)

      if (
        fixedEventGroupIds.length > 0 &&
        fixedEventGroupIds.every((gid) => excludedGroupIds.has(gid))
      ) {
        suppressedFixedEvents.push({ fixedEvent, reason: 'all-groups-excluded' })
        continue
      }
    }

    keptFixedEvents.push(fixedEvent)
  }

  return {
    groups: filteredGroups,
    activities: filteredActivities,
    fixedEvents: keptFixedEvents,
    suppressedFixedEvents,
  }
}
