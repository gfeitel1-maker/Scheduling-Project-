// Route-wide resource validator (T193 Defect B / ADR D7). scheduleCohort's
// placeUsage ledger (buildSchedule.js) is per-cohort, so two cohorts can
// independently place groups in the same real location at the same
// day+block, each within its own capacity, while the COMBINED occupancy
// exceeds it. Worse: registerOverlayOccupancy (anchors, events, elective
// offerings) runs unconditionally, but placeBlocked/canPlace is only
// consulted from regular-activity placement — so two overlays can be
// authored into the same location/day/block over capacity within a SINGLE
// cohort, and nothing catches that either. This module is the pass that
// catches both: pure, read-only, reports OUTER_RESOURCE_CONFLICT wherever
// combined occupancy at a location/day/block exceeds that location's
// capacity — regardless of which cohort(s) put it there — never mutates a
// slot or moves a group.
//
// Deliberately re-derives location occupancy from `allSlots` + the setup
// entities rather than reusing scheduleCohort's internal placeUsage map,
// which is scoped per cohort and torn down between cohorts. It reuses the
// SAME occupancy rules those per-cohort ledgers encode (registerOverlayOccupancy
// / resolveElectiveOfferingLocations) so there is exactly one definition of
// "what occupies a place" — see electiveOccupancy.js's own header for the
// dedup rule this preserves.
//
// Why this doesn't false-positive on correct single-cohort placement:
// regular-activity placement already respects capacity via placeUsage/
// placeBlocked (canPlace, buildSchedule.js) — the engine never over-places
// activities against each other — so activity-vs-activity occupancy within
// one cohort never exceeds capacity here either (buildSchedule.test.js's
// "place capacity keyed by location_id (M2)" suite pins that). What was
// missing was the overlay-vs-overlay (and overlay-vs-activity) case above.
//
// Dangling location ids (resolve to nothing in `locations`) are treated as
// unconstrained here too, matching placeBlocked's treatment in
// buildSchedule.js — the two paths must agree, since disagreement is exactly
// what let a stale/deleted location id report a conflict labeled by a raw
// UUID instead of being silently unconstrained like real placement is.
import { resolveElectiveOfferingLocations } from './electiveOccupancy.js'

export function findRouteConflicts({ slots, activities, anchors, electiveSetActivities, events, locations }) {
  const activityById = new Map((activities || []).map((a) => [a.id, a]))
  const anchorById = new Map((anchors || []).map((a) => [a.id, a]))
  const eventById = new Map((events || []).map((e) => [e.id, e]))
  const locationById = new Map((locations || []).map((l) => [l.id, l]))
  const electiveOfferingsBySetId = new Map()
  for (const m of (electiveSetActivities || [])) {
    if (!electiveOfferingsBySetId.has(m.elective_set_id)) electiveOfferingsBySetId.set(m.elective_set_id, [])
    electiveOfferingsBySetId.get(m.elective_set_id).push(m.activity_id)
  }

  const occupancy = new Map() // "locationId|dayId|blockId" -> [{ groupId, cohortId, label, sourceKind, sourceId }]
  function register(locId, dayId, blockId, groupId, cohortId, label, sourceKind, sourceId) {
    if (locId == null) return
    const key = `${locId}|${dayId}|${blockId}`
    const list = occupancy.get(key) || []
    list.push({ groupId, cohortId: cohortId ?? null, label, sourceKind, sourceId })
    occupancy.set(key, list)
  }

  for (const slot of (slots || [])) {
    if (slot.type === 'activity' && slot.activityId != null) {
      const act = activityById.get(slot.activityId)
      if (act?.location_id != null) {
        register(act.location_id, slot.dayId, slot.blockId, slot.groupId, slot.cohort_id, act.name || slot.activityId, 'activity', slot.activityId)
      }
    } else if (slot.type === 'anchor' && slot.anchorId != null) {
      const anchor = anchorById.get(slot.anchorId)
      if (anchor?.location_id != null) {
        register(anchor.location_id, slot.dayId, slot.blockId, slot.groupId, slot.cohort_id, anchor.name || 'an anchor', 'anchor', slot.anchorId)
      }
    } else if (slot.type === 'event' && slot.eventId != null) {
      const ev = eventById.get(slot.eventId)
      if (ev?.location_id != null) {
        register(ev.location_id, slot.dayId, slot.blockId, slot.groupId, slot.cohort_id, ev.name || 'an event', 'event', slot.eventId)
      }
    } else if (slot.type === 'elective' && slot.electiveSetId != null) {
      const offeringLocations = resolveElectiveOfferingLocations(electiveOfferingsBySetId.get(slot.electiveSetId), activityById)
      for (const [locId, label] of offeringLocations) {
        register(locId, slot.dayId, slot.blockId, slot.groupId, slot.cohort_id, label, 'elective', slot.electiveSetId)
      }
    }
  }

  const conflicts = []
  for (const key of [...occupancy.keys()].sort()) {
    const occupants = occupancy.get(key)

    const [locationId, dayId, blockId] = key.split('|')
    const loc = locationById.get(locationId)
    if (!loc) continue // dangling location id — unconstrained, matches placeBlocked (buildSchedule.js)
    const capacity = loc.capacity > 0 ? loc.capacity : 1
    if (occupants.length <= capacity) continue

    conflicts.push({
      kind: 'OUTER_RESOURCE_CONFLICT',
      locationId,
      locationName: loc?.name || locationId,
      dayId,
      blockId,
      capacity,
      occupants: [...occupants]
        .map((o) => ({ groupId: o.groupId, cohortId: o.cohortId, label: o.label, sourceKind: o.sourceKind, sourceId: o.sourceId }))
        .sort((a, b) => (a.groupId || '').localeCompare(b.groupId || '')),
    })
  }
  return conflicts
}
