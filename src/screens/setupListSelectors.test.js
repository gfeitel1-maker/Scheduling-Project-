import { describe, it, expect } from 'vitest'
import { activitiesListed, fixedEventsListed, timeBlocksListed } from './setupListSelectors'
import { rootsCardCount } from './rootsCardCounts'

// Audit I4 — one shared fixture shaped like the imported camp the audit saw:
// pinned-event activity rows beside the free-choice catalogue, fixed AND
// recurring rows in fixed_events, days plus time blocks, and a second cohort.
const CAMP = 'camp-1'
const fixture = {
  activities: [
    { id: 'a1', camp_id: CAMP, name: 'Swim' },
    { id: 'a2', camp_id: CAMP, name: 'Art' },
    { id: 'p1', camp_id: CAMP, name: 'Lunch', catalog_role: 'pinned_event' },
    { id: 'p2', camp_id: CAMP, name: 'Flagpole', catalog_role: 'pinned_event' },
  ],
  fixed_events: [
    { id: 'f1', camp_id: CAMP, cohort_id: 'c1', kind: 'fixed', name: 'Flagpole' },
    { id: 'f2', camp_id: CAMP, cohort_id: 'c1', kind: 'fixed', name: 'Lunch' },
    { id: 'r1', camp_id: CAMP, cohort_id: 'c1', kind: 'recurring', name: 'Rest' },
    { id: 'r2', camp_id: CAMP, cohort_id: 'c1', kind: 'recurring', name: 'Rest' },
    { id: 'r3', camp_id: CAMP, cohort_id: 'c1', kind: 'recurring', name: 'Rest' },
    { id: 'f9', camp_id: CAMP, cohort_id: 'c2', kind: 'fixed', name: 'Other cohort' },
  ],
  days_of_operation: [1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, camp_id: CAMP, day_of_week: n })),
  time_blocks: [
    { id: 'b1', camp_id: CAMP, cohort_id: 'c1', name: '09:00-09:45' },
    { id: 'b2', camp_id: CAMP, cohort_id: 'c1', name: '12:55-01:35' },
    { id: 'b3', camp_id: CAMP, cohort_id: 'c1', name: 'Swim Period' },
    { id: 'b9', camp_id: CAMP, cohort_id: 'c2', name: 'Other cohort' },
  ],
}
const scope = { campId: CAMP, cohortId: 'c1' }

describe('setup list selectors — what each screen lists', () => {
  it('Activities lists the free-choice catalogue, not pinned-event rows', () => {
    expect(activitiesListed(fixture.activities, scope).map((a) => a.id)).toEqual(['a1', 'a2'])
  })
  it('Fixed Events lists kind=fixed in the active cohort; Recurring lists kind=recurring', () => {
    expect(fixedEventsListed(fixture.fixed_events, { ...scope, kind: 'fixed' }).map((e) => e.id)).toEqual(['f1', 'f2'])
    expect(fixedEventsListed(fixture.fixed_events, { ...scope, kind: 'recurring' })).toHaveLength(3)
  })
  it('Time Blocks lists the active cohort’s blocks', () => {
    expect(timeBlocksListed(fixture.time_blocks, scope).map((b) => b.id)).toEqual(['b1', 'b2', 'b3'])
  })
})

describe('Roots "What has taken root" counts equal the screen each card names', () => {
  it('Activities card = Activities screen catalogue (2, not 4)', () => {
    expect(rootsCardCount(fixture, 'activities', scope)).toBe(activitiesListed(fixture.activities, scope).length)
    expect(rootsCardCount(fixture, 'activities', scope)).toBe(2)
  })
  it('Fixed Events card = Fixed Events screen (2, not 6)', () => {
    expect(rootsCardCount(fixture, 'fixed_events', scope)).toBe(2)
  })
  it('Time Blocks card = Time Blocks screen (3, not days+blocks 9)', () => {
    expect(rootsCardCount(fixture, 'time_blocks', scope)).toBe(3)
  })
})
