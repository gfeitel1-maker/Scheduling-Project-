import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

// F2: a kept 10-minute block (Flag Raising, Taps) is events-only. Generate must
// never put a regular activity in it, even for a group with no event there.
const groups = [
  { id: 'g1', name: 'Otters 1', tier_id: 't1', availability: 'all' },
  { id: 'g2', name: 'Otters 2', tier_id: 't1', availability: 'all' },
]
const day = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const flagBlock = (eventsOnly) => ({ id: 'flag', name: '08:50-09:00', start_time: '08:50', end_time: '09:00', sort_order: 0, part_of_day: 'morning', events_only: eventsOnly })
const mainBlock = { id: 'main', name: '09:05-09:50', start_time: '09:05', end_time: '09:50', sort_order: 1, part_of_day: 'morning', events_only: 0 }
const archery = { id: 'archery', name: 'Archery', priority: 'high', max_per_week: 10, min_per_week: 2, is_outdoor: false, location: null, max_groups_per_slot: 2, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
// Partial row: only Otters 1 prints Flag Raising.
const flagRaising = { id: 'fe1', name: 'Flag Raising', activity_id: null, is_all_groups: false, group_ids: ['g1'], day_id: null, time_block_id: 'flag', span_blocks: 1 }

const run = (eventsOnly) =>
  buildSchedule({
    groups, tiers: [{ id: 't1', name: 'Junior' }], days: [day], timeBlocks: [flagBlock(eventsOnly), mainBlock],
    activities: [archery], fixedEvents: [flagRaising], campId: 'test', replacedDayIds: [],
  }).slots

describe('events-only time blocks', () => {
  it('Generate never places Archery in a 10-minute Flag Raising block, but the event still lands', () => {
    const slots = run(1)
    const inFlag = slots.filter((s) => s.blockId === 'flag')
    expect(inFlag.filter((s) => s.type === 'activity')).toEqual([])
    expect(inFlag.find((s) => s.groupId === 'g1').type).toBe('fixed_event')
    expect(slots.some((s) => s.blockId === 'main' && s.type === 'activity' && s.activityId === 'archery')).toBe(true)
  })

  it('a multi-block activity cannot span into an events-only block', () => {
    const span = { ...archery, id: 'ropes', name: 'Ropes', span_blocks: 2 }
    const blocks = [{ ...mainBlock, id: 'pre', sort_order: 0, start_time: '09:05', end_time: '09:50' }, flagBlock(1), { ...mainBlock, sort_order: 2, start_time: '10:00', end_time: '10:45' }]
    const { slots } = buildSchedule({
      groups, tiers: [{ id: 't1', name: 'Junior' }], days: [day], timeBlocks: blocks, activities: [span], fixedEvents: [], campId: 'test', replacedDayIds: [],
    })
    expect(slots.filter((s) => s.blockId === 'flag' && s.type === 'activity')).toEqual([])
  })

  it('a preplaced (locked) multi-block span cannot cross into an events-only block', () => {
    const span = { ...archery, id: 'ropes', name: 'Ropes', span_blocks: 2 }
    const blocks = [{ ...mainBlock, id: 'pre', sort_order: 0, start_time: '09:05', end_time: '09:50' }, flagBlock(1), { ...mainBlock, sort_order: 2, start_time: '10:00', end_time: '10:45' }]
    const { slots } = buildSchedule({
      groups, tiers: [{ id: 't1', name: 'Junior' }], days: [day], timeBlocks: blocks, activities: [span], fixedEvents: [], campId: 'test', replacedDayIds: [],
      preplacedSlots: [{ groupId: 'g1', dayId: 'd1', blockId: 'pre', activityId: 'ropes' }],
    })
    expect(slots.filter((s) => s.blockId === 'flag' && s.type === 'activity')).toEqual([])
    // The lock would have to cross the events-only block, so it is not honoured as a two-block span.
    expect(slots.find((s) => s.groupId === 'g1' && s.blockId === 'pre').activityId).not.toBe('ropes')
  })

  it('flipping the toggle off makes the block schedulable again', () => {
    const slots = run(0)
    expect(slots.some((s) => s.blockId === 'flag' && s.groupId === 'g2' && s.type === 'activity')).toBe(true)
  })
})
