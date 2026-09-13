import { describe, it, expect } from 'vitest'
import { inferCoScheduleRules } from './coScheduleRules.js'

// T114 — infer `max_groups_per_slot` from the grid's own co-occurrence.
//
// A schedule records, directly, how many groups were doing an activity at the
// same time, and — given division membership — whether those groups ever came
// from different divisions. Both are read off the grid rather than guessed.
//
// `is_outdoor` is NOT inferred here: it is a property of the PLACE, not the
// placement, so no arrangement of cells can establish it. Neither is
// `weather_alternative_id`, which is a plan the director holds rather than an
// observation the grid contains. See the module header.
const p = (groupName, dayName, blockLabel, activityName) =>
  ({ groupName, dayName, blockLabel, activityName })

describe('inferCoScheduleRules', () => {
  it('counts the most groups that ever shared one slot', () => {
    const rules = inferCoScheduleRules([
      p('Bunk 1', 'Monday', '9:00', 'Swim'),
      p('Bunk 2', 'Monday', '9:00', 'Swim'),
      p('Bunk 3', 'Monday', '9:00', 'Swim'),
      p('Bunk 1', 'Tuesday', '9:00', 'Swim'),
    ])
    expect(rules.get('Swim').max_groups_per_slot).toBe(3)
  })

  it('a solo activity infers 1, not null — "one group at a time" is a real observation', () => {
    const rules = inferCoScheduleRules([
      p('Bunk 1', 'Monday', '9:00', 'Archery'),
      p('Bunk 2', 'Tuesday', '9:00', 'Archery'),
    ])
    expect(rules.get('Archery').max_groups_per_slot).toBe(1)
  })

  it('counts DISTINCT groups — the same group twice in a slot is one group', () => {
    // A compound or duplicated cell can repeat a group within one slot; that
    // is not two groups sharing the room.
    const rules = inferCoScheduleRules([
      p('Bunk 1', 'Monday', '9:00', 'Swim'),
      p('Bunk 1', 'Monday', '9:00', 'Swim'),
    ])
    expect(rules.get('Swim').max_groups_per_slot).toBe(1)
  })

  it('keeps activities separate — one busy activity does not inflate another', () => {
    const rules = inferCoScheduleRules([
      p('Bunk 1', 'Monday', '9:00', 'Swim'),
      p('Bunk 2', 'Monday', '9:00', 'Swim'),
      p('Bunk 1', 'Monday', '10:00', 'Arts'),
    ])
    expect(rules.get('Swim').max_groups_per_slot).toBe(2)
    expect(rules.get('Arts').max_groups_per_slot).toBe(1)
  })

  it('treats the same block on different days as different slots', () => {
    // Two groups at 9:00 on different days never actually shared a room.
    const rules = inferCoScheduleRules([
      p('Bunk 1', 'Monday', '9:00', 'Swim'),
      p('Bunk 2', 'Tuesday', '9:00', 'Swim'),
    ])
    expect(rules.get('Swim').max_groups_per_slot).toBe(1)
  })

  it('carries the observation that produced the number, for import_evidence', () => {
    const rules = inferCoScheduleRules([
      p('Bunk 1', 'Monday', '9:00', 'Swim'),
      p('Bunk 2', 'Monday', '9:00', 'Swim'),
    ])
    const r = rules.get('Swim')
    expect(r.support.busiest_slot).toEqual({ day: 'Monday', block: '9:00' })
    expect(r.support.groups_in_busiest_slot).toEqual(['Bunk 1', 'Bunk 2'])
    expect(r.support.slots_observed).toBe(1)
  })

  // same_tier_only — inferable WHENEVER division membership is known.
  // Owner correction 2026-09-13: an earlier draft refused this outright, which
  // confused "ingestion does not currently map groups to divisions" with "this
  // cannot be inferred". Those are different claims.
  describe('same_tier_only', () => {
    const TIERS = { 'Bunk 1': 'Juniors', 'Bunk 2': 'Juniors', 'Bunk 3': 'Seniors' }

    it('is true when only same-division groups ever shared a slot', () => {
      const rules = inferCoScheduleRules([
        p('Bunk 1', 'Monday', '9:00', 'Swim'),
        p('Bunk 2', 'Monday', '9:00', 'Swim'),
      ], TIERS)
      expect(rules.get('Swim').same_tier_only).toBe(true)
    })

    it('is false the moment ONE slot mixes divisions — a single counter-example settles it', () => {
      const rules = inferCoScheduleRules([
        p('Bunk 1', 'Monday', '9:00', 'Swim'),
        p('Bunk 2', 'Monday', '9:00', 'Swim'),
        p('Bunk 1', 'Tuesday', '9:00', 'Swim'),
        p('Bunk 3', 'Tuesday', '9:00', 'Swim'),
      ], TIERS)
      expect(rules.get('Swim').same_tier_only).toBe(false)
    })

    it('is true for a solo activity — one group never mixes divisions', () => {
      const rules = inferCoScheduleRules([p('Bunk 3', 'Monday', '9:00', 'Archery')], TIERS)
      expect(rules.get('Archery').same_tier_only).toBe(true)
    })

    it('is OMITTED when one involved group has no known division', () => {
      // Unknown is not false. The unplaceable group could be the one that
      // breaks it, so the honest answer is no answer.
      const rules = inferCoScheduleRules([
        p('Bunk 1', 'Monday', '9:00', 'Swim'),
        p('Mystery Bunk', 'Monday', '9:00', 'Swim'),
      ], TIERS)
      expect('same_tier_only' in rules.get('Swim')).toBe(false)
    })

    it('is OMITTED entirely when no membership map is supplied at all', () => {
      const rules = inferCoScheduleRules([p('Bunk 1', 'Monday', '9:00', 'Swim')])
      expect('same_tier_only' in rules.get('Swim')).toBe(false)
    })
  })

  it('NEVER infers is_outdoor or weather_alternative_id', () => {
    const rules = inferCoScheduleRules([p('Bunk 1', 'Monday', '9:00', 'Swim')])
    const r = rules.get('Swim')
    expect('is_outdoor' in r).toBe(false)
    expect('weather_alternative_id' in r).toBe(false)
  })

  it('skips a placement missing any coordinate rather than inventing one', () => {
    const rules = inferCoScheduleRules([
      p('Bunk 1', 'Monday', '9:00', 'Swim'),
      p(null, 'Monday', '9:00', 'Swim'),
      p('Bunk 2', 'Monday', null, 'Swim'),
      p('Bunk 3', 'Monday', '9:00', null),
    ])
    expect(rules.get('Swim').max_groups_per_slot).toBe(1)
  })

  it('returns an empty map for no placements, never throws', () => {
    expect(inferCoScheduleRules([]).size).toBe(0)
    expect(inferCoScheduleRules(null).size).toBe(0)
    expect(inferCoScheduleRules(undefined).size).toBe(0)
  })

  it('is deterministic — same placements, same answer, whatever the order', () => {
    const a = [p('B1', 'Mon', '9', 'Swim'), p('B2', 'Mon', '9', 'Swim')]
    const b = [p('B2', 'Mon', '9', 'Swim'), p('B1', 'Mon', '9', 'Swim')]
    expect(inferCoScheduleRules(a).get('Swim')).toEqual(inferCoScheduleRules(b).get('Swim'))
  })
})

// The rule belongs to the ACTIVITY, not to a group (owner, 2026-09-13). An
// all-camp anchor gets its own rule like anything else — "the whole camp fits
// in Lunch" is a true fact about Lunch. Nothing is filtered out here; the
// anchor exclusion lives in the DIVISION inference, where an anchor's
// co-occurrence would otherwise imply two groups share a division.
describe('every activity gets its own rule, anchors included', () => {
  it('gives an all-camp anchor its own (large) rule rather than skipping it', () => {
    const rules = inferCoScheduleRules([
      p('B1', 'Mon', '12:00', 'Lunch'),
      p('B2', 'Mon', '12:00', 'Lunch'),
      p('B3', 'Mon', '12:00', 'Lunch'),
      p('B1', 'Mon', '9:00', 'Swim'),
      p('B2', 'Mon', '9:00', 'Swim'),
    ])
    expect(rules.get('Lunch').max_groups_per_slot).toBe(3)
    expect(rules.get('Swim').max_groups_per_slot).toBe(2)
  })

  it('an activity only ever seen alone infers 1 — it cannot share', () => {
    // The owner's own example: Sports never has more than one group, so its
    // rule says so, while Lunch's says three fit.
    const rules = inferCoScheduleRules([
      p('B1', 'Mon', '12:00', 'Lunch'),
      p('B2', 'Mon', '12:00', 'Lunch'),
      p('B3', 'Mon', '12:00', 'Lunch'),
      p('B1', 'Mon', '9:00', 'Sports'),
      p('B2', 'Tue', '9:00', 'Sports'),
    ])
    expect(rules.get('Lunch').max_groups_per_slot).toBe(3)
    expect(rules.get('Sports').max_groups_per_slot).toBe(1)
  })
})

// The owner's own worked examples, 2026-09-13.
describe("the rule says CAN, and says WITH WHOM", () => {
  it('Sports shared once by Alufim 1+2 can be co-scheduled — for those two', () => {
    const rules = inferCoScheduleRules([
      p('Alufim 1', 'Tue', '9:00', 'Sports'),
      p('Alufim 2', 'Tue', '9:00', 'Sports'),
      p('Alufim 1', 'Wed', '9:00', 'Sports'),
      p('Tzofim 1', 'Thu', '9:00', 'Sports'),
    ])
    const r = rules.get('Sports')
    expect(r.can_co_schedule).toBe(true)
    // One shared Tuesday is enough to say it is POSSIBLE — and the groups it
    // vouches for are the ones actually seen sharing, not everyone who ever
    // did Sports.
    expect(r.co_schedule_groups).toEqual(['Alufim 1', 'Alufim 2'])
    expect(r.co_schedule_groups).not.toContain('Tzofim 1')
  })

  it('Lunch 1 is co-schedulable for Tzofim 1/2/3 and no one else', () => {
    const rules = inferCoScheduleRules([
      ...['Mon', 'Tue', 'Wed'].flatMap((d) => [
        p('Tzofim 1', d, '12:00', 'Lunch 1'),
        p('Tzofim 2', d, '12:00', 'Lunch 1'),
        p('Tzofim 3', d, '12:00', 'Lunch 1'),
      ]),
      p('Alufim 1', 'Mon', '13:00', 'Lunch 2'),
    ])
    const r = rules.get('Lunch 1')
    expect(r.can_co_schedule).toBe(true)
    expect(r.co_schedule_groups).toEqual(['Tzofim 1', 'Tzofim 2', 'Tzofim 3'])
  })

  it('an activity never seen shared CANNOT be co-scheduled', () => {
    const rules = inferCoScheduleRules([
      p('B1', 'Mon', '9:00', 'Sports'),
      p('B2', 'Tue', '9:00', 'Sports'),
      p('B3', 'Wed', '9:00', 'Sports'),
    ])
    const r = rules.get('Sports')
    expect(r.can_co_schedule).toBe(false)
    expect(r.co_schedule_groups).toEqual([])
  })

  it('Carpool — all groups, every day, same time — is co-schedulable for all of them', () => {
    const ALL = ['Tzofim 1', 'Tzofim 2', 'Alufim 1']
    const rules = inferCoScheduleRules(
      ['Mon', 'Tue'].flatMap((d) => ALL.map((g) => p(g, d, '8:00', 'Carpool'))),
    )
    const r = rules.get('Carpool')
    expect(r.can_co_schedule).toBe(true)
    expect(r.co_schedule_groups).toEqual(ALL.slice().sort())
  })
})
