import { describe, it, expect } from 'vitest'
import { planRainyDay, outdoorActivitiesMissingRainPlan } from './rainyDay'

const blocks = [{ id: 'b1', sort_order: 1 }, { id: 'b2', sort_order: 2 }]
const acts = [
  { id: 'swim', name: 'Swim', is_outdoor: 1, weather_alternative_id: 'movie', location_id: 'pool' },
  { id: 'hike', name: 'Hike', is_outdoor: 1, weather_alternative_id: null },
  { id: 'movie', name: 'Movie', is_outdoor: 0, max_groups_per_slot: 2, location_id: 'hall' },
  { id: 'art', name: 'Art', is_outdoor: 0 },
]
const locs = [{ id: 'pool', capacity: 4 }, { id: 'hall', capacity: 5 }]
let n = 0
const slot = (group_id, day_id, time_block_id, activity_id, extra = {}) => ({ id: `s${n++}`, group_id, day_id, time_block_id, activity_id, ...extra })
const plan = (slots, extra = {}) => planRainyDay({ slots, activities: acts, locations: locs, timeBlocks: blocks, dayId: 'wed', ...extra })

describe('planRainyDay', () => {
  it('switches an outdoor cell with a rain plan on the chosen day only', () => {
    const slots = [slot('g1', 'wed', 'b1', 'swim'), slot('g1', 'thu', 'b1', 'swim'), slot('g1', 'wed', 'b2', 'art')]
    const r = plan(slots)
    expect(r.switches.map(s => [s.slot.id, s.toActivityId])).toEqual([[slots[0].id, 'movie']])
    expect(r.full).toEqual([])
  })

  it('stops at the rain plan max_groups_per_slot and flags the rest as full', () => {
    const slots = [slot('g1', 'wed', 'b1', 'swim'), slot('g2', 'wed', 'b1', 'swim'), slot('g3', 'wed', 'b1', 'swim')]
    const r = plan(slots)
    expect(r.switches).toHaveLength(2)
    expect(r.full.map(s => s.id)).toEqual([slots[2].id])
  })

  it('counts groups already in the rain plan in that block', () => {
    const slots = [slot('g0', 'wed', 'b1', 'movie'), slot('g1', 'wed', 'b1', 'swim'), slot('g2', 'wed', 'b1', 'swim')]
    const r = plan(slots)
    expect(r.switches).toHaveLength(1)
    expect(r.full).toHaveLength(1)
  })

  it('respects the rain plan location capacity', () => {
    const tight = [{ id: 'pool', capacity: 4 }, { id: 'hall', capacity: 1 }]
    const slots = [slot('g1', 'wed', 'b1', 'swim'), slot('g2', 'wed', 'b1', 'swim')]
    const r = plan(slots, { locations: tight })
    expect(r.switches).toHaveLength(1)
    expect(r.full).toHaveLength(1)
  })

  it('does not count capacity from a different block', () => {
    const slots = [slot('g0', 'wed', 'b2', 'movie'), slot('g0b', 'wed', 'b2', 'movie'), slot('g1', 'wed', 'b1', 'swim')]
    expect(plan(slots).switches).toHaveLength(1)
  })

  it('leaves non-outdoor, fixed, elective and event cells alone and counts outdoor cells with no rain plan', () => {
    const slots = [
      slot('g1', 'wed', 'b1', 'art'),
      slot('g2', 'wed', 'b1', 'hike'),
      slot('g3', 'wed', 'b1', 'swim', { is_fixed_event: true }),
      slot('g4', 'wed', 'b1', null, { elective_set_id: 'e1' }),
    ]
    const r = plan(slots)
    expect(r.switches).toEqual([])
    expect(r.noPlan.map(s => s.id)).toEqual([slots[1].id])
  })

  it('skips multi-block spans and reports them', () => {
    const slots = [slot('g1', 'wed', 'b1', 'swim', { is_span_head: true }), slot('g1', 'wed', 'b2', 'swim', { is_span_head: false })]
    const r = plan(slots)
    expect(r.switches).toEqual([])
    expect(r.spans.map(s => s.id)).toEqual([slots[0].id, slots[1].id])
  })
})

describe('planRainyDay: places held by electives and shared places', () => {
  const sets = [{ elective_set_id: 'e1', activity_id: 'movie' }]

  it('counts an elective already offering the rain plan place (capacity 1) as full', () => {
    const tight = [{ id: 'pool', capacity: 4 }, { id: 'hall', capacity: 1 }]
    const slots = [slot('g0', 'wed', 'b1', null, { elective_set_id: 'e1' }), slot('g1', 'wed', 'b1', 'swim')]
    const r = plan(slots, { locations: tight, electiveSetActivities: sets })
    expect(r.switches).toEqual([])
    expect(r.full).toHaveLength(1)
  })

  it('treats a null capacity as 1', () => {
    const r = plan([slot('g0', 'wed', 'b1', 'art2'), slot('g1', 'wed', 'b1', 'swim')], {
      locations: [{ id: 'hall', capacity: null }],
      activities: [...acts, { id: 'art2', name: 'Art2', is_outdoor: 0, location_id: 'hall' }],
    })
    expect(r.full).toHaveLength(1)
  })

  it('counts a place shared by two activities', () => {
    const r = plan([slot('g0', 'wed', 'b1', 'art2'), slot('g1', 'wed', 'b1', 'swim')], {
      locations: [{ id: 'hall', capacity: 1 }],
      activities: [...acts, { id: 'art2', name: 'Art2', is_outdoor: 0, location_id: 'hall' }],
    })
    expect(r.switches).toEqual([])
    expect(r.full).toHaveLength(1)
  })
})

describe('outdoorActivitiesMissingRainPlan', () => {
  it('lists outdoor activities placed in the week that have no rain plan', () => {
    const slots = [slot('g1', 'wed', 'b1', 'hike'), slot('g1', 'wed', 'b2', 'swim')]
    expect(outdoorActivitiesMissingRainPlan({ slots, activities: acts }).map(a => a.id)).toEqual(['hike'])
  })
})
