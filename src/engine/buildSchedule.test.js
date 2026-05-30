import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

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

describe('UNFILLABLE flag', () => {
  it('sets UNFILLABLE_reason when no activities are eligible', () => {
    const { slots } = buildSchedule(minimal({ activities: [] }))
    const unfillable = slots.find(s => s.flags?.UNFILLABLE)
    expect(unfillable).toBeTruthy()
    expect(unfillable.flags.UNFILLABLE_reason).toBe('No eligible activity could be placed in this slot')
  })
})

describe('WEATHER_RISK flag', () => {
  it('sets WEATHER_RISK_reason on outdoor activity slots', () => {
    const act = { id: 'a1', name: 'Swimming', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: true, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const { slots } = buildSchedule(minimal({ activities: [act] }))
    const weatherSlot = slots.find(s => s.flags?.WEATHER_RISK)
    expect(weatherSlot).toBeTruthy()
    expect(weatherSlot.flags.WEATHER_RISK_reason).toBe('Outdoor activity scheduled in this slot')
  })
})

describe('UNDERSERVED flag', () => {
  it('sets UNDERSERVED_reason with counts when min_per_week cannot be met', () => {
    // 1 block available, min_per_week = 3 → underserved
    const act = { id: 'a1', name: 'Archery', priority: 'low', max_per_week: 5, min_per_week: 3, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const { slots } = buildSchedule(minimal({ activities: [act] }))
    const underservedSlot = slots.find(s => s.flags?.UNDERSERVED)
    expect(underservedSlot).toBeTruthy()
    expect(underservedSlot.flags.UNDERSERVED_reason).toMatch(/Goal: 3×\/wk/)
    expect(underservedSlot.flags.UNDERSERVED_reason).toMatch(/Aleph/)
    expect(underservedSlot.flags.UNDERSERVED_reason).toMatch(/Archery/)
  })
})

describe('DISTRIBUTION flag', () => {
  it('sets DISTRIBUTION_reason when early-week goal not met', () => {
    // 2 days, prefer 2× before day_of_week=2 (Tuesday), but activity placed both Mon+Tue
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const act = { id: 'a1', name: 'Arts', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: 2, prefer_before_day_min: 2 }
    const { slots } = buildSchedule(minimal({ days: [baseDay, day2], activities: [act] }))
    const distSlot = slots.find(s => s.flags?.DISTRIBUTION)
    expect(distSlot).toBeTruthy()
    expect(distSlot.flags.DISTRIBUTION_reason).toMatch(/Goal: 2×/)
    expect(distSlot.flags.DISTRIBUTION_reason).toMatch(/Arts/)
    expect(distSlot.flags.DISTRIBUTION_reason).toMatch(/Aleph/)
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
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
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
    expect(anchorSlots.length).toBeGreaterThan(0)
    expect(anchorSlots.length).toBeLessThanOrEqual(2)
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
