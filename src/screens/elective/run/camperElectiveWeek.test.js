// T296 — the per-camper week projection, as a pure function.
//
// The screen-level proof that the rendered week matches the DATABASE lives in
// camperWeekFromDatabase.test.jsx. This file pins the projection's own rules:
// which occurrences belong to one camper, what order a week runs in, and the
// ranked-vs-fallback classification the ticket's archive_when turns on.
import { describe, it, expect } from 'vitest'
import { buildCamperElectiveWeek, listRunCampers, rankLabel } from './camperElectiveWeek.js'

const DAYS = [
  { id: 'day-2', label: 'Tuesday', sort_order: 2 },
  { id: 'day-1', label: 'Monday', sort_order: 1 },
]
const TIME_BLOCKS = [
  { id: 'tb-2', name: 'Second Period', sort_order: 2 },
  { id: 'tb-1', name: 'First Period', sort_order: 1 },
]
const ACTIVITIES = [{ id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Pottery' }]
const OCCURRENCES = [
  { id: 'occ-mon-2', day_id: 'day-1', time_block_id: 'tb-2' },
  { id: 'occ-tue-1', day_id: 'day-2', time_block_id: 'tb-1' },
  { id: 'occ-mon-1', day_id: 'day-1', time_block_id: 'tb-1' },
]

const catalogs = { occurrences: OCCURRENCES, activities: ACTIVITIES, days: DAYS, timeBlocks: TIME_BLOCKS }

describe('rankLabel', () => {
  it('names a fallback placement in the same words the occurrence view uses', () => {
    expect(rankLabel(null)).toBe('Not requested')
    expect(rankLabel(undefined)).toBe('Not requested')
  })

  it('names a ranked placement by its rank', () => {
    expect(rankLabel(1)).toBe('First choice')
    expect(rankLabel(2)).toBe('Second choice')
    expect(rankLabel(3)).toBe('Third choice')
    // A rank past third says WHICH, rather than collapsing to "lower" — the
    // camper's own row is the one place the exact number is worth carrying.
    expect(rankLabel(5)).toBe('Choice #5')
  })
})

describe('buildCamperElectiveWeek', () => {
  const rows = [
    { id: 'a-tue', occurrence_id: 'occ-tue-1', camper_id: 'cam-1', activity_id: 'act-2', preference_rank: null, camper_name: 'Testcamper Alpha' },
    { id: 'a-mon-2', occurrence_id: 'occ-mon-2', camper_id: 'cam-1', activity_id: 'act-1', preference_rank: 2, camper_name: 'Testcamper Alpha' },
    { id: 'a-mon-1', occurrence_id: 'occ-mon-1', camper_id: 'cam-1', activity_id: 'act-1', preference_rank: 1, camper_name: 'Testcamper Alpha' },
    { id: 'a-other', occurrence_id: 'occ-mon-1', camper_id: 'cam-2', activity_id: 'act-2', preference_rank: 1, camper_name: 'Testcamper Bravo' },
  ]

  it('keeps only the named camper and orders the week by day then period', () => {
    const week = buildCamperElectiveWeek({ camperId: 'cam-1', rows, ...catalogs })
    expect(week.camperName).toBe('Testcamper Alpha')
    expect(week.entries.map((e) => e.assignmentId)).toEqual(['a-mon-1', 'a-mon-2', 'a-tue'])
  })

  it('carries the activity placed there and the ranked-or-fallback verdict per occurrence', () => {
    const week = buildCamperElectiveWeek({ camperId: 'cam-1', rows, ...catalogs })
    // `preferenceId` joined the entry in T297 and stays an EXHAUSTIVE toEqual
    // rather than being relaxed to toMatchObject: this assertion's value is that
    // it pins the whole shape, so a future field has to be added here
    // deliberately. These rows pass no `preferences`, so null is the answer.
    expect(week.entries).toEqual([
      { assignmentId: 'a-mon-1', occurrenceId: 'occ-mon-1', dayName: 'Monday', blockName: 'First Period', activityName: 'Archery', rank: 1, isFallback: false, choiceId: null, preferenceId: null },
      { assignmentId: 'a-mon-2', occurrenceId: 'occ-mon-2', dayName: 'Monday', blockName: 'Second Period', activityName: 'Archery', rank: 2, isFallback: false, choiceId: null, preferenceId: null },
      { assignmentId: 'a-tue', occurrenceId: 'occ-tue-1', dayName: 'Tuesday', blockName: 'First Period', activityName: 'Pottery', rank: null, isFallback: true, choiceId: null, preferenceId: null },
    ])
  })

  it('degrades to the id rather than printing nothing when a catalog row is missing', () => {
    const week = buildCamperElectiveWeek({
      camperId: 'cam-1',
      rows: [{ id: 'a1', occurrence_id: 'occ-gone', camper_id: 'cam-1', activity_id: 'act-gone', preference_rank: 1, camper_name: 'Testcamper Alpha' }],
      ...catalogs,
    })
    expect(week.entries[0].activityName).toBe('act-gone')
    expect(week.entries[0].dayName).toBe(null)
    expect(week.entries[0].blockName).toBe(null)
  })

  it('returns an empty week for a camper with no placements', () => {
    const week = buildCamperElectiveWeek({ camperId: 'cam-nobody', rows, ...catalogs })
    expect(week.entries).toEqual([])
    expect(week.camperName).toBe(null)
  })

  describe('listRunCampers', () => {
    it('lists each camper the run placed once, in name order, with a fallback count', () => {
      expect(listRunCampers(rows)).toEqual([
        { camperId: 'cam-1', camperName: 'Testcamper Alpha', placementCount: 3, fallbackCount: 1 },
        { camperId: 'cam-2', camperName: 'Testcamper Bravo', placementCount: 1, fallbackCount: 0 },
      ])
    })

    it('falls back to the id when the joined camper row is missing', () => {
      expect(listRunCampers([{ id: 'a1', camper_id: 'cam-x', camper_name: null, preference_rank: 1 }]))
        .toEqual([{ camperId: 'cam-x', camperName: 'cam-x', placementCount: 1, fallbackCount: 0 }])
    })
  })
})
