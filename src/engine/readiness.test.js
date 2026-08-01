import { describe, it, expect } from 'vitest'
import { getSetupGaps, REQUIRED_AREAS, OPTIONAL_AREAS } from './readiness'

// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §4, §12.
//
// One required set, in one place. Before this existed the app held four
// disagreeing versions of "is setup done": CampSetup tracked five areas and
// told the director "the engine needs all five" — counting Fixed Events, which
// is optional, and omitting Days and Programs, which are not. ScheduleScreen
// checked a different four. The sidebar listed nine.
//
// The membership tests below are derived from src/engine/buildSchedule.js, not
// from any of those surfaces.

const FULL = {
  cohorts: [{ id: 'c1' }],
  tiers: [{ id: 't1' }],
  groups: [{ id: 'g1' }],
  days: [{ id: 'd1' }],
  timeBlocks: [{ id: 'b1' }],
  activities: [{ id: 'a1' }],
}

describe('getSetupGaps: what actually blocks building a week', () => {
  it('returns nothing when every required area has data', () => {
    expect(getSetupGaps(FULL)).toEqual([])
  })

  it('names Days, and only Days, when days are the only thing missing', () => {
    const gaps = getSetupGaps({ ...FULL, days: [] })
    expect(gaps).toHaveLength(1)
    expect(gaps[0].key).toBe('days')
    expect(gaps[0].label).toBe('Days')
    expect(gaps[0].screen).toBe('days')
  })

  it('counts Programs as required even though the engine never reads cohorts', () => {
    // Three setup screens gate data entry on an active cohort, so without one
    // the director cannot proceed — the schedule would build and be useless.
    const gaps = getSetupGaps({ ...FULL, cohorts: [] })
    expect(gaps.map((g) => g.key)).toEqual(['cohorts'])
  })

  it('counts Units as required even though buildSchedule discards the tiers argument', () => {
    // buildSchedule takes `tiers: _tiers` and never uses it, but eligibility
    // reads group.tier_id — so a camp with no units cannot place anything.
    const gaps = getSetupGaps({ ...FULL, tiers: [] })
    expect(gaps.map((g) => g.key)).toEqual(['tiers'])
  })

  it('does not treat Fixed Events as a gap', () => {
    // A camp with no fixed events is finished, not unfinished. Marking it
    // otherwise trains directors to ignore the warning that matters.
    expect(getSetupGaps({ ...FULL, anchors: [] })).toEqual([])
  })

  it('does not treat Day Overrides as a gap', () => {
    expect(getSetupGaps({ ...FULL, dayOverrideTemplates: [] })).toEqual([])
  })

  it('reports every missing area at once, in setup order', () => {
    const gaps = getSetupGaps({ cohorts: [], tiers: [], groups: [], days: [], timeBlocks: [], activities: [] })
    expect(gaps.map((g) => g.key)).toEqual(['cohorts', 'tiers', 'groups', 'days', 'timeblocks', 'activities'])
  })

  it('treats a missing argument the same as an empty one', () => {
    // Callers load these asynchronously; undefined during load must not read
    // as "present". Six gaps, not a crash.
    expect(getSetupGaps({})).toHaveLength(6)
    expect(getSetupGaps(undefined)).toHaveLength(6)
  })

  it('gives every gap a message a director can act on', () => {
    for (const gap of getSetupGaps({})) {
      expect(gap.message.length).toBeGreaterThan(0)
      // CONSTITUTION Art. V — no table names, no engine vocabulary.
      expect(gap.message).not.toMatch(/tier|cohort|anchor|template|slot|engine|table|row/i)
    }
  })

  it('exposes exactly six required areas and two optional ones', () => {
    expect(REQUIRED_AREAS).toHaveLength(6)
    expect(OPTIONAL_AREAS).toHaveLength(2)
    // The two must not overlap; an area that is both is the bug this replaces.
    const required = new Set(REQUIRED_AREAS.map((a) => a.key))
    for (const optional of OPTIONAL_AREAS) expect(required.has(optional.key)).toBe(false)
  })
})
