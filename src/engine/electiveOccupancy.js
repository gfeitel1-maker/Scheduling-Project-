// Resolves which real locations an elective set's offerings occupy, deduped
// by location — an elective set doesn't have one location itself, each
// offering has its own via elective_set_activities.activity_id →
// activities.location_id (docs/work/specs/2026-08-23-slice4-engine-location-
// contention.md §1). Two offerings of the SAME set sharing one place (e.g. a
// waterfront period with swim+kayak both at 'Waterfront') are one group
// physically present in one place, not two — dedup before registering, or a
// colocated set would phantom-consume extra capacity for a single group's
// presence.
//
// Shared by buildSchedule.js (registers engine placeUsage during Pass 1),
// computeOverlaps.js (manual-route OVERLAP detection), and
// useSlotMutations.js (generated-route write-time capacity check) so "where
// does an elective sit" has exactly one implementation.
export function resolveElectiveOfferingLocations(offeringActivityIds, activityById) {
  const locations = new Map() // locationId -> label (first offering's name at that location)
  for (const actId of (offeringActivityIds || [])) {
    const act = activityById.get(actId)
    const locId = act?.location_id
    if (locId != null && !locations.has(locId)) {
      locations.set(locId, act.name || 'an elective offering')
    }
  }
  return locations
}
