// T318 — pins the two runStateCopy.js derivations that previously had no unit
// test of their own (only the screen-level ElectiveRunViews.test.jsx exercised
// them indirectly).
//
// occurrenceLabel: days_of_operation stores its name in `label`
// (electron/db/schema.sql), not `name` — a day must resolve from either.
//
// satisfactionSummary: an unordered-set preference must never be reported as a
// numbered choice (T318 (c) — "an ordinal is shown only on positive evidence of
// ordering").
import { describe, it, expect } from 'vitest'
import { occurrenceLabel, satisfactionSummary, camperDisambiguator, resolveCamperDisambiguators } from './runStateCopy.js'

describe('occurrenceLabel', () => {
  it('resolves the day name from `label`, the actual days_of_operation column', () => {
    const label = occurrenceLabel({
      occurrenceId: 'occ-1',
      activityId: 'act-1',
      activities: [{ id: 'act-1', name: 'Archery' }],
      occurrences: [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }],
      days: [{ id: 'day-1', label: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 2' }],
    })
    expect(label).toBe('Archery — Monday, Period 2')
  })
})

describe('satisfactionSummary', () => {
  it('reports an unordered-set placement as "one of their choices", never a numbered rank', () => {
    const rows = [
      {
        id: 'a1', camper_id: 'cam-1', occurrence_id: 'occ-1', choice_id: 'choice-1',
        preference_rank: 2, camper_name: 'Testcamper Alpha',
      },
    ]
    const preferences = [
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 2, rank_kind: 'unordered-set' },
    ]
    const summary = satisfactionSummary({ rows, preferences, occurrences: [], days: [], timeBlocks: [] })
    expect(summary).toMatch(/one of their choices/)
    expect(summary).not.toMatch(/a second choice/)
  })

  it('still reports the ordinal for a genuinely ordered placement', () => {
    const rows = [
      {
        id: 'a1', camper_id: 'cam-1', occurrence_id: 'occ-1', choice_id: 'choice-1',
        preference_rank: 1, camper_name: 'Testcamper Alpha',
      },
    ]
    const preferences = [
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' },
    ]
    const summary = satisfactionSummary({ rows, preferences, occurrences: [], days: [], timeBlocks: [] })
    expect(summary).toMatch(/a first choice/)
  })

  it('composes "N one of their choices" into "N got one of their choices" when it leads the sentence', () => {
    const rows = [
      { id: 'a1', camper_id: 'cam-1', occurrence_id: 'occ-1', choice_id: 'choice-1', preference_rank: 2, camper_name: 'A' },
      { id: 'a2', camper_id: 'cam-2', occurrence_id: 'occ-1', choice_id: 'choice-2', preference_rank: 3, camper_name: 'B' },
    ]
    const preferences = [
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 2, rank_kind: 'unordered-set' },
      { id: 'pref-2', camper_id: 'cam-2', choice_id: 'choice-2', occurrence_id: 'occ-1', rank: 3, rank_kind: 'unordered-set' },
    ]
    const summary = satisfactionSummary({ rows, preferences, occurrences: [], days: [], timeBlocks: [] })
    expect(summary).toMatch(/2 got one of their choices/)
  })
})

// T250 B2 — satisfactionSummary must count CAMPERS and PLACEMENTS separately.
// A camper has one row per occurrence, so `rows.length` alone reports
// placements as though they were campers (a 26-camper run with a 2-block
// activity read "52 campers placed").
describe('T250 B2 — satisfactionSummary distinguishes campers from placements', () => {
  it('reports zero rows as "No campers placed yet."', () => {
    expect(satisfactionSummary({ rows: [] })).toBe('No campers placed yet.')
  })

  it('reports one camper with one placement in the singular', () => {
    const rows = [{ camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 }]
    expect(satisfactionSummary({ rows })).toMatch(/^1 camper placed, 1 placement across 1 occurrence\./)
  })

  it('counts DISTINCT campers, not rows, when one camper has two placements (a multi-occurrence activity)', () => {
    const rows = [
      { camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c1', occurrence_id: 'occ-2', preference_rank: 1 },
    ]
    expect(satisfactionSummary({ rows })).toMatch(/^1 camper placed, 2 placements across 2 occurrences\./)
  })

  it('pluralizes campers, placements and occurrences independently', () => {
    const rows = [
      { camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c1', occurrence_id: 'occ-2', preference_rank: 1 },
      { camper_id: 'c2', occurrence_id: 'occ-1', preference_rank: 2 },
    ]
    expect(satisfactionSummary({ rows })).toMatch(/^2 campers placed, 3 placements across 2 occurrences\./)
  })

  // Round 2 FIX 5(b) (Code Reviewer, LOW) — elective_assignments.camper_id is
  // nullable in the schema (a null-camper row is schema-permitted, not known
  // to be produced today). `new Set(rows.map(r => r.camper_id)).size` counts
  // a null camper_id as ONE distinct "camper" alongside every real one, so a
  // run with two real campers and one null-camper row reported "3 campers
  // placed" — one camper too many. The row still counts toward placements.
  it('does not count a null camper_id as a distinct camper, but still counts its placement', () => {
    const rows = [
      { camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c2', occurrence_id: 'occ-1', preference_rank: 2 },
      { camper_id: null, occurrence_id: 'occ-1', preference_rank: 1 },
    ]
    expect(satisfactionSummary({ rows })).toMatch(/^2 campers placed, 3 placements across 1 occurrence\./)
  })
})

describe('T250 B3 — camperDisambiguator degrades group name -> external_id -> nothing', () => {
  it('prefers the group name when present', () => {
    expect(camperDisambiguator({ groupName: 'Bogrim A', externalId: 'CM-42' })).toBe('Bogrim A')
  })

  it('falls back to the external id when there is no group', () => {
    expect(camperDisambiguator({ groupName: null, externalId: 'CM-42' })).toBe('CM-42')
  })

  it('returns null rather than a placeholder when neither is present', () => {
    expect(camperDisambiguator({ groupName: null, externalId: null })).toBeNull()
  })

  it('never returns the raw camper_id — it is not one of the function\'s inputs at all', () => {
    const result = camperDisambiguator({ groupName: null, externalId: null, camperId: 'camper-123' })
    expect(result).not.toBe('camper-123')
  })
})

// Round 2 FIX 3 (Red Hat, MEDIUM) — camperDisambiguator degrades per camper
// with no awareness of whether its pick actually distinguishes anyone. Two
// same-named campers in the same group both printed "Jordan Lee · Cabin 4" —
// identical strings that read as resolved when they are not.
describe('T250 round 2 FIX 3 — resolveCamperDisambiguators is collision-aware across the listed set', () => {
  it('two same-named campers in the same group WITH external_ids show the external_ids, not the (colliding) group name', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: 'CM-1' },
      { id: 'c2', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: 'CM-2' },
    ])
    expect(result.get('c1')).toBe('CM-1')
    expect(result.get('c2')).toBe('CM-2')
  })

  it('the same pair with no external_id shows nothing — a genuinely unresolvable residual, never an index or the raw id', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: null },
      { id: 'c2', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: null },
    ])
    expect(result.get('c1')).toBeNull()
    expect(result.get('c2')).toBeNull()
  })

  it('two same-named campers in DIFFERENT groups are told apart by group name', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: null },
      { id: 'c2', name: 'Jordan Lee', groupName: 'Cabin 7', externalId: null },
    ])
    expect(result.get('c1')).toBe('Cabin 4')
    expect(result.get('c2')).toBe('Cabin 7')
  })

  it('a camper whose name is unique in the set gets no disambiguator', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: 'CM-1' },
      { id: 'c2', name: 'Ari Green', groupName: 'Cabin 4', externalId: 'CM-2' },
    ])
    expect(result.get('c1')).toBeNull()
    expect(result.get('c2')).toBeNull()
  })
})
