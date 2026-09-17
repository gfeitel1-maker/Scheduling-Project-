import { describe, it, expect } from 'vitest'
import { findRouteConflicts } from './routeConflicts.js'

// Shared fixture atoms
const loc1 = { id: 'loc1', name: 'Waterfront', capacity: 1 }
const loc2Cap2 = { id: 'loc2', name: 'Field', capacity: 2 }

function activitySlot({ groupId, cohort_id, activityId, dayId = 'd1', blockId = 'b1' }) {
  return { groupId, dayId, blockId, cohort_id, type: 'activity', activityId, anchorId: null }
}
function anchorSlot({ groupId, cohort_id, anchorId, dayId = 'd1', blockId = 'b1' }) {
  return { groupId, dayId, blockId, cohort_id, type: 'anchor', activityId: null, anchorId }
}
function eventSlot({ groupId, cohort_id, eventId, dayId = 'd1', blockId = 'b1' }) {
  return { groupId, dayId, blockId, cohort_id, type: 'event', activityId: null, anchorId: null, eventId }
}
function electiveSlot({ groupId, cohort_id, electiveSetId, dayId = 'd1', blockId = 'b1' }) {
  return { groupId, dayId, blockId, cohort_id, type: 'elective', activityId: null, anchorId: null, electiveSetId }
}

describe('findRouteConflicts', () => {
  it('flags two regular activities from different cohorts placed in the same over-capacity location', () => {
    const activities = [
      { id: 'act1', name: 'Swim', location_id: 'loc1' },
      { id: 'act2', name: 'Kayak', location_id: 'loc1' },
    ]
    const slots = [
      activitySlot({ groupId: 'g1', cohort_id: 'c1', activityId: 'act1' }),
      activitySlot({ groupId: 'g2', cohort_id: 'c2', activityId: 'act2' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities: [], events: [], locations: [loc1] })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('OUTER_RESOURCE_CONFLICT')
    expect(conflicts[0].locationId).toBe('loc1')
    expect(conflicts[0].dayId).toBe('d1')
    expect(conflicts[0].blockId).toBe('b1')
    const groupIds = conflicts[0].occupants.map((o) => o.groupId).sort()
    expect(groupIds).toEqual(['g1', 'g2'])
    // Actionable: a director must be able to open what put each occupant there.
    const bySource = Object.fromEntries(conflicts[0].occupants.map((o) => [o.sourceId, o.sourceKind]))
    expect(bySource.act1).toBe('activity')
    expect(bySource.act2).toBe('activity')
  })

  it('flags an anchor in one cohort colliding with an elective offering in another cohort', () => {
    const anchors = [{ id: 'anc1', name: 'Lunch', location_id: 'loc1' }]
    const activities = [{ id: 'offering1', name: 'Waterfront Swim', location_id: 'loc1' }]
    const electiveSetActivities = [{ elective_set_id: 'es1', activity_id: 'offering1' }]
    const slots = [
      anchorSlot({ groupId: 'g1', cohort_id: 'c1', anchorId: 'anc1' }),
      electiveSlot({ groupId: 'g2', cohort_id: 'c2', electiveSetId: 'es1' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors, electiveSetActivities, events: [], locations: [loc1] })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].occupants.map((o) => o.groupId).sort()).toEqual(['g1', 'g2'])
    // Actionable: each occupant names what put it there, not just a group id.
    expect(conflicts[0].occupants.some((o) => /lunch/i.test(o.label))).toBe(true)
    expect(conflicts[0].occupants.some((o) => /waterfront swim/i.test(o.label))).toBe(true)
    const bySource = Object.fromEntries(conflicts[0].occupants.map((o) => [o.sourceKind, o.sourceId]))
    expect(bySource.anchor).toBe('anc1')
    expect(bySource.elective).toBe('es1')
  })

  it('flags an event in one cohort colliding with a regular activity in another', () => {
    const activities = [{ id: 'act1', name: 'Archery', location_id: 'loc1' }]
    const events = [{ id: 'ev1', name: 'Color War', location_id: 'loc1' }]
    const slots = [
      eventSlot({ groupId: 'g1', cohort_id: 'c1', eventId: 'ev1' }),
      activitySlot({ groupId: 'g2', cohort_id: 'c2', activityId: 'act1' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities: [], events, locations: [loc1] })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].occupants.map((o) => o.groupId).sort()).toEqual(['g1', 'g2'])
  })

  it('off-by-one: capacity 2 with 3 cross-cohort occupants conflicts', () => {
    const activities = [{ id: 'act1', name: 'Field Games', location_id: 'loc2' }]
    const slots = [
      activitySlot({ groupId: 'g1', cohort_id: 'c1', activityId: 'act1' }),
      activitySlot({ groupId: 'g2', cohort_id: 'c2', activityId: 'act1' }),
      activitySlot({ groupId: 'g3', cohort_id: 'c3', activityId: 'act1' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities: [], events: [], locations: [loc2Cap2] })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].occupants).toHaveLength(3)
  })

  it('off-by-one: capacity 2 with exactly 2 cross-cohort occupants does NOT conflict', () => {
    const activities = [{ id: 'act1', name: 'Field Games', location_id: 'loc2' }]
    const slots = [
      activitySlot({ groupId: 'g1', cohort_id: 'c1', activityId: 'act1' }),
      activitySlot({ groupId: 'g2', cohort_id: 'c2', activityId: 'act1' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities: [], events: [], locations: [loc2Cap2] })

    expect(conflicts).toHaveLength(0)
  })

  it('does not report a false positive when two offerings of the SAME elective set share one location for one group in one cohort', () => {
    const activities = [
      { id: 'swim', name: 'Swim', location_id: 'loc1' },
      { id: 'kayak', name: 'Kayak', location_id: 'loc1' },
    ]
    const electiveSetActivities = [
      { elective_set_id: 'es1', activity_id: 'swim' },
      { elective_set_id: 'es1', activity_id: 'kayak' },
    ]
    // Only one cohort involved, one group — the dedup rule must collapse the
    // two offerings sharing loc1 into a single occupant, not two.
    const slots = [
      electiveSlot({ groupId: 'g1', cohort_id: 'c1', electiveSetId: 'es1' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities, events: [], locations: [loc1] })

    expect(conflicts).toHaveLength(0)
  })

  // The general rule is combined occupancy vs. capacity, not "which cohorts
  // are involved" — cross-cohort was never the whole rule, only the subset
  // that was easy to see. Regular-activity placement itself never produces
  // this shape in a real schedule (canPlace/placeUsage already bound it to
  // capacity — see "false positives" describe block below) but the fixture
  // proves the validator no longer special-cases same-cohort occupancy away.
  it('flags over-capacity occupancy even within a single cohort', () => {
    const activities = [{ id: 'act1', name: 'Swim', location_id: 'loc1' }]
    const slots = [
      activitySlot({ groupId: 'g1', cohort_id: 'c1', activityId: 'act1' }),
      activitySlot({ groupId: 'g2', cohort_id: 'c1', activityId: 'act1' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities: [], events: [], locations: [loc1] })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].occupants.map((o) => o.groupId).sort()).toEqual(['g1', 'g2'])
  })

  // The blind spot this ticket closes: registerOverlayOccupancy (anchors,
  // events, elective offerings) runs unconditionally, but placeBlocked is
  // only consulted for regular-activity placement — so two overlays can be
  // authored into the same location/day/block over capacity, in ONE cohort,
  // and nothing flagged it before this fix.
  it('flags two overlays (an event and an elective offering) over capacity in the SAME cohort', () => {
    const events = [{ id: 'ev1', name: 'Color War', location_id: 'loc1' }]
    const activities = [{ id: 'offering1', name: 'Waterfront Swim', location_id: 'loc1' }]
    const electiveSetActivities = [{ elective_set_id: 'es1', activity_id: 'offering1' }]
    const slots = [
      eventSlot({ groupId: 'g1', cohort_id: 'c1', eventId: 'ev1' }),
      electiveSlot({ groupId: 'g2', cohort_id: 'c1', electiveSetId: 'es1' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities, events, locations: [loc1] })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].occupants.map((o) => o.groupId).sort()).toEqual(['g1', 'g2'])
  })

  // Matches placeBlocked (buildSchedule.js): a location_id that resolves to
  // nothing in `locations` (deleted place, cross-device race, stale import)
  // is unconstrained, not floored to capacity 1. The validator must agree.
  it('does not flag occupancy at a dangling location id that no longer resolves', () => {
    const activities = [
      { id: 'act1', name: 'Swim', location_id: 'ghost-loc' },
      { id: 'act2', name: 'Kayak', location_id: 'ghost-loc' },
    ]
    const slots = [
      activitySlot({ groupId: 'g1', cohort_id: 'c1', activityId: 'act1' }),
      activitySlot({ groupId: 'g2', cohort_id: 'c2', activityId: 'act2' }),
    ]

    const conflicts = findRouteConflicts({ slots, activities, anchors: [], electiveSetActivities: [], events: [], locations: [] })

    expect(conflicts).toHaveLength(0)
  })

  it('is deterministic across repeated calls with the same input', () => {
    const activities = [
      { id: 'act1', name: 'Swim', location_id: 'loc1' },
      { id: 'act2', name: 'Kayak', location_id: 'loc1' },
    ]
    const slots = [
      activitySlot({ groupId: 'g2', cohort_id: 'c2', activityId: 'act2' }),
      activitySlot({ groupId: 'g1', cohort_id: 'c1', activityId: 'act1' }),
    ]
    const args = { slots, activities, anchors: [], electiveSetActivities: [], events: [], locations: [loc1] }

    expect(findRouteConflicts(args)).toEqual(findRouteConflicts(args))
  })
})
