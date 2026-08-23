// Electives consumer 2 of the shared grid parser — docs/adr/2026-08-22-event-
// schedule-import.md §8. Mirrors eventGridPopulate.test.js's structure and
// coverage, scoped to the flat elective_set_activities shape.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deriveElectiveImportId, populateElectiveSet } from './electiveSetPopulate'

const ELECTIVE_SET_ID = 'set-1'
const CAMP_ID = 'camp-1'

function mockRepo() {
  const calls = []
  return {
    calls,
    writeFields: vi.fn(async (entity, id, fields) => { calls.push({ entity, id, fields }) }),
    writeActivityFields: vi.fn(async (activityId, fields) => { calls.push({ entity: 'activities', id: activityId, fields }) }),
  }
}

function parsedWith(cells, extra = {}) {
  return { orientation: { axis: 'rows-are-time', confident: true }, timeAxis: [], groupAxis: [], cells, unmapped: [], locationKey: null, ...extra }
}

describe('deriveElectiveImportId', () => {
  it('is deterministic for identical inputs', () => {
    expect(deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')).toBe(deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim'))
  })

  it('differs for a different activityId', () => {
    expect(deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')).not.toBe(deriveElectiveImportId(ELECTIVE_SET_ID, 'act-zumba'))
  })

  it('differs for a different electiveSetId', () => {
    expect(deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')).not.toBe(deriveElectiveImportId('set-2', 'act-swim'))
  })
})

describe('populateElectiveSet', () => {
  let repo

  beforeEach(() => {
    repo = mockRepo()
  })

  it('happy path: writes one elective_set_activities row per distinct activity, matching existing activities', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }, { id: 'act-zumba', name: 'Zumba' }]
    const parsed = parsedWith([
      { timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null },
      { timeIndex: 0, groupIndex: 1, activityName: 'Zumba', locationName: null },
    ])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities, existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    expect(repo.writeActivityFields).not.toHaveBeenCalled()

    const swimId = deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')
    const swimWrite = repo.calls.find((c) => c.entity === 'elective_set_activities' && c.id === swimId)
    expect(swimWrite.fields).toEqual({ elective_set_id: ELECTIVE_SET_ID, activity_id: 'act-swim', camper_headcount: null })

    const zumbaId = deriveElectiveImportId(ELECTIVE_SET_ID, 'act-zumba')
    expect(repo.calls.some((c) => c.entity === 'elective_set_activities' && c.id === zumbaId)).toBe(true)
  })

  it('dedupe: repeated cell activity names produce exactly one row', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }]
    const parsed = parsedWith([
      { timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null },
      { timeIndex: 0, groupIndex: 1, activityName: 'Swim', locationName: null },
      { timeIndex: 1, groupIndex: 0, activityName: 'Swim', locationName: null },
    ])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities, existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    const rows = repo.calls.filter((c) => c.entity === 'elective_set_activities')
    expect(rows).toHaveLength(1)
  })

  it('create-if-new: an activity name not in existingActivities is created via createActivity', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Archery', locationName: null }])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    expect(repo.writeActivityFields).toHaveBeenCalledTimes(1)
    const [newActivityId, fields] = repo.writeActivityFields.mock.calls[0]
    expect(fields).toMatchObject({ camp_id: CAMP_ID, name: 'Archery', min_per_week: 1, max_per_week: null })

    const rowId = deriveElectiveImportId(ELECTIVE_SET_ID, newActivityId)
    const row = repo.calls.find((c) => c.entity === 'elective_set_activities' && c.id === rowId)
    expect(row.fields.activity_id).toBe(newActivityId)
  })

  it('refuse-on-nonempty: existing elective_set_activities rows block import, writing nothing', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo,
      existingActivities: [], existingOfferings: [{ id: 'off-1', activity_id: 'act-existing' }],
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/already has offerings/i)
    expect(repo.writeFields).not.toHaveBeenCalled()
    expect(repo.writeActivityFields).not.toHaveBeenCalled()
  })

  it('empty parse: zero cells refuses with "nothing to import" reason, writes nothing', async () => {
    const parsed = parsedWith([])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(false)
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('empty parse: cells with only blank activity names refuses, writes nothing', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: '', locationName: null }])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(false)
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('deterministic-id idempotency: re-import of the same parse against the same set produces identical ids', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }]
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])
    const repo1 = mockRepo()
    const repo2 = mockRepo()

    await populateElectiveSet(parsed, { electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo: repo1, existingActivities, existingOfferings: [] })
    await populateElectiveSet(parsed, { electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo: repo2, existingActivities, existingOfferings: [] })

    const ids1 = repo1.calls.filter((c) => c.entity === 'elective_set_activities').map((c) => c.id)
    const ids2 = repo2.calls.filter((c) => c.entity === 'elective_set_activities').map((c) => c.id)
    expect(ids1).toEqual(ids2)
  })

  it('ignores timeIndex/groupIndex/locationName — a flat list, not a 2D grid', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }]
    const parsed = parsedWith([
      { timeIndex: 3, groupIndex: 7, activityName: 'Swim', locationName: 'Pool' },
      { timeIndex: 4, groupIndex: 9, activityName: 'Swim', locationName: 'Lake' },
    ])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities, existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    const rows = repo.calls.filter((c) => c.entity === 'elective_set_activities')
    expect(rows).toHaveLength(1)
    expect(rows[0].fields).not.toHaveProperty('location_id')
  })
})
