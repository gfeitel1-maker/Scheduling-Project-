// F3/F4 slice 2: planTripEvents / applyTripClaims / dropMultiBlockForTrips, pure.
import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities.js'
import { inferFixedEvents } from './fixedEvents.js'
import { inferTextSpans } from './textSpans.js'
import { inferActivityRules } from './activityRules.js'
import { detectTripsAndSpecialDays } from './tripDetection.js'
import { planTripEvents, applyTripClaims, tripItemKey, wholeCampDayNotices } from './tripEvents.js'

const LABELS = ['09:00-09:45', '09:50-10:35', '10:40-11:25', '11:30-12:15', '12:20-13:05']
function grid(days) {
  return {
    pages: Object.entries(days).map(([day, { groups, cells }]) => ({
      title: `${day} — All Camp`, columns: groups, timeColumnLabeled: true,
      rows: cells.map((c, i) => ({ label: LABELS[i], cells: c })),
    })),
  }
}
const G = ['G1', 'G2', 'G3', 'G4']
const setup = (parsed) => {
  const proposal = extractEntities(parsed)
  return { parsed, proposal, detections: detectTripsAndSpecialDays({ pages: parsed.pages }, proposal) }
}

describe('planTripEvents', () => {
  const { proposal, detections } = setup(grid({
    Monday: { groups: G, cells: [['Zoo Trip', 'Zoo Trip', 'Swim', 'Art'], ['Zoo Trip', 'Zoo Trip', 'Art', 'Swim'], ['Lunch', 'Lunch', 'Lunch', 'Lunch']] },
    Tuesday: { groups: G, cells: [['Farm Trip', 'Farm Trip', 'Farm Trip', 'Farm Trip'], ['Farm Trip', 'Farm Trip', 'Farm Trip', 'Farm Trip'], ['Lunch', 'Lunch', 'Lunch', 'Lunch']] },
  }))
  const all = proposal.entities.groups

  it('some groups -> recurring with those groups; every group (not a whole day) -> fixed, all groups; week and span set', () => {
    const plan = planTripEvents({ detections, weekId: 'w1', hasWeeks: true, allGroupNames: all })
    expect(plan.fixedEvents.map(({ name, time_block, days, kind, scope, span_blocks, weekId }) => ({ name, time_block, days, kind, scope, span_blocks, weekId }))).toEqual([
      { name: 'Zoo Trip', time_block: '09:00-09:45', days: ['Monday'], kind: 'recurring', scope: { is_all_groups: false, groups: ['G1', 'G2'] }, span_blocks: 2, weekId: 'w1' },
      { name: 'Farm Trip', time_block: '09:00-09:45', days: ['Tuesday'], kind: 'fixed', scope: { is_all_groups: true, groups: null }, span_blocks: 2, weekId: 'w1' },
    ])
    expect(plan.claims.size).toBe(4 * 2 + 2 * 2)
  })

  it('decline and per-item week are honoured; no week leaves every item pending', () => {
    const zoo = detections.find((d) => d.name === 'Zoo Trip')
    const farm = detections.find((d) => d.name === 'Farm Trip')
    const plan = planTripEvents({ detections, answers: { [tripItemKey(zoo)]: 'activity' }, weekByKey: { [tripItemKey(farm)]: 'w2' }, weekId: 'w1', hasWeeks: true, allGroupNames: all })
    expect(plan.fixedEvents.map((fe) => [fe.name, fe.weekId])).toEqual([['Farm Trip', 'w2']])
    const none = planTripEvents({ detections, weekId: null, hasWeeks: true, allGroupNames: all })
    expect(none.items.map((i) => i.pending)).toEqual([true, true])
    expect(none.fixedEvents).toEqual([])
    expect(planTripEvents({ detections, weekId: 'w1', hasWeeks: false, allGroupNames: all }).items).toEqual([])
  })
})

describe('applyTripClaims', () => {
  it('a trip name the file also prints as an activity keeps a rule from the unclaimed cells only', () => {
    // "Field Day" for G1+G2 Monday (2 blocks, a trip), and once more on Tuesday for G3 as an ordinary cell.
    const parsed = grid({
      Monday: { groups: G, cells: [['Field Day', 'Field Day', 'Swim', 'Art'], ['Field Day', 'Field Day', 'Art', 'Swim'], ['Lunch', 'Lunch', 'Lunch', 'Lunch']] },
      Tuesday: { groups: G, cells: [['Swim', 'Art', 'Field Day', 'Swim'], ['Art', 'Swim', 'Archery', 'Art'], ['Lunch', 'Lunch', 'Lunch', 'Lunch']] },
    })
    const { proposal, detections } = setup(parsed)
    const plan = planTripEvents({ detections, weekId: 'w1', hasWeeks: true, allGroupNames: proposal.entities.groups })
    expect(plan.fixedEvents.map((fe) => fe.name)).toEqual(['Field Day'])
    const spans = inferTextSpans({ pages: parsed.pages }, proposal).spans
    const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
    const c = applyTripClaims({ parsed: { pages: parsed.pages }, proposal, claims: plan.claims, fixedEvents, textSpans: spans })
    expect(c.fullyClaimedNames).toEqual([])
    expect(c.seenCounts.activities['Field Day']).toBe(1)
    const before = inferActivityRules(['Field Day'], proposal.activityPages, proposal.seenCounts, 2, proposal.entities.groups, [], spans).get('Field Day')
    const after = inferActivityRules(['Field Day'], c.activityPages, c.seenCounts, 2, proposal.entities.groups, [], c.textSpans).get('Field Day')
    expect(before.support.appearances).toBe(5)
    expect(after.support.appearances).toBe(1)
    expect(after.min_per_week).toBe(1)
  })

  it('a name only the trip printed is fully claimed; an inferred fixed event on the trip cells is dropped', () => {
    const parsed = grid({
      Monday: { groups: G, cells: [['Zoo Trip', 'Zoo Trip', 'Swim', 'Art'], ['Zoo Trip', 'Zoo Trip', 'Art', 'Swim'], ['Lunch', 'Lunch', 'Lunch', 'Lunch']] },
    })
    const { proposal, detections } = setup(parsed)
    const plan = planTripEvents({ detections, weekId: 'w1', hasWeeks: true, allGroupNames: proposal.entities.groups })
    const fake = [
      { name: 'Zoo Trip', time_block: '09:00-09:45', days: ['Monday'], scope: { is_all_groups: false, groups: ['G1', 'G2'] } },
      { name: 'Lunch', time_block: '10:40-11:25', days: ['Monday'], scope: { is_all_groups: true, groups: null } },
    ]
    const c = applyTripClaims({ parsed: { pages: parsed.pages }, proposal, claims: plan.claims, fixedEvents: fake, textSpans: new Map() })
    expect(c.fullyClaimedNames).toEqual(['Zoo Trip'])
    expect(c.seenCounts.activities['Zoo Trip']).toBe(0)
    expect(c.fixedEvents.map((fe) => fe.name)).toEqual(['Lunch'])
  })
})

describe('wholeCampDayNotices: every outcome the director did not get is said out loud', () => {
  it('says nothing when everything was placed or already in place', () => {
    expect(wholeCampDayNotices({ wholeCampDays: [{ name: 'Games Day', day: 'Friday', created: true, placed: true }] })).toEqual([])
    expect(wholeCampDayNotices({})).toEqual([])
  })
  it('names a kept-existing binding, a skipped item and a dropped placement', () => {
    const n = wholeCampDayNotices({
      wholeCampDays: [
        { name: 'Games Day', day: 'Friday', keptExisting: true },
        { name: 'Spirit Day', day: 'Monday', skipped: 'a special day with that name already exists' },
      ],
      placementsDropped: [{ dayLabel: 'Friday', specialDayId: 'x' }],
    })
    expect(n).toHaveLength(3)
    expect(n[0]).toMatch(/Games Day.*Friday.*already has a special day/)
    expect(n[1]).toMatch(/Spirit Day.*Monday.*already exists/)
    expect(n[2]).toMatch(/Friday.*no longer/)
  })
})
