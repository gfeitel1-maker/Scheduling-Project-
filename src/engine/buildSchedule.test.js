import { describe, it, expect } from 'vitest'
import buildSchedule, { computeFindings } from './buildSchedule.js'

const baseGroup = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }
const baseDay = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const baseBlock = { id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:15', sort_order: 0, part_of_day: 'morning' }

function minimal(overrides = {}) {
  return {
    groups: [baseGroup],
    tiers: [{ id: 't1', name: 'Junior' }],
    days: [baseDay],
    timeBlocks: [baseBlock],
    activities: [],
    anchors: [],
    campId: 'test',
    ...overrides,
  }
}

describe('anchored activities excluded from regular placement', () => {
  it('never places an anchored activity as a regular slot, only via its anchor', () => {
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const block2 = { id: 'b2', name: 'Late Morning', start_time: '10:30', end_time: '11:45', sort_order: 1, part_of_day: 'morning' }
    const lunch = { id: 'lunch', name: 'Lunch', priority: 'high', max_per_week: 10, min_per_week: 2, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const anchor = { id: 'anc1', activity_id: 'lunch', unit_id: null, is_all_groups: true, group_ids: [], day_id: null, time_block_id: 'b1', span_blocks: 1 }
    const { slots } = buildSchedule(minimal({ days: [baseDay, day2], timeBlocks: [baseBlock, block2], activities: [lunch], anchors: [anchor] }))

    const regularLunchSlots = slots.filter(s => s.type === 'activity' && s.activityId === 'lunch')
    expect(regularLunchSlots).toHaveLength(0)

    const anchorSlots = slots.filter(s => s.type === 'anchor' && s.anchorId === 'anc1')
    expect(anchorSlots.length).toBeGreaterThan(0)
  })

  it('still places an activity not referenced by any anchor', () => {
    const archery = { id: 'archery', name: 'Archery', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const { slots } = buildSchedule(minimal({ activities: [archery], anchors: [] }))
    const placed = slots.filter(s => s.type === 'activity' && s.activityId === 'archery')
    expect(placed.length).toBeGreaterThan(0)
  })
})

// T41 slice 1 (group-level electives,
// docs/work/specs/2026-08-20-group-electives-design.md): an elective cell is
// authored content, never engine output — mirrors the anchor-skip test above
// (T62 closed anchor double-scheduling the same way).
describe('elective cells excluded from regular placement (engine-skip)', () => {
  it('never places an activity into a cell carrying an electiveSetId, and does not count it unfilled', () => {
    const archery = { id: 'archery', name: 'Archery', priority: 'high', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', electiveSetId: 'es1' }]
    const { slots } = buildSchedule(minimal({ activities: [archery], preplacedSlots }))

    const cell = slots.find(s => s.groupId === 'g1' && s.dayId === 'd1' && s.blockId === 'b1')
    expect(cell).toBeTruthy()
    expect(cell.type).toBe('elective')
    expect(cell.activityId).toBeNull()
    expect(cell.electiveSetId).toBe('es1')
    // Not counted unfilled: no UNFILLABLE flag on the elective cell.
    expect(cell.flags?.UNFILLABLE).toBeFalsy()

    // No regular activity slot was placed at this coordinate.
    const regularAtSameCoord = slots.filter(
      s => s.groupId === 'g1' && s.dayId === 'd1' && s.blockId === 'b1' && s.type === 'activity'
    )
    expect(regularAtSameCoord).toHaveLength(0)
  })

  it('still places an activity in a block not marked as an elective', () => {
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const block2 = { id: 'b2', name: 'Late Morning', start_time: '10:30', end_time: '11:45', sort_order: 1, part_of_day: 'morning' }
    const archery = { id: 'archery', name: 'Archery', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', electiveSetId: 'es1' }]
    const { slots } = buildSchedule(minimal({
      days: [baseDay, day2], timeBlocks: [baseBlock, block2], activities: [archery], preplacedSlots,
    }))

    const placed = slots.filter(s => s.type === 'activity' && s.activityId === 'archery')
    expect(placed.length).toBeGreaterThan(0)
  })
})

describe('UNFILLABLE flag', () => {
  it('sets UNFILLABLE_reason when no activities are eligible', () => {
    const { slots } = buildSchedule(minimal({ activities: [] }))
    const unfillable = slots.find(s => s.flags?.UNFILLABLE)
    expect(unfillable).toBeTruthy()
    expect(unfillable.flags.UNFILLABLE_reason).toBe('No eligible activity could be placed in this slot')
  })
})

describe("'unavailable' slot type", () => {
  it('emits type "unavailable" for a group whose availability excludes the block\'s part_of_day', () => {
    const restrictedGroup = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'afternoon' }
    const { slots } = buildSchedule(minimal({ groups: [restrictedGroup], activities: [] }))
    const unavailable = slots.filter(s => s.type === 'unavailable')
    expect(unavailable.length).toBe(1)
    expect(unavailable[0]).toMatchObject({ groupId: 'g1', activityId: null, anchorId: null })
  })
})

describe('WEATHER_RISK', () => {
  it('is no longer emitted anywhere in flags — outdoor exposure is read at render time from activity.is_outdoor', () => {
    const act = { id: 'a1', name: 'Swimming', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: true, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const { slots } = buildSchedule(minimal({ activities: [act] }))
    expect(slots.some(s => s.flags?.WEATHER_RISK)).toBe(false)
  })
})

describe('UNDERSERVED finding', () => {
  it('emits a single aggregate finding (not per-slot stamps) when min_per_week cannot be met', () => {
    // 1 block available, min_per_week = 3 → underserved
    const act = { id: 'a1', name: 'Archery', priority: 'low', max_per_week: 5, min_per_week: 3, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const { slots, findings } = buildSchedule(minimal({ activities: [act] }))

    expect(slots.some(s => s.flags?.UNDERSERVED)).toBe(false)

    const underservedFindings = findings.filter(f => f.kind === 'UNDERSERVED')
    expect(underservedFindings).toHaveLength(1)
    const finding = underservedFindings[0]
    expect(finding.groupId).toBe('g1')
    expect(finding.activityId).toBe('a1')
    expect(finding.severity).toBe('caution')
    expect(finding.got).toBe(1)
    expect(finding.needed).toBe(3)
    expect(finding.reason).toMatch(/Goal: 3×\/wk/)
    expect(finding.reason).toMatch(/Aleph/)
    expect(finding.reason).toMatch(/Archery/)
  })
})

describe('DISTRIBUTION finding', () => {
  it('emits a single aggregate finding (not per-slot stamps) when early-week goal not met', () => {
    // 2 days, prefer 2× before day_of_week=2 (Tuesday), but activity placed both Mon+Tue
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const act = { id: 'a1', name: 'Arts', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: 2, prefer_before_day_min: 2 }
    const { slots, findings } = buildSchedule(minimal({ days: [baseDay, day2], activities: [act] }))

    expect(slots.some(s => s.flags?.DISTRIBUTION)).toBe(false)

    const distFindings = findings.filter(f => f.kind === 'DISTRIBUTION')
    expect(distFindings).toHaveLength(1)
    const finding = distFindings[0]
    expect(finding.groupId).toBe('g1')
    expect(finding.activityId).toBe('a1')
    expect(finding.severity).toBe('info')
    expect(finding.reason).toMatch(/Goal: 2×/)
    expect(finding.reason).toMatch(/Arts/)
    expect(finding.reason).toMatch(/Aleph/)
  })
})

// Round 2 B2: loadAll()/restoreSnapshot() in ScheduleScreen never called
// buildSchedule(), so findings badges silently read 0/empty ("all clear")
// for an existing schedule that was never regenerated in this session.
// computeFindings() is a placement-free extraction of buildSchedule's Pass 3
// aggregate-findings logic — it takes already-persisted template_slots rows
// (snake_case DB shape) and recomputes UNDERSERVED/DISTRIBUTION without
// re-placing anything.
describe('computeFindings (placement-free recompute from persisted slots)', () => {
  const groups = [baseGroup]
  const days = [baseDay]

  it('emits UNDERSERVED when persisted slots show fewer placements than min_per_week', () => {
    const act = { id: 'a1', name: 'Archery', min_per_week: 3, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, flags: {} },
    ]
    const findings = computeFindings({ slots, groups, activities: [act], days })
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('UNDERSERVED')
    expect(findings[0].groupId).toBe('g1')
    expect(findings[0].activityId).toBe('a1')
    expect(findings[0].got).toBe(1)
    expect(findings[0].needed).toBe(3)
  })

  it('emits no findings when persisted counts already meet min_per_week', () => {
    const act = { id: 'a1', name: 'Archery', min_per_week: 1, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, flags: {} },
    ]
    expect(computeFindings({ slots, groups, activities: [act], days })).toHaveLength(0)
  })

  it('emits DISTRIBUTION when persisted placements land after the prefer_before_day target', () => {
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const act = { id: 'a1', name: 'Arts', min_per_week: 0, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: 2, prefer_before_day_min: 1 }
    // Only placement is ON day2 (Tuesday itself), not strictly before it.
    const slots = [
      { group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, flags: {} },
    ]
    const findings = computeFindings({ slots, groups, activities: [act], days: [baseDay, day2] })
    expect(findings.filter(f => f.kind === 'DISTRIBUTION')).toHaveLength(1)
  })

  it('ignores anchor slots and empty slots when counting placements', () => {
    const act = { id: 'a1', name: 'Archery', min_per_week: 1, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: true, flags: {} },
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, is_anchor: false, flags: {} },
    ]
    const findings = computeFindings({ slots, groups, activities: [act], days })
    expect(findings.filter(f => f.kind === 'UNDERSERVED')).toHaveLength(1)
    expect(findings[0].got).toBe(0)
  })

  // A merged/spanned activity persists as one head row plus one tail row per
  // extra block. buildSchedule counts it once (head only); computeFindings must
  // agree, or reloading the app silently inflates counts and hides a real
  // UNDERSERVED warning.
  it('counts a spanned activity once, not once per block it occupies', () => {
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const act = { id: 'a1', name: 'Swim', min_per_week: 4, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    // Two 2-block swims = 2 placements, not 4.
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, is_span_head: true, flags: {} },
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'a1', is_anchor: false, is_span_head: false, flags: {} },
      { group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, is_span_head: true, flags: {} },
      { group_id: 'g1', day_id: 'd2', time_block_id: 'b2', activity_id: 'a1', is_anchor: false, is_span_head: false, flags: {} },
    ]
    const findings = computeFindings({ slots, groups, activities: [act], days: [baseDay, day2] })
    const underserved = findings.filter(f => f.kind === 'UNDERSERVED')
    expect(underserved).toHaveLength(1)
    expect(underserved[0].got).toBe(2)
  })

  // Slots persisted before is_span_head existed have it undefined; those must
  // still count, or every legacy schedule reads as empty.
  it('counts slots with is_span_head undefined (pre-migration rows)', () => {
    const act = { id: 'a1', name: 'Archery', min_per_week: 3, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, flags: {} },
    ]
    const findings = computeFindings({ slots, groups, activities: [act], days })
    expect(findings[0].got).toBe(1)
  })

  it('excludes span tails from DISTRIBUTION before-day counting', () => {
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const act = { id: 'a1', name: 'Arts', min_per_week: 0, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: 2, prefer_before_day_min: 2 }
    // One 2-block placement on Monday = 1 before the target, short of 2.
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, is_span_head: true, flags: {} },
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'a1', is_anchor: false, is_span_head: false, flags: {} },
    ]
    const findings = computeFindings({ slots, groups, activities: [act], days: [baseDay, day2] })
    expect(findings.filter(f => f.kind === 'DISTRIBUTION')).toHaveLength(1)
  })

  it('returns [] when required inputs are missing rather than throwing', () => {
    expect(computeFindings({})).toEqual([])
  })
})

describe('preplacedSlots (locking)', () => {
  it('keeps a preplaced slot even when another activity would be preferred', () => {
    const swim = { id: 'a1', name: 'Swimming', priority: 'high', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const arch = { id: 'a2', name: 'Archery', priority: 'high', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const preplaced = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'a2' }]
    const { slots } = buildSchedule(minimal({ activities: [swim, arch], preplacedSlots: preplaced }))
    const slot = slots.find(s => s.groupId === 'g1' && s.dayId === 'd1' && s.blockId === 'b1')
    expect(slot?.activityId).toBe('a2')
  })

  it('counts preplaced slots toward usageCount', () => {
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const block2 = { id: 'b2', name: 'Afternoon', start_time: '14:00', end_time: '15:30', sort_order: 1, part_of_day: 'afternoon' }
    const swim = { id: 'a1', name: 'Swimming', priority: 'low', max_per_week: 1, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const preplaced = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'a1' }]
    const { slots } = buildSchedule(minimal({ days: [baseDay, day2], timeBlocks: [baseBlock, block2], activities: [swim], preplacedSlots: preplaced }))
    const swimSlots = slots.filter(s => s.activityId === 'a1')
    expect(swimSlots.length).toBe(1) // only the preplaced one, max_per_week=1 exhausted
  })

  it('ignores preplacedSlots param when undefined', () => {
    const act = { id: 'a1', name: 'Swimming', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    expect(() => buildSchedule(minimal({ activities: [act] }))).not.toThrow()
  })

  it('populates locationUsage for preplaced slots so capacity is respected', () => {
    // Pool has max_groups_per_slot = 2. Preplaced one group. Another group should fill the same slot (capacity allows it).
    // A third group should NOT be placed there if capacity would be exceeded.
    const g2 = { id: 'g2', name: 'Bet', tier_id: 't1', availability: 'all' }
    const g3 = { id: 'g3', name: 'Gimel', tier_id: 't1', availability: 'all' }
    const pool = {
      id: 'a1', name: 'Pool', priority: 'high', max_per_week: 5, min_per_week: 0,
      is_outdoor: false, location: 'pool', max_groups_per_slot: 2, same_tier_only: false,
      eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null
    }
    const preplaced = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'a1' }]
    const { slots } = buildSchedule({
      groups: [baseGroup, g2, g3],
      tiers: [{ id: 't1', name: 'Junior' }],
      days: [baseDay],
      timeBlocks: [baseBlock],
      activities: [pool],
      anchors: [],
      campId: 'test',
      preplacedSlots: preplaced,
    })
    // g1 is preplaced at d1/b1. g2 should also get pool there (capacity=2). g3 should NOT.
    const poolSlotsAtB1 = slots.filter(s => s.activityId === 'a1' && s.dayId === 'd1' && s.blockId === 'b1')
    expect(poolSlotsAtB1.length).toBe(2) // g1 (preplaced) + g2, not g3
    expect(poolSlotsAtB1.map(s => s.groupId).sort()).toEqual(['g1', 'g2'].sort())
  })
})

// M2 — place capacity is a property of the PLACE, read from locations.capacity
// and keyed by activity.location_id (NOT the free-text `location` string, NOT
// whichever activity was placed first). See ADR D2
// (docs/adr/2026-08-15-camp-locations-entity.md) and assessment §3.2.
describe('place capacity keyed by location_id (M2)', () => {
  const mDay = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
  const mBlock = { id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:00', sort_order: 0, part_of_day: 'morning' }
  const grp = (id, tierId = 't1') => ({ id, name: id, tier_id: tierId, availability: 'all' })
  const mAct = (over = {}) => ({
    id: 'a', name: 'A', priority: 'low', max_per_week: 5, min_per_week: 0, span_blocks: 1,
    is_outdoor: false, location: null, location_id: null, max_groups_per_slot: 1, same_tier_only: false,
    eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null,
    ...over,
  })

  function run({ activities, locations = [], groups, tiers = [{ id: 't1', name: 'Junior' }] }) {
    return buildSchedule({
      groups, tiers, days: [mDay], timeBlocks: [mBlock],
      activities, anchors: [], campId: 'test', locations,
    })
  }

  // Groups placed into ANY of the given activities at d1/b1 — i.e. total
  // occupancy of the place those activities share, regardless of which one.
  function groupsAtPlace(slots, activityIds) {
    const set = new Set(activityIds)
    return slots.filter(s => s.type === 'activity' && s.dayId === 'd1' && s.blockId === 'b1' && set.has(s.activityId)).length
  }

  // THE CORE FIX. Two activities share one place capped at 1; they declare
  // different max_groups_per_slot. The place must never hold more than its
  // capacity, no matter which activity the engine happens to place first.
  // (Assessment §3.2 CASE A/B: today the string path lets 3 groups into a
  // cap-1 pool in one ordering and starves the other.)
  it('caps a shared place at locations.capacity, independent of placement order', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Pool', capacity: 1 }]
    const groups = [grp('g1'), grp('g2'), grp('g3'), grp('g4')]
    const swim = mAct({ id: 'a1', name: 'Swim Lessons', location_id: 'L', max_groups_per_slot: 1 })
    const free = mAct({ id: 'a2', name: 'Free Swim', location_id: 'L', max_groups_per_slot: 3 })
    const both = ['a1', 'a2']

    const orderingA = run({ activities: [{ ...swim, priority: 'high' }, { ...free, priority: 'low' }], locations, groups })
    const orderingB = run({ activities: [{ ...free, priority: 'high' }, { ...swim, priority: 'low' }], locations, groups })

    expect(groupsAtPlace(orderingA.slots, both)).toBeLessThanOrEqual(1)
    expect(groupsAtPlace(orderingB.slots, both)).toBeLessThanOrEqual(1)
  })

  it('a place with capacity 3 shared by two activities holds 3 groups total — not 3 per activity', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Court', capacity: 3 }]
    const groups = [grp('g1'), grp('g2'), grp('g3'), grp('g4'), grp('g5')]
    const a1 = mAct({ id: 'a1', location_id: 'L', max_groups_per_slot: 3, priority: 'high' })
    const a2 = mAct({ id: 'a2', location_id: 'L', max_groups_per_slot: 3, priority: 'low' })
    const { slots } = run({ activities: [a1, a2], locations, groups })
    expect(groupsAtPlace(slots, ['a1', 'a2'])).toBe(3)
  })

  // Interim state (M1→M3): the picker that sets location_id is M3, so activities
  // still carry only a free-text `location`. An activity with location_id null
  // gets NO place-capacity constraint — max_groups_per_slot still applies per
  // activity (and, per ADR D2, is no longer dead when no place is set).
  it('an activity with location_id null has no place constraint; max_groups_per_slot still caps it per activity', () => {
    const groups = [grp('g1'), grp('g2'), grp('g3')]
    const a1 = mAct({ id: 'a1', location: null, location_id: null, max_groups_per_slot: 2, priority: 'high' })
    const { slots } = run({ activities: [a1], locations: [], groups })
    const placed = slots.filter(s => s.type === 'activity' && s.activityId === 'a1')
    expect(placed.length).toBe(2)
  })

  // same_tier_only exercised WITH a shared place (assessment gap 5 — untested
  // today, and the only branch that reads same_tier_only never ran without a
  // location). Capacity would allow 3, but the activity refuses to share the
  // place with a different tier, so the second (cross-tier) group is blocked.
  it('same_tier_only blocks a cross-tier group from a shared place even under capacity', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Studio', capacity: 3 }]
    const groups = [grp('g1', 't1'), grp('g2', 't2')]
    const tiers = [{ id: 't1', name: 'Junior' }, { id: 't2', name: 'Senior' }]
    const a1 = mAct({ id: 'a1', location_id: 'L', max_groups_per_slot: 3, same_tier_only: true, priority: 'high' })
    const { slots } = run({ activities: [a1], locations, groups, tiers })
    const placed = slots.filter(s => s.type === 'activity' && s.activityId === 'a1')
    expect(placed.length).toBe(1)
  })

  it('is deterministic: identical inputs including locations produce byte-identical slots', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Pool', capacity: 2 }]
    const groups = [grp('g1'), grp('g2'), grp('g3')]
    const a1 = mAct({ id: 'a1', location_id: 'L', max_groups_per_slot: 2, priority: 'high' })
    const a2 = mAct({ id: 'a2', location_id: null, max_groups_per_slot: 1, priority: 'low' })
    const r1 = run({ activities: [a1, a2], locations, groups })
    const r2 = run({ activities: [a1, a2], locations, groups })
    expect(JSON.stringify(r1.slots)).toBe(JSON.stringify(r2.slots))
  })
})

// M3a round-2 (both reviewers converged) — capacity-lookup robustness.
// FIX 1: an activity's location_id that resolves to NOTHING in `locations`
// (a deleted place, a dangling reference from a cross-device race, or a
// stale import) must be treated exactly like location_id: null — no
// place-capacity constraint — not silently pinned to capacity 1 by `?? 1`.
// FIX 2: a stored `locations.capacity` of 0 or negative must not block all
// placement; it floors to 1, consistent with M1's migration and the
// CapacityStepper's min.
describe('capacity-lookup robustness (M3a round-2)', () => {
  const mDay = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
  const mBlock = { id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:00', sort_order: 0, part_of_day: 'morning' }
  const grp = (id, tierId = 't1') => ({ id, name: id, tier_id: tierId, availability: 'all' })
  const mAct = (over = {}) => ({
    id: 'a', name: 'A', priority: 'low', max_per_week: 5, min_per_week: 0, span_blocks: 1,
    is_outdoor: false, location: null, location_id: null, max_groups_per_slot: 5, same_tier_only: false,
    eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null,
    ...over,
  })

  function run({ activities, locations = [], groups, tiers = [{ id: 't1', name: 'Junior' }] }) {
    return buildSchedule({
      groups, tiers, days: [mDay], timeBlocks: [mBlock],
      activities, anchors: [], campId: 'test', locations,
    })
  }

  function groupsAtPlace(slots, activityIds) {
    const set = new Set(activityIds)
    return slots.filter(s => s.type === 'activity' && s.dayId === 'd1' && s.blockId === 'b1' && set.has(s.activityId)).length
  }

  it('a location_id absent from locations is unconstrained, not capacity 1', () => {
    const groups = [grp('g1'), grp('g2'), grp('g3')]
    const a1 = mAct({ id: 'a1', location_id: 'ghost', max_groups_per_slot: 3, priority: 'high' })
    const { slots } = run({ activities: [a1], locations: [], groups })
    expect(groupsAtPlace(slots, ['a1'])).toBe(3)
  })

  it('emits a finding for an activity bound to a non-existent location', () => {
    const groups = [grp('g1')]
    const a1 = mAct({ id: 'a1', name: 'Ghost Activity', location_id: 'ghost', max_groups_per_slot: 1, priority: 'high' })
    const { findings } = run({ activities: [a1], locations: [], groups })
    expect(findings.some(f => f.kind === 'DANGLING_LOCATION' && f.activityId === 'a1')).toBe(true)
  })

  it('a real, mapped location_id still enforces its capacity (control, unchanged)', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Pool', capacity: 1 }]
    const groups = [grp('g1'), grp('g2'), grp('g3')]
    const a1 = mAct({ id: 'a1', location_id: 'L', max_groups_per_slot: 3, priority: 'high' })
    const { slots, findings } = run({ activities: [a1], locations, groups })
    expect(groupsAtPlace(slots, ['a1'])).toBe(1)
    expect(findings.some(f => f.kind === 'DANGLING_LOCATION')).toBe(false)
  })

  it('a stored capacity of 0 does not block all placement — floors to 1', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Broken', capacity: 0 }]
    const groups = [grp('g1'), grp('g2')]
    const a1 = mAct({ id: 'a1', location_id: 'L', max_groups_per_slot: 2, priority: 'high' })
    const { slots } = run({ activities: [a1], locations, groups })
    expect(groupsAtPlace(slots, ['a1'])).toBe(1)
  })

  it('a stored capacity of -1 also floors to 1', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Broken', capacity: -1 }]
    const groups = [grp('g1'), grp('g2')]
    const a1 = mAct({ id: 'a1', location_id: 'L', max_groups_per_slot: 2, priority: 'high' })
    const { slots } = run({ activities: [a1], locations, groups })
    expect(groupsAtPlace(slots, ['a1'])).toBe(1)
  })

  it('is deterministic with a dangling location_id', () => {
    const groups = [grp('g1'), grp('g2')]
    const a1 = mAct({ id: 'a1', location_id: 'ghost', max_groups_per_slot: 2, priority: 'high' })
    const r1 = run({ activities: [a1], locations: [], groups })
    const r2 = run({ activities: [a1], locations: [], groups })
    expect(JSON.stringify(r1.slots)).toBe(JSON.stringify(r2.slots))
  })
})

// M2 round-2 (Red Hat) — a multi-block span occupies its PLACE at every block
// it spans, so canPlace must check place capacity + same_tier_only at each TAIL
// block, not only the head. Previously the span loop checked tail cell-freeness
// but not tail place occupancy, so a span could put a second group into a
// capacity-1 place at its tail (common trigger: lock/anchor a slot in that
// place, then regenerate).
describe('span-tail place capacity (M2 round-2)', () => {
  const d1 = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
  const b1 = { id: 'b1', name: 'Block 1', start_time: '09:00', end_time: '10:00', sort_order: 0, part_of_day: 'morning' }
  const b2 = { id: 'b2', name: 'Block 2', start_time: '10:00', end_time: '11:00', sort_order: 1, part_of_day: 'morning' }
  const grp = (id, tierId = 't1') => ({ id, name: id, tier_id: tierId, availability: 'all' })
  const sAct = (over = {}) => ({
    id: 'a', name: 'A', priority: 'low', max_per_week: 5, min_per_week: 0, span_blocks: 1,
    is_outdoor: false, location: null, location_id: null, max_groups_per_slot: 5, same_tier_only: false,
    eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null,
    ...over,
  })

  function run({ activities, locations = [], groups, tiers = [{ id: 't1', name: 'Junior' }], preplacedSlots = [] }) {
    return buildSchedule({
      groups, tiers, days: [d1], timeBlocks: [b1, b2],
      activities, anchors: [], campId: 'test', locations, preplacedSlots,
    })
  }

  // Occupancy of a PLACE at one (day, block): every activity slot whose
  // activity is bound to that location_id.
  function placeOccupancy(slots, activities, locId, dayId, blockId) {
    const locOf = new Map(activities.map(a => [a.id, a.location_id ?? null]))
    return slots.filter(s => s.type === 'activity' && s.dayId === dayId && s.blockId === blockId && locOf.get(s.activityId) === locId).length
  }

  // CORE PROBE — must FAIL before the fix. Place L (capacity 1) already holds a
  // group at the TAIL block b2 (a preplaced/locked slot). A span (b1→b2) at L
  // for a different group must NOT be placed, because its tail would put a
  // second group into the cap-1 place.
  it('does not place a span whose tail block would overfill a capacity-1 place', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Pool', capacity: 1 }]
    const groups = [grp('g1'), grp('g2')]
    // blocker: only ever preplaced (eligible for no real group), occupies L at b2.
    const blocker = sAct({ id: 'blocker', location_id: 'L', eligible_group_ids: ['none'] })
    const span = sAct({ id: 'span', location_id: 'L', span_blocks: 2, priority: 'high', eligible_group_ids: ['g2'] })
    const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b2', activityId: 'blocker' }]

    const { slots } = run({ activities: [blocker, span], locations, groups, preplacedSlots })

    const spanPlaced = slots.filter(s => s.type === 'activity' && s.activityId === 'span')
    expect(spanPlaced).toHaveLength(0)
    // Place L never exceeds capacity 1 at any block.
    expect(placeOccupancy(slots, [blocker, span], 'L', 'd1', 'b1')).toBeLessThanOrEqual(1)
    expect(placeOccupancy(slots, [blocker, span], 'L', 'd1', 'b2')).toBeLessThanOrEqual(1)
  })

  // same_tier_only at a TAIL block (ADR gap 5's tail case — untested and wrong
  // before the fix). Capacity has slack, but a different-tier tail occupant must
  // still block the span.
  it('blocks a span when same_tier_only conflicts with a different-tier occupant at the tail', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Studio', capacity: 3 }]
    const tiers = [{ id: 't1', name: 'Junior' }, { id: 't2', name: 'Senior' }]
    const groups = [grp('g1', 't1'), grp('g2', 't2')]
    // blocker belongs to g1 (tier t1) and sits in L at the tail block b2.
    const blocker = sAct({ id: 'blocker', location_id: 'L', eligible_group_ids: ['none'] })
    // span for g2 (tier t2), same_tier_only — would share L at b2 with g1 (t1).
    const span = sAct({ id: 'span', location_id: 'L', span_blocks: 2, same_tier_only: true, priority: 'high', eligible_group_ids: ['g2'] })
    const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b2', activityId: 'blocker' }]

    const { slots } = run({ activities: [blocker, span], locations, groups, tiers, preplacedSlots })
    const spanPlaced = slots.filter(s => s.type === 'activity' && s.activityId === 'span')
    expect(spanPlaced).toHaveLength(0)
  })

  // Guard against over-rejection: a span whose tail place has capacity to spare
  // still places.
  it('still places a span when the tail place has capacity to spare', () => {
    const locations = [{ id: 'L', camp_id: 'test', name: 'Pool', capacity: 2 }]
    const groups = [grp('g1'), grp('g2')]
    const blocker = sAct({ id: 'blocker', location_id: 'L', eligible_group_ids: ['none'] })
    const span = sAct({ id: 'span', location_id: 'L', span_blocks: 2, priority: 'high', eligible_group_ids: ['g2'] })
    const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b2', activityId: 'blocker' }]

    const { slots } = run({ activities: [blocker, span], locations, groups, preplacedSlots })
    const spanPlaced = slots.filter(s => s.type === 'activity' && s.activityId === 'span')
    expect(spanPlaced).toHaveLength(2)
    expect(spanPlaced.some(s => s.blockId === 'b1' && s.is_span_head === true)).toBe(true)
    expect(spanPlaced.some(s => s.blockId === 'b2' && s.is_span_head === false)).toBe(true)
    // L at b2 holds blocker (g1) + span tail (g2) = 2, exactly capacity.
    expect(placeOccupancy(slots, [blocker, span], 'L', 'd1', 'b2')).toBe(2)
  })
})

// ── Helpers shared by new tests ──────────────────────────────────────────────

const baseAct = {
  id: 'a1', name: 'Drama', priority: 'low',
  max_per_week: 5, min_per_week: 0,
  span_blocks: 1,
  is_outdoor: false, location: null, max_groups_per_slot: 1,
  same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [],
  prefer_before_day: null, prefer_before_day_min: null,
}

const blockA = { id: 'bA', name: 'Block A', start_time: '09:00', end_time: '09:45', sort_order: 0, part_of_day: 'morning' }
const blockB = { id: 'bB', name: 'Block B', start_time: '09:50', end_time: '10:35', sort_order: 1, part_of_day: 'morning' }
const blockC = { id: 'bC', name: 'Block C', start_time: '10:40', end_time: '11:25', sort_order: 2, part_of_day: 'morning' }

function cohortInput(overrides = {}) {
  return {
    cohorts: [{
      cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
      timeBlocks: [blockA, blockB],
      tiers: [{ id: 't1', name: 'Junior' }],
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      preplacedSlots: [],
      activityTargets: null,
    }],
    days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
    activities: [baseAct],
    campId: 'test',
    ...overrides,
  }
}

// ── Cohorts wrapper ───────────────────────────────────────────────────────────

describe('cohorts array signature', () => {
  it('produces the same output as the legacy flat signature for a single cohort', () => {
    const legacyResult = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'Junior' }],
      days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
      timeBlocks: [blockA],
      activities: [{ ...baseAct }],
      anchors: [],
      campId: 'test',
      preplacedSlots: [],
    })

    const cohortResult = buildSchedule({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
      activities: [{ ...baseAct }],
      campId: 'test',
    })

    // Same slots shape (modulo cohort_id field which is new)
    expect(cohortResult.slots.length).toBe(legacyResult.slots.length)
    expect(cohortResult.slots[0].activityId).toBe(legacyResult.slots[0].activityId)
  })

  it('returns a conflicts array (empty for single-cohort)', () => {
    const result = buildSchedule(cohortInput())
    expect(Array.isArray(result.conflicts)).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  it('slots include cohort_id from the cohort entry', () => {
    const result = buildSchedule(cohortInput())
    const actSlot = result.slots.find(s => s.type === 'activity')
    expect(actSlot?.cohort_id).toBe('cohort1')
  })
})

// ── span_blocks ───────────────────────────────────────────────────────────────

describe('span_blocks', () => {
  it('places a span_blocks=2 activity into two consecutive blocks', () => {
    const swimAct = { ...baseAct, id: 'swim', name: 'Swim', span_blocks: 2, priority: 'high' }
    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA, blockB],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      activities: [swimAct],
    }))

    const swimSlots = result.slots.filter(s => s.activityId === 'swim')
    expect(swimSlots).toHaveLength(2)
    expect(swimSlots.map(s => s.blockId).sort()).toEqual(['bA', 'bB'].sort())
  })

  it('marks only the first block as is_span_head=true', () => {
    const swimAct = { ...baseAct, id: 'swim', name: 'Swim', span_blocks: 2, priority: 'high' }
    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA, blockB],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      activities: [swimAct],
    }))

    const swimSlots = result.slots
      .filter(s => s.activityId === 'swim')
      .sort((a, b) => {
        const order = { bA: 0, bB: 1, bC: 2 }
        return order[a.blockId] - order[b.blockId]
      })

    expect(swimSlots[0].is_span_head).toBe(true)
    expect(swimSlots[1].is_span_head).toBe(false)
  })

  it('does not place a span_blocks=2 activity when the second block is occupied', () => {
    // Two activities: Drama (span=2) and Archery (span=1).
    // Archery is preplaced in blockB, so Drama cannot start at blockA.
    const drama = { ...baseAct, id: 'drama', name: 'Drama', span_blocks: 2, priority: 'low' }
    const archery = { ...baseAct, id: 'arch', name: 'Archery', span_blocks: 1, priority: 'high' }
    const preplaced = [{ groupId: 'g1', dayId: 'd1', blockId: 'bB', activityId: 'arch' }]

    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockA, blockB],
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: preplaced,
        activityTargets: null,
      }],
      activities: [drama, archery],
    }))

    // drama must not appear since blockB is taken and there's no room to start a 2-block span
    const dramaSlots = result.slots.filter(s => s.activityId === 'drama')
    expect(dramaSlots).toHaveLength(0)
  })

  it('does not place a span_blocks=2 activity when only one block remains', () => {
    // Only blockC available (blockA and blockB occupied). span=2 requires 2 consecutive.
    const swim = { ...baseAct, id: 'swim', name: 'Swim', span_blocks: 2, priority: 'high' }

    const result = buildSchedule(cohortInput({
      cohorts: [{
        cohort: { id: 'cohort1', anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [blockC],   // only one block available
        tiers: [{ id: 't1', name: 'Junior' }],
        groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
        preplacedSlots: [],
        activityTargets: null,
      }],
      activities: [swim],
    }))

    const swimSlots = result.slots.filter(s => s.activityId === 'swim')
    expect(swimSlots).toHaveLength(0)
  })

  it('single-block activities still have is_span_head=true', () => {
    const result = buildSchedule(cohortInput())
    const actSlot = result.slots.find(s => s.type === 'activity' && s.activityId)
    expect(actSlot?.is_span_head).toBe(true)
  })
})

// ── Anchor unit_id scope ──────────────────────────────────────────────────────

describe('anchor unit_id scope', () => {
  const g1 = { id: 'g1', name: 'Aleph', tier_id: 'unit1', availability: 'all' }
  const g2 = { id: 'g2', name: 'Bet', tier_id: 'unit1', availability: 'all' }
  const g3 = { id: 'g3', name: 'Gimel', tier_id: 'unit2', availability: 'all' }

  it('unit_id anchor applies to all groups in the matching unit', () => {
    const anchor = { id: 'anc1', name: 'Swim', unit_id: 'unit1', is_all_groups: false, group_ids: [], day_id: 'd1', time_block_id: 'bA', span_blocks: 1 }
    const result = buildSchedule({
      groups: [g1, g2, g3],
      tiers: [{ id: 'unit1', name: 'Unit 1' }, { id: 'unit2', name: 'Unit 2' }],
      days: [baseDay],
      timeBlocks: [blockA],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots.map(s => s.groupId).sort()).toEqual(['g1', 'g2'].sort())
    expect(anchorSlots.some(s => s.groupId === 'g3')).toBe(false)
  })

  it('unit_id takes precedence over is_all_groups=true', () => {
    const anchor = { id: 'anc1', name: 'Swim', unit_id: 'unit1', is_all_groups: true, group_ids: [], day_id: 'd1', time_block_id: 'bA', span_blocks: 1 }
    const result = buildSchedule({
      groups: [g1, g2, g3],
      tiers: [{ id: 'unit1', name: 'Unit 1' }, { id: 'unit2', name: 'Unit 2' }],
      days: [baseDay],
      timeBlocks: [blockA],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots.map(s => s.groupId).sort()).toEqual(['g1', 'g2'].sort())
  })
})

describe('anchor group_ids scope', () => {
  const g1 = { id: 'g1', name: 'Aleph', tier_id: 'unit1', availability: 'all' }
  const g2 = { id: 'g2', name: 'Bet', tier_id: 'unit1', availability: 'all' }
  const g3 = { id: 'g3', name: 'Gimel', tier_id: 'unit2', availability: 'all' }

  it('scopes to the groups named in a raw array group_ids, with no string handling', () => {
    const anchor = { id: 'anc1', name: 'Swim', unit_id: null, is_all_groups: false, group_ids: ['g1', 'g3'], day_id: 'd1', time_block_id: 'bA', span_blocks: 1 }
    const result = buildSchedule({
      groups: [g1, g2, g3],
      tiers: [{ id: 'unit1', name: 'Unit 1' }, { id: 'unit2', name: 'Unit 2' }],
      days: [baseDay],
      timeBlocks: [blockA],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots.map(s => s.groupId).sort()).toEqual(['g1', 'g3'])
    expect(anchorSlots.some(s => s.groupId === 'g2')).toBe(false)
  })
})

// ── Anchor span_blocks ────────────────────────────────────────────────────────

describe('anchor span_blocks', () => {
  const anchorBase = { id: 'anc1', name: 'Theater', is_all_groups: true, group_ids: [], unit_id: null, day_id: 'd1', time_block_id: 'bA' }

  it('span_blocks=2 creates anchor slots for head and tail block', () => {
    const anchor = { ...anchorBase, span_blocks: 2 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots).toHaveLength(2)
    expect(anchorSlots.map(s => s.blockId).sort()).toEqual(['bA', 'bB'].sort())
  })

  it('span_blocks=2: head block has is_span_head=true, tail has is_span_head=false', () => {
    const anchor = { ...anchorBase, span_blocks: 2 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    const head = anchorSlots.find(s => s.blockId === 'bA')
    const tail = anchorSlots.find(s => s.blockId === 'bB')
    expect(head?.is_span_head).toBe(true)
    expect(tail?.is_span_head).toBe(false)
  })

  it('span_blocks=3 marks three consecutive blocks', () => {
    const anchor = { ...anchorBase, span_blocks: 3 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB, blockC],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots).toHaveLength(3)
  })

  it('span_blocks truncates gracefully when not enough blocks remain', () => {
    const anchor = { ...anchorBase, span_blocks: 3 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots).toHaveLength(2)  // span=3, only 2 blocks available → 2 slots
    expect(anchorSlots.find(s => s.blockId === 'bA')?.is_span_head).toBe(true)
    expect(anchorSlots.find(s => s.blockId === 'bB')?.is_span_head).toBe(false)
  })

  it('anchor span tail blocks prevent activity placement', () => {
    const anchor = { ...anchorBase, span_blocks: 2 }
    const act = { id: 'a1', name: 'Drama', priority: 'low', max_per_week: 5, min_per_week: 0, span_blocks: 1, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB, blockC],
      activities: [act],
      anchors: [anchor],
      campId: 'test',
    })
    const dramaSlots = result.slots.filter(s => s.activityId === 'a1')
    expect(dramaSlots.every(s => s.blockId === 'bC')).toBe(true)
  })
})

describe('anchor scope edge cases', () => {
  it('unit_id matching zero groups produces no anchor slots (silent no-op)', () => {
    const anchor = { id: 'anc1', name: 'Swim', unit_id: 'nonexistent_tier', is_all_groups: false, group_ids: [], day_id: 'd1', time_block_id: 'bA', span_blocks: 1 }
    const result = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'T1' }],
      days: [baseDay],
      timeBlocks: [blockA],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    expect(anchorSlots).toHaveLength(0)
  })

  it('unit_id combined with span_blocks=2 anchors all groups in unit across 2 blocks', () => {
    const g1 = { id: 'g1', name: 'Aleph', tier_id: 'unit1', availability: 'all' }
    const g2 = { id: 'g2', name: 'Bet', tier_id: 'unit1', availability: 'all' }
    const g3 = { id: 'g3', name: 'Gimel', tier_id: 'unit2', availability: 'all' }
    const anchor = { id: 'anc1', name: 'Theater', unit_id: 'unit1', is_all_groups: false, group_ids: [], day_id: 'd1', time_block_id: 'bA', span_blocks: 2 }
    const result = buildSchedule({
      groups: [g1, g2, g3],
      tiers: [{ id: 'unit1', name: 'Unit 1' }, { id: 'unit2', name: 'Unit 2' }],
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: [],
      anchors: [anchor],
      campId: 'test',
    })
    const anchorSlots = result.slots.filter(s => s.type === 'anchor')
    // g1 and g2 each get 2 anchor slots (bA + bB), g3 gets none
    expect(anchorSlots).toHaveLength(4)
    expect(anchorSlots.some(s => s.groupId === 'g3')).toBe(false)
    // g1: bA is head, bB is tail
    const g1Head = anchorSlots.find(s => s.groupId === 'g1' && s.blockId === 'bA')
    const g1Tail = anchorSlots.find(s => s.groupId === 'g1' && s.blockId === 'bB')
    expect(g1Head?.is_span_head).toBe(true)
    expect(g1Tail?.is_span_head).toBe(false)
  })
})

// ── session counting: a span is ONE session ──────────────────────────────────
//
// Product decision (docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md):
// a double-length swim is one swim. min_per_week and "twice before Wednesday"
// count SESSIONS, not blocks occupied. buildSchedule()'s DISTRIBUTION pass
// counted every block of a span, while computeFindings() has always counted
// heads only — so the same week read differently immediately after generating
// than it did after quit-and-reopen. These pin the agreed answer on both.

describe('session counting (span = one session)', () => {
  const spanAct = {
    ...baseAct, id: 'swim', name: 'Swim', span_blocks: 2, priority: 'high',
    prefer_before_day: 2, prefer_before_day_min: 2,
  }
  const dayMon = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
  const dayTue = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
  const group = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }

  function build() {
    return buildSchedule({
      groups: [group],
      tiers: [{ id: 't1', name: 'Junior' }],
      days: [dayMon, dayTue],
      timeBlocks: [blockA, blockB],
      activities: [spanAct],
      anchors: [],
      campId: 'test',
    })
  }

  it('counts a 2-block placement once towards a prefer_before_day goal', () => {
    const { slots, findings } = build()

    const monday = slots.filter(s => s.dayId === 'd1' && s.activityId === 'swim')
    expect(monday).toHaveLength(2)
    expect(monday.filter(s => s.is_span_head !== false)).toHaveLength(1)

    // One session before Tuesday, goal is two → the week owes one more.
    const dist = findings.filter(f => f.kind === 'DISTRIBUTION')
    expect(dist).toHaveLength(1)
    expect(dist[0].beforeCount).toBe(1)
  })

  it('reads the same from the persisted rows as it did from the build', () => {
    const { slots, findings } = build()
    const persisted = slots
      .filter(s => s.type === 'activity')
      .map(s => ({
        group_id: s.groupId, day_id: s.dayId, time_block_id: s.blockId,
        activity_id: s.activityId, is_anchor: false, is_span_head: s.is_span_head,
      }))

    const recomputed = computeFindings({
      slots: persisted, groups: [group], activities: [spanAct], days: [dayMon, dayTue],
    })

    expect(recomputed.filter(f => f.kind === 'DISTRIBUTION').map(f => f.beforeCount))
      .toEqual(findings.filter(f => f.kind === 'DISTRIBUTION').map(f => f.beforeCount))
  })
})

// ── Activity eligibility is array-only (T69) ──────────────────────────────────
// The engine reads `eligible_tier_ids` / `eligible_group_ids` as real arrays and
// does not deserialize; the boundary (useScheduleData.js →
// normalizeActivityEligibility) owns that. These pin both the restricting case
// and the "both lists empty means unrestricted" semantics, so a future
// serialized column cannot quietly reintroduce a parallel parser.

describe('activity eligible_group_ids as a raw array (T69)', () => {
  const eg1 = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }
  const eg2 = { id: 'g2', name: 'Bet', tier_id: 't1', availability: 'all' }
  const eg3 = { id: 'g3', name: 'Gimel', tier_id: 't2', availability: 'all' }
  const tiers = [{ id: 't1', name: 'Junior' }, { id: 't2', name: 'Senior' }]

  // These tests isolate ELIGIBILITY resolution, not capacity. Since M2 (ADR D2)
  // made max_groups_per_slot a live per-activity cap even with no location,
  // baseAct's cap of 1 would otherwise limit how many eligible groups get
  // placed per block — orthogonal to what's under test. Null = no per-activity
  // cap, so every eligible group is placeable.
  function build(activities) {
    return buildSchedule({
      groups: [eg1, eg2, eg3],
      tiers,
      days: [baseDay],
      timeBlocks: [blockA, blockB],
      activities: activities.map(a => ({ ...a, max_groups_per_slot: null })),
      anchors: [],
      campId: 'test',
    })
  }

  it('restricts placement to exactly the groups listed in the array', () => {
    const act = { ...baseAct, id: 'drama', eligible_tier_ids: [], eligible_group_ids: ['g1', 'g3'] }
    const { slots } = build([act])

    const placedGroups = new Set(slots.filter(s => s.activityId === 'drama').map(s => s.groupId))
    expect(placedGroups.has('g1')).toBe(true)
    expect(placedGroups.has('g3')).toBe(true)
    expect(placedGroups.has('g2')).toBe(false)

    // g2 has no eligible activity at all, so its cells come back unfillable.
    const g2Filled = slots.filter(s => s.groupId === 'g2' && s.activityId != null)
    expect(g2Filled).toHaveLength(0)
  })

  it('treats empty eligible_tier_ids + empty eligible_group_ids as unrestricted', () => {
    const act = { ...baseAct, id: 'drama', eligible_tier_ids: [], eligible_group_ids: [] }
    const { slots } = build([act])

    const placedGroups = new Set(slots.filter(s => s.activityId === 'drama').map(s => s.groupId))
    expect([...placedGroups].sort()).toEqual(['g1', 'g2', 'g3'])
  })

  // The `|| []` in Pass 0 is load-bearing for a real DB state: both columns are
  // nullable, and normalizeActivityEligibility passes NULL through as null. If
  // the `|| []` were dropped, `null.length` throws — so these discriminate the
  // null-safety half of the contract, which the array fixtures above cannot.
  it('treats null eligibility lists as unrestricted, identically to []', () => {
    const act = { ...baseAct, id: 'drama', eligible_tier_ids: null, eligible_group_ids: null }
    const { slots } = build([act])

    const placedGroups = new Set(slots.filter(s => s.activityId === 'drama').map(s => s.groupId))
    expect([...placedGroups].sort()).toEqual(['g1', 'g2', 'g3'])
  })

  it('treats omitted eligibility fields as unrestricted, identically to []', () => {
    const act = { ...baseAct, id: 'drama' }
    delete act.eligible_tier_ids
    delete act.eligible_group_ids
    const { slots } = build([act])

    const placedGroups = new Set(slots.filter(s => s.activityId === 'drama').map(s => s.groupId))
    expect([...placedGroups].sort()).toEqual(['g1', 'g2', 'g3'])
  })

  it('unions tier eligibility with the group array', () => {
    const act = { ...baseAct, id: 'drama', eligible_tier_ids: ['t2'], eligible_group_ids: ['g1'] }
    const { slots } = build([act])

    const placedGroups = new Set(slots.filter(s => s.activityId === 'drama').map(s => s.groupId))
    expect([...placedGroups].sort()).toEqual(['g1', 'g3'])
  })
})

describe('computeFindings eligible_group_ids as a raw array (T69)', () => {
  // computeFindings resolves eligibility in its own code path, separate from
  // scheduleCohort's Pass 0 — pin the same contract here.
  const eg1 = { id: 'g1', name: 'Aleph', tier_id: 't1' }
  const eg2 = { id: 'g2', name: 'Bet', tier_id: 't1' }
  const eg3 = { id: 'g3', name: 'Gimel', tier_id: 't2' }
  const groups = [eg1, eg2, eg3]
  const days = [baseDay]

  it('only reports UNDERSERVED for the groups listed in the array', () => {
    const act = {
      id: 'a1', name: 'Archery', min_per_week: 2,
      eligible_tier_ids: [], eligible_group_ids: ['g1', 'g3'],
      prefer_before_day: null, prefer_before_day_min: null,
    }
    const findings = computeFindings({ slots: [], groups, activities: [act], days })
    expect(findings.map(f => f.groupId).sort()).toEqual(['g1', 'g3'])
  })

  it('treats both lists empty as unrestricted', () => {
    const act = {
      id: 'a1', name: 'Archery', min_per_week: 2,
      eligible_tier_ids: [], eligible_group_ids: [],
      prefer_before_day: null, prefer_before_day_min: null,
    }
    const findings = computeFindings({ slots: [], groups, activities: [act], days })
    expect(findings.map(f => f.groupId).sort()).toEqual(['g1', 'g2', 'g3'])
  })

  // Same null-safety pin for computeFindings' own eligibility resolution — it is
  // a separate `|| []` pair and would otherwise be uncovered against NULL columns.
  it('treats null eligibility lists as unrestricted, identically to []', () => {
    const act = {
      id: 'a1', name: 'Archery', min_per_week: 2,
      eligible_tier_ids: null, eligible_group_ids: null,
      prefer_before_day: null, prefer_before_day_min: null,
    }
    const findings = computeFindings({ slots: [], groups, activities: [act], days })
    expect(findings.map(f => f.groupId).sort()).toEqual(['g1', 'g2', 'g3'])
  })

  it('treats omitted eligibility fields as unrestricted, identically to []', () => {
    const act = {
      id: 'a1', name: 'Archery', min_per_week: 2,
      prefer_before_day: null, prefer_before_day_min: null,
    }
    const findings = computeFindings({ slots: [], groups, activities: [act], days })
    expect(findings.map(f => f.groupId).sort()).toEqual(['g1', 'g2', 'g3'])
  })

  it('respects the array when suppressing a DISTRIBUTION finding', () => {
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const act = {
      id: 'a1', name: 'Arts', min_per_week: 0,
      eligible_tier_ids: [], eligible_group_ids: ['g2'],
      prefer_before_day: 2, prefer_before_day_min: 1,
    }
    const findings = computeFindings({ slots: [], groups, activities: [act], days: [baseDay, day2] })
    expect(findings.filter(f => f.kind === 'DISTRIBUTION').map(f => f.groupId)).toEqual(['g2'])
  })
})
