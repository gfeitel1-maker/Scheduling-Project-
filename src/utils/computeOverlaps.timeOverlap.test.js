import { describe, it, expect } from 'vitest'
import { computeOverlaps, withOverlapFlags } from './computeOverlaps'

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

  it('flags only the movable placement, never the fixed event', () => {
    const slots = [row('s1', 'e', { activity_id: null, is_fixed_event: true }), row('s2', 'l')]
    const result = computeOverlaps({ slots, activities: acts, locations: [], timeBlocks: blocks })
    expect([...result.keys()]).toEqual(['s2'])
  })
})
