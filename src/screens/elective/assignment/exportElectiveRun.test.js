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
