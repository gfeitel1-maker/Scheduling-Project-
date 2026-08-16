import { describe, it, expect } from 'vitest'
import { computeWeekClosures, withWeekClosureFlags } from './computeWeekClosures'

const activities = [
  { id: 'a-swim', name: 'Swim' },
  { id: 'a-arts', name: 'Arts' },
]
const groups = [
  { id: 'g-red', name: 'Red Bunk' },
  { id: 'g-blue', name: 'Blue Bunk' },
]

// A filled, non-anchor slot on the current week's grid.
function slot(over = {}) {
  return {
    id: over.id || 'sX',
    group_id: over.group_id || 'g-red',
    day_id: over.day_id || 'd1',
    time_block_id: over.time_block_id || 'b1',
    activity_id: 'activity_id' in over ? over.activity_id : 'a-swim',
    is_anchor: over.is_anchor || false,
  }
}

const WK = 'week-1'

describe('computeWeekClosures', () => {
  it('flags a slot whose activity is marked closed this week', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', activity_id: 'a-swim' })],
      activities,
      groups,
      activityExclusions: [{ week_id: WK, activity_id: 'a-swim' }],
      groupExclusions: [],
      weekId: WK,
    })
    expect(m.get('s1')).toBe('Swim is marked closed this week')
  })

  it('flags a slot whose group is marked closed this week', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', group_id: 'g-red', activity_id: 'a-arts' })],
      activities,
      groups,
      activityExclusions: [],
      groupExclusions: [{ week_id: WK, group_id: 'g-red' }],
      weekId: WK,
    })
    expect(m.get('s1')).toBe('Red Bunk is marked closed this week')
  })

  it('joins both reasons when a slot trips activity AND group closure', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', group_id: 'g-red', activity_id: 'a-swim' })],
      activities,
      groups,
      activityExclusions: [{ week_id: WK, activity_id: 'a-swim' }],
      groupExclusions: [{ week_id: WK, group_id: 'g-red' }],
      weekId: WK,
    })
    expect(m.get('s1')).toBe(
      'Swim is marked closed this week; Red Bunk is marked closed this week'
    )
  })

  it('ignores exclusion rows scoped to a different week', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', activity_id: 'a-swim' })],
      activities,
      groups,
      activityExclusions: [{ week_id: 'week-OTHER', activity_id: 'a-swim' }],
      groupExclusions: [{ week_id: 'week-OTHER', group_id: 'g-red' }],
      weekId: WK,
    })
    expect(m.size).toBe(0)
  })

  it('skips anchor slots', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', activity_id: 'a-swim', is_anchor: true })],
      activities,
      groups,
      activityExclusions: [{ week_id: WK, activity_id: 'a-swim' }],
      groupExclusions: [],
      weekId: WK,
    })
    expect(m.size).toBe(0)
  })

  it('skips empty (unfilled) slots even when their group is closed', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', group_id: 'g-red', activity_id: null })],
      activities,
      groups,
      activityExclusions: [],
      groupExclusions: [{ week_id: WK, group_id: 'g-red' }],
      weekId: WK,
    })
    expect(m.size).toBe(0)
  })

  it('returns an empty map (fast path) when there are no exclusions', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1' }), slot({ id: 's2' })],
      activities,
      groups,
      activityExclusions: [],
      groupExclusions: [],
      weekId: WK,
    })
    expect(m.size).toBe(0)
  })

  it('falls back to generic names for unknown activity/group ids', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', group_id: 'g-ghost', activity_id: 'a-ghost' })],
      activities,
      groups,
      activityExclusions: [{ week_id: WK, activity_id: 'a-ghost' }],
      groupExclusions: [{ week_id: WK, group_id: 'g-ghost' }],
      weekId: WK,
    })
    expect(m.get('s1')).toBe(
      'This activity is marked closed this week; This group is marked closed this week'
    )
  })

  it('treats omitted weekId as "match all supplied rows" (rows already week-scoped)', () => {
    const m = computeWeekClosures({
      slots: [slot({ id: 's1', activity_id: 'a-swim' })],
      activities,
      groups,
      activityExclusions: [{ week_id: WK, activity_id: 'a-swim' }],
      groupExclusions: [],
      // weekId omitted — caller passes rows already loaded for the current week
    })
    expect(m.get('s1')).toBe('Swim is marked closed this week')
  })
})

describe('withWeekClosureFlags', () => {
  it('returns the same array reference when nothing is closed', () => {
    const slots = [slot({ id: 's1' })]
    const out = withWeekClosureFlags(slots, {
      activities,
      groups,
      activityExclusions: [],
      groupExclusions: [],
      weekId: WK,
    })
    expect(out).toBe(slots)
  })

  it('stamps WEEK_CLOSED and WEEK_CLOSED_reason on affected slots only', () => {
    const slots = [
      slot({ id: 's1', activity_id: 'a-swim' }),
      slot({ id: 's2', activity_id: 'a-arts' }),
    ]
    const out = withWeekClosureFlags(slots, {
      activities,
      groups,
      activityExclusions: [{ week_id: WK, activity_id: 'a-swim' }],
      groupExclusions: [],
      weekId: WK,
    })
    const s1 = out.find(s => s.id === 's1')
    const s2 = out.find(s => s.id === 's2')
    expect(s1.flags.WEEK_CLOSED).toBe(true)
    expect(s1.flags.WEEK_CLOSED_reason).toBe('Swim is marked closed this week')
    expect(s2.flags?.WEEK_CLOSED).toBeUndefined()
  })

  it('preserves pre-existing flags (e.g. OVERLAP) when stamping WEEK_CLOSED', () => {
    const slots = [
      { ...slot({ id: 's1', activity_id: 'a-swim' }), flags: { OVERLAP: true, OVERLAP_reason: 'x' } },
    ]
    const out = withWeekClosureFlags(slots, {
      activities,
      groups,
      activityExclusions: [{ week_id: WK, activity_id: 'a-swim' }],
      groupExclusions: [],
      weekId: WK,
    })
    expect(out[0].flags.OVERLAP).toBe(true)
    expect(out[0].flags.OVERLAP_reason).toBe('x')
    expect(out[0].flags.WEEK_CLOSED).toBe(true)
  })
})
