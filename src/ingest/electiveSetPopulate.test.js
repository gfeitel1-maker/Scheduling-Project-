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
    // v66 (T194): an imported offering has no declared cap. Written explicitly
    // rather than left to the column DEFAULT — a projection write is a
    // field-by-field UPDATE, and the default only applies to the insert.
    expect(swimWrite.fields).toEqual({ elective_set_id: ELECTIVE_SET_ID, activity_id: 'act-swim', capacity_mode: 'unlimited', capacity_limit: null, status: 'potential' })

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

  // T195 (offering-grid import) replaced the old refuse-on-nonempty gate with
  // a per-row potential-only upsert: import can never regress a director's
  // confirmed decision, and an already-nonempty set no longer blocks the
  // whole file — activities not yet decided just land as 'potential'.
  it('a nonempty set no longer refuses the whole import — unrelated existing offerings are untouched', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }, { id: 'act-existing', name: 'Yoga' }]
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities,
      existingOfferings: [{ id: 'off-1', activity_id: 'act-existing', status: 'confirmed' }],
    })

    expect(result.ok).toBe(true)
    expect(repo.calls.some((c) => c.entity === 'elective_set_activities' && c.id === 'off-1')).toBe(false)
    const swimId = deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')
    expect(repo.calls.some((c) => c.entity === 'elective_set_activities' && c.id === swimId)).toBe(true)
  })

  it('confirmed-row skip: a matched activity already confirmed is left completely untouched', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }]
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])
    const rowId = deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities,
      existingOfferings: [{ id: rowId, activity_id: 'act-swim', status: 'confirmed' }],
    })

    expect(result.ok).toBe(true)
    expect(repo.calls.some((c) => c.entity === 'elective_set_activities' && c.id === rowId)).toBe(false)
  })

  it('potential-row idempotency: a matched activity already potential is rewritten, not skipped', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }]
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])
    const rowId = deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities,
      existingOfferings: [{ id: rowId, activity_id: 'act-swim', status: 'potential' }],
    })

    expect(result.ok).toBe(true)
    const write = repo.calls.find((c) => c.entity === 'elective_set_activities' && c.id === rowId)
    expect(write.fields.status).toBe('potential')
  })

  it('new rows are written with status potential, never confirmed', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }]
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities, existingOfferings: [],
    })

    const swimId = deriveElectiveImportId(ELECTIVE_SET_ID, 'act-swim')
    const write = repo.calls.find((c) => c.entity === 'elective_set_activities' && c.id === swimId)
    expect(write.fields.status).toBe('potential')
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

  it('permission-tier: a newly-created offering activity is marked recurrence_truth_status permission', async () => {
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Archery', locationName: null }])

    const result = await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities: [], existingOfferings: [],
    })

    expect(result.ok).toBe(true)
    const [newActivityId] = repo.writeActivityFields.mock.calls[0]
    const permissionWrite = repo.calls.find((c) => c.entity === 'activities' && c.id === newActivityId && c.fields.recurrence_truth_status)
    expect(permissionWrite.fields).toEqual({ recurrence_truth_status: 'permission' })
  })

  it('permission-tier: non-destructive — does NOT overwrite a prior obligation/asserted on a matched existing activity', async () => {
    // "Swim" is a fixed/obligation block reused as an elective (routine name
    // collision). The single recurrence_truth_status column can't hold both;
    // collapsing to 'permission' would silently destroy the obligation evidence
    // on a synced column. Coexistence is owner priority #5 (two-rows split).
    const existingActivities = [{ id: 'act-swim', name: 'Swim', recurrence_truth_status: 'obligation' }]
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities, existingOfferings: [],
    })

    const truthWrite = repo.calls.find((c) => c.entity === 'activities' && c.id === 'act-swim' && c.fields.recurrence_truth_status)
    expect(truthWrite).toBeUndefined()
  })

  it('permission-tier: idempotent — an already-permission matched activity gets no redundant write', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim', recurrence_truth_status: 'permission' }]
    const parsed = parsedWith([{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }])

    await populateElectiveSet(parsed, {
      electiveSetId: ELECTIVE_SET_ID, campId: CAMP_ID, repo, existingActivities, existingOfferings: [],
    })

    expect(repo.calls.some((c) => c.entity === 'activities')).toBe(false)
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
