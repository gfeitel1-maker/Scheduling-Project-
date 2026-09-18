// populateElectiveGrid — T195 offering-grid import. Consumer of
// parseGridScheduleMenu's output: a day x period grid of MENU cells, one
// elective_set per (day, time_block). Reuses populateElectiveSet's per-row
// potential-only upsert for each resolved set — no separate write path for
// the per-activity decision.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deriveElectiveSetImportId, populateElectiveGrid } from './electiveSetPopulate'

const CAMP_ID = 'camp-1'
const WEEK_ID = 'week-1'

function mockRepo() {
  const calls = []
  return {
    calls,
    writeFields: vi.fn(async (entity, id, fields) => { calls.push({ entity, id, fields }) }),
    writeActivityFields: vi.fn(async (activityId, fields) => { calls.push({ entity: 'activities', id: activityId, fields }) }),
  }
}

function parsedWith(cells, extra = {}) {
  return {
    orientation: { axis: 'rows-are-time', confident: true },
    timeAxis: [
      { name: '9:00-9:45', start_time: '09:00', end_time: '09:45', sourceIndex: 0 },
      { name: '9:50-10:35', start_time: '09:50', end_time: '10:35', sourceIndex: 1 },
    ],
    groupAxis: [
      { name: 'Monday', sourceIndex: 0 },
      { name: 'Tuesday', sourceIndex: 1 },
    ],
    cells,
    unmapped: [],
    linkageMarkers: [],
    ...extra,
  }
}

const DAYS = [{ id: 'day-mon', name: 'Monday' }, { id: 'day-tue', name: 'Tuesday' }]
const TIME_BLOCKS = [
  { id: 'tb-1', name: '9:00-9:45' },
  { id: 'tb-2', name: '9:50-10:35' },
]

describe('deriveElectiveSetImportId', () => {
  it('is deterministic for identical inputs', () => {
    expect(deriveElectiveSetImportId(WEEK_ID, 'day-mon', 'tb-1')).toBe(deriveElectiveSetImportId(WEEK_ID, 'day-mon', 'tb-1'))
  })

  it('differs for a different day or time block', () => {
    const base = deriveElectiveSetImportId(WEEK_ID, 'day-mon', 'tb-1')
    expect(deriveElectiveSetImportId(WEEK_ID, 'day-tue', 'tb-1')).not.toBe(base)
    expect(deriveElectiveSetImportId(WEEK_ID, 'day-mon', 'tb-2')).not.toBe(base)
  })
})

describe('populateElectiveGrid', () => {
  let repo

  beforeEach(() => {
    repo = mockRepo()
  })

  it('refuses the whole sheet when orientation is not confident, writing nothing', async () => {
    const parsed = { orientation: { axis: null, confident: false }, timeAxis: [], groupAxis: [], cells: [], unmapped: [], linkageMarkers: [] }

    const result = await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: DAYS, existingTimeBlocks: TIME_BLOCKS, existingElectiveSets: [], existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(false)
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('mints one elective_set per resolved (day, time_block) pair', async () => {
    const parsed = parsedWith([
      { timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null },
      { timeIndex: 0, groupIndex: 1, activityName: 'Archery', locationName: null },
    ])

    const result = await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: DAYS, existingTimeBlocks: TIME_BLOCKS, existingElectiveSets: [], existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    const mondaySetId = deriveElectiveSetImportId(WEEK_ID, 'day-mon', 'tb-1')
    const tuesdaySetId = deriveElectiveSetImportId(WEEK_ID, 'day-tue', 'tb-1')
    expect(repo.calls.some((c) => c.entity === 'elective_sets' && c.id === mondaySetId)).toBe(true)
    expect(repo.calls.some((c) => c.entity === 'elective_sets' && c.id === tuesdaySetId)).toBe(true)
    const mondayWrite = repo.calls.find((c) => c.entity === 'elective_sets' && c.id === mondaySetId)
    expect(mondayWrite.fields).toMatchObject({
      camp_id: CAMP_ID, day_id: 'day-mon', time_block_id: 'tb-1', schedule_week_id: WEEK_ID,
    })
    // recurrence_level is explicitly NOT set by this import (non-goal).
    expect(mondayWrite.fields).not.toHaveProperty('recurrence_level')
  })

  it('does not re-mint an elective_set that already exists for that (day, time_block, week)', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])
    const existingSetId = 'hand-authored-set'

    const result = await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: DAYS, existingTimeBlocks: TIME_BLOCKS,
      existingElectiveSets: [{ id: existingSetId, day_id: 'day-mon', time_block_id: 'tb-1', schedule_week_id: WEEK_ID }],
      existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    expect(repo.calls.some((c) => c.entity === 'elective_sets')).toBe(false)
    const rowId = deriveElectiveSetImportId(WEEK_ID, 'day-mon', 'tb-1')
    // offerings land on the EXISTING set, not a newly-minted one.
    expect(repo.calls.some((c) => c.entity === 'elective_set_activities' && c.fields?.elective_set_id === existingSetId)).toBe(true)
    expect(repo.calls.some((c) => c.entity === 'elective_set_activities' && c.fields?.elective_set_id === rowId)).toBe(false)
  })

  it('reports an unmapped time period with no matching time block, writing nothing for that column', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    const result = await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: DAYS, existingTimeBlocks: [], existingElectiveSets: [], existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    expect(result.unmapped.some((u) => u.reason.match(/time block/i))).toBe(true)
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('reports an unmapped day with no matching day, writing nothing for that row', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    const result = await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: [], existingTimeBlocks: TIME_BLOCKS, existingElectiveSets: [], existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    expect(result.unmapped.some((u) => u.reason.match(/day/i))).toBe(true)
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('never invents a day or time block — an unmapped axis label is never silently created', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: [], existingTimeBlocks: [], existingElectiveSets: [], existingActivities: [], existingOfferings: [],
    })

    expect(repo.calls.some((c) => c.entity === 'days_of_operation' || c.entity === 'time_blocks')).toBe(false)
  })

  it('writes every distinct activity in a (day, time_block) menu cell as a potential offering on that set', async () => {
    const parsed = parsedWith([
      { timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null },
      { timeIndex: 0, groupIndex: 0, activityName: 'Archery', locationName: null },
    ])

    const result = await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: DAYS, existingTimeBlocks: TIME_BLOCKS, existingElectiveSets: [], existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    const setId = deriveElectiveSetImportId(WEEK_ID, 'day-mon', 'tb-1')
    const offeringWrites = repo.calls.filter((c) => c.entity === 'elective_set_activities' && c.fields?.elective_set_id === setId)
    expect(offeringWrites).toHaveLength(2)
    expect(offeringWrites.every((w) => w.fields.status === 'potential')).toBe(true)
  })

  it('a confirmed offering on an existing set is skipped entirely, same as populateElectiveSet', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])
    const existingSetId = 'set-mon-1'
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }]
    const swimRowId = 'confirmed-row-1'

    await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: DAYS, existingTimeBlocks: TIME_BLOCKS,
      existingElectiveSets: [{ id: existingSetId, day_id: 'day-mon', time_block_id: 'tb-1', schedule_week_id: WEEK_ID }],
      existingActivities,
      existingOfferings: [{ id: swimRowId, elective_set_id: existingSetId, activity_id: 'act-swim', status: 'confirmed' }],
    })

    expect(repo.calls.some((c) => c.entity === 'elective_set_activities' && c.id === swimRowId)).toBe(false)
  })

  it('ignores locationName on menu cells — an offering set is a flat list, not a 2D grid', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: 'Pool' }])

    const result = await populateElectiveGrid(parsed, {
      campId: CAMP_ID, scheduleWeekId: WEEK_ID, repo,
      existingDays: DAYS, existingTimeBlocks: TIME_BLOCKS, existingElectiveSets: [], existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    const write = repo.calls.find((c) => c.entity === 'elective_set_activities')
    expect(write.fields).not.toHaveProperty('location_id')
  })
})
