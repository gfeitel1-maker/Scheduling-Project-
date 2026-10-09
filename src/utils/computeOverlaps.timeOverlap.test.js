import { describe, it, expect } from 'vitest'
import { computeOverlaps, withOverlapFlags } from './computeOverlaps'
import buildSchedule from '../engine/buildSchedule.js'

// Audit A6: a group booked in two blocks whose clock times intersect is in two
// places at once — flagged on either route, since Manual can build it by hand.
const blocks = [
  { id: 'e', name: 'Early', start_time: '09:00', end_time: '10:00' },
  { id: 'l', name: 'Late', start_time: '09:30', end_time: '10:30' },
  { id: 't', name: 'Touching', start_time: '10:30', end_time: '11:30' },
]
const acts = [{ id: 'a', name: 'Art' }, { id: 'b', name: 'Ball' }]
const row = (id, block, extra = {}) => ({ id, group_id: 'g1', day_id: 'd1', time_block_id: block, activity_id: 'a', is_fixed_event: false, ...extra })

describe('OVERLAP — group double-booked across time-overlapping blocks', () => {
  it('flags both cells of a manual double-booking', () => {
    const slots = [row('s1', 'e'), row('s2', 'l', { activity_id: 'b' })]
    const flagged = withOverlapFlags(slots, acts, [], [], blocks)
    expect(flagged.every(s => s.flags?.OVERLAP)).toBe(true)
    expect(flagged[0].flags.OVERLAP_reason).toContain('Late')
    expect(flagged[1].flags.OVERLAP_reason).toContain('Early')
  })

  it('stays silent for touching blocks, other groups, or other days', () => {
    const slots = [
      row('s1', 'l'), row('s2', 't'),
      row('s3', 'e', { group_id: 'g2' }), row('s4', 'l', { day_id: 'd2' }),
    ]
    expect(computeOverlaps({ slots, activities: acts, locations: [], timeBlocks: blocks }).size).toBe(0)
  })

  // A span continuing across its own overlapping blocks is one placement, not
  // a double booking — the engine allows it, so OVERLAP must not contradict it.
  it('does not flag a generated span across overlapping blocks', () => {
    const dbl = { id: 'dbl', name: 'Double', priority: 'high', max_per_week: 10, min_per_week: 0, max_groups_per_slot: null, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null, span_blocks: 2 }
    const tb = blocks.slice(0, 2).map((b, i) => ({ ...b, sort_order: i, part_of_day: 'morning' }))
    const { slots } = buildSchedule({
      groups: [{ id: 'g1', name: 'g1', tier_id: 't1', availability: 'all' }], tiers: [{ id: 't1' }],
      days: [{ id: 'd1', day_of_week: 1, sort_order: 0 }], timeBlocks: tb, activities: [dbl],
      fixedEvents: [], campId: 'test', replacedDayIds: [],
    })
    const rows = slots.map((s, i) => ({ id: `r${i}`, group_id: s.groupId, day_id: s.dayId, time_block_id: s.blockId, activity_id: s.activityId, is_span_head: s.is_span_head, is_fixed_event: false }))
    expect(rows.map(r => [r.time_block_id, r.activity_id, r.is_span_head])).toEqual([['e', 'dbl', true], ['l', 'dbl', false]])
    expect(computeOverlaps({ slots: rows, activities: [dbl], locations: [], timeBlocks: tb }).size).toBe(0)
  })

  it('does not flag a manual span across overlapping blocks, but still flags a different activity there', () => {
    const span = [row('s1', 'e', { is_span_head: true }), row('s2', 'l', { is_span_head: false })]
    expect(computeOverlaps({ slots: span, activities: acts, locations: [], timeBlocks: blocks }).size).toBe(0)
    const clash = [row('s1', 'e', { is_span_head: true }), row('s2', 'l', { activity_id: 'b', is_span_head: true })]
    expect([...computeOverlaps({ slots: clash, activities: acts, locations: [], timeBlocks: blocks }).keys()].sort()).toEqual(['s1', 's2'])
  })

  it('flags only the movable placement, never the fixed event', () => {
    const slots = [row('s1', 'e', { activity_id: null, is_fixed_event: true }), row('s2', 'l')]
    const result = computeOverlaps({ slots, activities: acts, locations: [], timeBlocks: blocks })
    expect([...result.keys()]).toEqual(['s2'])
  })
})
