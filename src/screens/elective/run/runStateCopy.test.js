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
import { occurrenceLabel, satisfactionSummary } from './runStateCopy.js'

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
