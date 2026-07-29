import { describe, it, expect } from 'vitest'
import { computeOverlaps, withOverlapFlags } from './computeOverlaps'

const pool = { id: 'swim', name: 'Swimming', location: 'Pool', max_groups_per_slot: 2 }

function slot(id, groupId, extra = {}) {
  return { id, group_id: groupId, day_id: 'd1', time_block_id: 'b1', activity_id: 'swim', is_anchor: false, ...extra }
}

describe('OVERLAP', () => {
  it('is silent while the booking is within capacity', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2')]
    expect(computeOverlaps({ slots, activities: [pool] }).size).toBe(0)
  })

  it('marks EVERY cell in an over-booking, not just the last one placed', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    const result = computeOverlaps({ slots, activities: [pool] })
    expect([...result.keys()].sort()).toEqual(['s1', 's2', 's3'])
    expect(result.get('s1')).toBe('3 groups booked into Pool — it holds 2')
  })

  it('clears from all of them as soon as one is removed', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2')]
    expect(computeOverlaps({ slots, activities: [pool] }).size).toBe(0)
  })

  it('keeps different blocks and different activities apart', () => {
    const slots = [
      slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3', { time_block_id: 'b2' }),
    ]
    expect(computeOverlaps({ slots, activities: [pool] }).size).toBe(0)
  })

  it('counts a group once even when its placement spans two blocks of the same booking', () => {
    const slots = [
      slot('s1', 'g1'), slot('s2', 'g1'), slot('s3', 'g2'),
    ]
    expect(computeOverlaps({ slots, activities: [pool] }).size).toBe(0)
  })

  it('ignores anchors and empty cells', () => {
    const slots = [
      slot('s1', 'g1', { is_anchor: true }),
      slot('s2', 'g2', { activity_id: null }),
      slot('s3', 'g3'),
    ]
    expect(computeOverlaps({ slots, activities: [pool] }).size).toBe(0)
  })

  it('decorates flags without touching the persisted rows', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    const decorated = withOverlapFlags(slots, [pool])
    expect(decorated[0].flags.OVERLAP).toBe(true)
    expect(slots[0].flags).toBeUndefined()
  })
})
