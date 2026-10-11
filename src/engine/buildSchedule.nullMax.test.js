import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

// F11: an activity row with max_per_week NULL (committed with no rule: an elective candidate, or an
// import whose rule Map was dropped) means "no cap". It used to compare as `count >= null` (0) and was never placed.
const groups = [{ id: 'g1', name: 'Otters 1', tier_id: 't1', availability: 'all' }]
const days = [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }]
const timeBlocks = [{ id: 'b1', name: '09:00-09:45', start_time: '09:00', end_time: '09:45', sort_order: 0, part_of_day: 'morning', events_only: 0 }]
const archery = { id: 'archery', name: 'Archery', priority: 'high', max_per_week: null, min_per_week: null, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }

describe('activity with a null max_per_week', () => {
  it('is placed (null means no cap)', () => {
    const { slots } = buildSchedule({ groups, tiers: [{ id: 't1', name: 'Junior' }], days, timeBlocks, activities: [archery], fixedEvents: [], campId: 'test', replacedDayIds: [] })
    expect(slots.some((s) => s.type === 'activity' && s.activityId === 'archery')).toBe(true)
  })
})
