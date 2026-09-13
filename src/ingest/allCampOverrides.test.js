import { describe, it, expect } from 'vitest'
import { detectAllCampOverrides } from './allCampOverrides.js'

// T114 — recognise a director's override sitting on top of an all-camp activity.
//
// Owner, 2026-09-13: "if there is an activity that missed one group but is for
// all others, but only happens once a week — that is most likely a director
// overriding the schedule's preferences and that 1 group either has something
// they cannot miss (like swim?) or has a trip that precludes them from being
// there. but when you are actually scheduling, that is a secondary thing you
// put in, not something you are doing when drafting it. the original schedule
// probably said all camp activity for all groups on this day."
//
// So the naive read — "this activity excludes Tzofim 2" — is the wrong lesson.
// The right one is "this is an all-camp activity, and someone pulled Tzofim 2
// out that week." We recognise the pattern and ASK, rather than silently
// writing a restriction the director never intended.
const p = (groupName, dayName, blockLabel, activityName) =>
  ({ groupName, dayName, blockLabel, activityName })

const ALL = ['Tzofim 1', 'Tzofim 2', 'Tzofim 3', 'Alufim 1']

describe('detectAllCampOverrides', () => {
  it('flags a near-all, low-frequency activity as a probable override', () => {
    // Three of four groups, once in the week. The missing group is the signal.
    const found = detectAllCampOverrides([
      p('Tzofim 1', 'Wed', '14:00', 'Color War'),
      p('Tzofim 2', 'Wed', '14:00', 'Color War'),
      p('Tzofim 3', 'Wed', '14:00', 'Color War'),
    ], ALL)
    expect(found).toHaveLength(1)
    expect(found[0].activityName).toBe('Color War')
    expect(found[0].missingGroups).toEqual(['Alufim 1'])
  })

  it('does NOT flag a genuinely all-camp activity — nothing is missing', () => {
    const found = detectAllCampOverrides(
      ALL.map((g) => p(g, 'Wed', '14:00', 'Assembly')), ALL)
    expect(found).toHaveLength(0)
  })

  it('does NOT flag a small-group activity — half the camp is not an override', () => {
    // Two of four groups is a real restriction, not somebody pulled out.
    const found = detectAllCampOverrides([
      p('Tzofim 1', 'Wed', '14:00', 'Archery'),
      p('Tzofim 2', 'Wed', '14:00', 'Archery'),
    ], ALL)
    expect(found).toHaveLength(0)
  })

  it('does NOT flag a near-all activity that runs OFTEN — that is just how it runs', () => {
    // Every day, all-but-one. A standing arrangement, not a one-off override:
    // that group genuinely never attends.
    const found = detectAllCampOverrides(
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].flatMap((d) => [
        p('Tzofim 1', d, '9:00', 'Tefillah'),
        p('Tzofim 2', d, '9:00', 'Tefillah'),
        p('Tzofim 3', d, '9:00', 'Tefillah'),
      ]), ALL)
    expect(found).toHaveLength(0)
  })

  it('reports what the director needs to judge it', () => {
    const found = detectAllCampOverrides([
      p('Tzofim 1', 'Wed', '14:00', 'Color War'),
      p('Tzofim 2', 'Wed', '14:00', 'Color War'),
      p('Tzofim 3', 'Wed', '14:00', 'Color War'),
    ], ALL)
    const f = found[0]
    expect(f.day).toBe('Wed')
    expect(f.block).toBe('14:00')
    expect(f.attendingCount).toBe(3)
    expect(f.totalGroups).toBe(4)
    expect(f.occurrences).toBe(1)
  })

  it('tolerates two missing groups out of a large camp', () => {
    const big = Array.from({ length: 12 }, (_, i) => `Bunk ${i + 1}`)
    const found = detectAllCampOverrides(
      big.slice(0, 10).map((g) => p(g, 'Wed', '14:00', 'Field Day')), big)
    expect(found).toHaveLength(1)
    expect(found[0].missingGroups).toHaveLength(2)
  })

  it('does not flag when there are too few groups for "all-but-one" to mean anything', () => {
    // With two groups, one missing is half the camp. The pattern needs a camp
    // big enough for "almost everyone" to be a meaningful statement.
    const found = detectAllCampOverrides(
      [p('A', 'Wed', '14:00', 'Thing')], ['A', 'B'])
    expect(found).toHaveLength(0)
  })

  it('returns nothing for empty input and never throws', () => {
    expect(detectAllCampOverrides([], ALL)).toEqual([])
    expect(detectAllCampOverrides(null, ALL)).toEqual([])
    expect(detectAllCampOverrides([p('A', 'Wed', '1', 'X')], null)).toEqual([])
  })

  it('is deterministic and stably ordered', () => {
    const rows = [
      p('Tzofim 1', 'Wed', '14:00', 'Color War'),
      p('Tzofim 2', 'Wed', '14:00', 'Color War'),
      p('Tzofim 3', 'Wed', '14:00', 'Color War'),
      p('Tzofim 1', 'Thu', '15:00', 'Banquet'),
      p('Tzofim 2', 'Thu', '15:00', 'Banquet'),
      p('Tzofim 3', 'Thu', '15:00', 'Banquet'),
    ]
    const a = detectAllCampOverrides(rows, ALL)
    const b = detectAllCampOverrides(rows.slice().reverse(), ALL)
    expect(a.map((f) => f.activityName)).toEqual(['Banquet', 'Color War'])
    expect(a).toEqual(b)
  })
})
