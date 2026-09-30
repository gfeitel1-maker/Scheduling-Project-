// T229 CORRECTION 3 -- neither exportWorkbook.js nor exportScheduleJson.js can
// express a (camper, occurrence) roster, so this is its own small module,
// mirroring exportScheduleJson.js's format_version convention. Pins the JSON
// shape the way exportScheduleJson.test.js pins its own.
import { describe, it, expect } from 'vitest'
import { buildElectiveRunExport, buildElectiveRunRoster } from './exportElectiveRun'

const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: 'occ-1', activity_id: 'act-1', preference_rank: 1, flags: [] },
  { camper_id: 'cam-2', occurrence_id: 'occ-1', activity_id: 'act-1', preference_rank: 2, flags: ['NOT_TOP_CHOICE'] },
]
const CAMPERS = [{ id: 'cam-1', display_name: 'Ari Green' }, { id: 'cam-2', display_name: 'Noa Katz' }]
const ACTIVITIES = [{ id: 'act-1', name: 'Swim' }]
const OCCURRENCES = [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }]
const DAYS = [{ id: 'day-1', name: 'Monday' }]
const TIME_BLOCKS = [{ id: 'tb-1', name: 'Period 2' }]

describe('buildElectiveRunExport', () => {
  it('pins format_version 1 and the roster shape', () => {
    const out = buildElectiveRunExport({
      assignments: ASSIGNMENTS, campers: CAMPERS, activities: ACTIVITIES,
      occurrences: OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS, runName: 'Week 1',
    })
    expect(out.format_version).toBe(1)
    expect(out.run_name).toBe('Week 1')
    expect(out.assignments).toHaveLength(2)
    expect(out.assignments[0]).toMatchObject({
      camper_name: 'Ari Green', activity_name: 'Swim', day: 'Monday', time_block: 'Period 2', preference_rank: 1,
    })
  })
})

describe('buildElectiveRunRoster', () => {
  it('produces an array-of-arrays with a header row', () => {
    const rows = buildElectiveRunRoster({
      assignments: ASSIGNMENTS, campers: CAMPERS, activities: ACTIVITIES,
      occurrences: OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS,
    })
    expect(rows[0]).toEqual(['Camper', 'Day', 'Time Block', 'Activity', 'Preference Rank', 'Flags'])
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual(['Ari Green', 'Monday', 'Period 2', 'Swim', 1, ''])
    expect(rows[2][5]).toBe('Not top choice (got #2)')
  })
})

// Board item 9b made a NEW STATE reachable: an `elective_choices` row with no
// assignments pointing at it (the plain choice minted for a label a bundle
// claims but whose scope does not reach some camper who ranked it). Read the
// exporter before assuming what it does with one.
//
// THE ANSWER IS STRUCTURAL, not incidental, which is why it is worth a test:
// `buildElectiveRunExport` and `buildElectiveRunRoster` take `assignments,
// campers, activities, occurrences, days, timeBlocks` and NOTHING ELSE. There is
// no `choices` parameter — the export is a ROSTER of seats, so a choice nobody
// was seated into has nothing to render and cannot leak one. The camper
// themselves is NOT missing: their placement is real and is kept (with a null
// choice_id), so they appear like anyone else.
describe('an elective_choices row with no assignments', () => {
  it('contributes no row — the export is driven by seats, not by choices', () => {
    const out = buildElectiveRunExport({
      assignments: ASSIGNMENTS, campers: CAMPERS, activities: ACTIVITIES,
      occurrences: OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS,
    })
    expect(out.assignments).toHaveLength(ASSIGNMENTS.length)
    // Passing a choices collection is not merely ignored — the signature has no
    // place for one, so an extra key cannot change the output.
    const withChoices = buildElectiveRunExport({
      assignments: ASSIGNMENTS, campers: CAMPERS, activities: ACTIVITIES,
      occurrences: OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS,
      choices: [{ id: 'choice-orphan', label: 'Archery', is_linked: 0 }],
    })
    expect(withChoices).toEqual(out)
    expect(JSON.stringify(withChoices)).not.toContain('choice-orphan')
  })

  it('still exports the camper whose placement carries a null choice_id', () => {
    // The uncovered camper is seated for real; only the CHOICE binding is
    // unusual. An export that dropped them would be the silent loss this whole
    // board item exists to remove, one layer downstream.
    const rows = buildElectiveRunRoster({
      assignments: [{ camper_id: 'cam-1', occurrence_id: 'occ-1', activity_id: 'act-1', choice_id: null, preference_rank: 2, flags: [] }],
      campers: CAMPERS, activities: ACTIVITIES, occurrences: OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS,
    })
    expect(rows.slice(1)).toEqual([['Ari Green', 'Monday', 'Period 2', 'Swim', 2, '']])
  })
})
