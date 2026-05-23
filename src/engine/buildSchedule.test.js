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
