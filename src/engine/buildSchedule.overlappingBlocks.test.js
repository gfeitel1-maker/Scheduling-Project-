import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

// Audit A6: blocks that overlap in clock time are mutually exclusive per group
// per day — a group cannot be in two places at 9:30.
const group = id => ({ id, name: id, tier_id: 't1', availability: 'all' })
const day = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const block = (id, start_time, end_time, sort_order) => ({ id, name: id, start_time, end_time, sort_order, part_of_day: 'morning' })
const act = (id, extra = {}) => ({ id, name: id, priority: 'high', max_per_week: 10, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: null, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null, ...extra })

const early = block('e', '09:00', '10:00', 0)
const late = block('l', '09:30', '10:30', 1)

function run(overrides) {
  return buildSchedule({
    groups: [group('g1'), group('g2')], tiers: [{ id: 't1', name: 'Junior' }], days: [day],
    timeBlocks: [early, late], activities: [act('a'), act('b'), act('c')], fixedEvents: [],
    campId: 'test', replacedDayIds: [], ...overrides,
  })
}
const filledBlocks = (slots, g) => slots.filter(s => s.groupId === g && (s.activityId || s.fixedEventId)).map(s => s.blockId)

describe('time-overlapping blocks', () => {
  it('never places a group in both of two overlapping blocks', () => {
    const { slots } = run({})
    for (const g of ['g1', 'g2']) expect(filledBlocks(slots, g)).toHaveLength(1)
  })

  it('does not place an activity overlapping a fixed event', () => {
    const fe = { id: 'fe', name: 'Flagpole', unit_id: null, is_all_groups: true, group_ids: [], day_id: null, time_block_id: 'e', span_blocks: 1 }
    const { slots } = run({ fixedEvents: [fe] })
    for (const g of ['g1', 'g2']) expect(filledBlocks(slots, g)).toEqual(['e'])
  })

  it('does not let a multi-block span tail overlap another placement', () => {
    const b0 = block('b0', '08:00', '09:00', 0)
    const b1 = block('b1', '09:00', '10:00', 1)
    const b2 = block('b2', '09:30', '10:30', 2)
    const { slots } = run({
      groups: [group('g1')], timeBlocks: [b0, b1, b2],
      activities: [act('a'), act('dbl', { span_blocks: 2 })],
      preplacedSlots: [{ groupId: 'g1', dayId: 'd1', blockId: 'b2', activityId: 'a' }],
    })
    expect(filledBlocks(slots, 'g1')).not.toContain('b1')
  })

  it('treats blocks that merely touch as not overlapping', () => {
    const { slots } = run({ timeBlocks: [early, block('t', '10:00', '11:00', 1)] })
    expect(filledBlocks(slots, 'g1')).toHaveLength(2)
  })
})
