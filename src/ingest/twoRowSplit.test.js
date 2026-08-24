// Slice 1 of docs/adr/2026-08-23-two-rows-multipattern-split.md — the whole
// data-shape risk lives in this pure function, so it is test-first. Mirrors
// electiveSetPopulate.test.js's mock-repo shape (real createActivity, no
// mocking of the dedup logic itself).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { emitTwoRowSplit, DEFAULT_SPLIT_SUFFIX } from './twoRowSplit'

const CAMP_ID = 'camp-1'

function mockRepo() {
  const calls = []
  return {
    calls,
    writeFields: vi.fn(async (entity, id, fields) => { calls.push({ entity, id, fields }) }),
    writeActivityFields: vi.fn(async (activityId, fields) => { calls.push({ entity: 'activities', id: activityId, fields }) }),
  }
}

describe('emitTwoRowSplit', () => {
  let repo

  beforeEach(() => {
    repo = mockRepo()
  })

  it('happy path: stamps the existing row asserted and creates a suffixed row with the given status', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: null }

    const result = await emitTwoRowSplit({
      repo,
      existingActivity,
      existingActivities: [existingActivity],
      newRowStatus: 'obligation',
    })

    expect(result.outcome).toBe('split')
    expect(result.created).toBe(true)
    expect(result.newActivityName).toBe('Swim (rec)')
    expect(result.existingActivityId).toBe('act-swim')

    const existingWrite = repo.calls.find((c) => c.entity === 'activities' && c.id === 'act-swim')
    expect(existingWrite.fields).toEqual({ recurrence_truth_status: 'asserted' })

    // new row goes through createActivity (writeActivityFields), not a raw insert
    expect(repo.writeActivityFields).toHaveBeenCalledTimes(1)
    const [newId, newFields] = repo.writeActivityFields.mock.calls[0]
    expect(newFields.name).toBe('Swim (rec)')
    expect(newFields.camp_id).toBe(CAMP_ID)

    const statusWrite = repo.calls.find((c) => c.entity === 'activities' && c.id === newId && 'recurrence_truth_status' in c.fields)
    expect(statusWrite.fields).toEqual({ recurrence_truth_status: 'obligation' })
    expect(result.newActivityId).toBe(newId)
  })

  it('respects the UNIQUE(camp_id, name) constraint: the two rows get distinct stored names', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: null }

    await emitTwoRowSplit({ repo, existingActivity, existingActivities: [existingActivity], newRowStatus: 'obligation' })

    const names = repo.writeActivityFields.mock.calls.map((c) => c[1].name)
    expect(names).toEqual(['Swim (rec)'])
    expect(names[0]).not.toBe(existingActivity.name)
  })

  it('leaves the new row blank (no status write) when newRowStatus is not given (elective flexible pattern)', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: null }

    const result = await emitTwoRowSplit({ repo, existingActivity, existingActivities: [existingActivity] })

    expect(result.created).toBe(true)
    const statusWrite = repo.calls.find((c) => c.entity === 'activities' && c.id === result.newActivityId && 'recurrence_truth_status' in c.fields)
    expect(statusWrite).toBeUndefined()
  })

  it('collision: a pre-existing row with the suffixed name yields outcome collision and writes NOTHING (Red Hat MED-HIGH)', async () => {
    // Name alone cannot tell an earlier split-counterpart (safe reuse) from an
    // unrelated activity the director independently named "Swim (rec)" — both
    // must NOT have flexible data attached blindly. Guard returns before any
    // write; Slice 2 asks the director to reuse/rename/cancel.
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: 'asserted' }
    const collidingRow = { id: 'act-swim-rec', name: 'Swim (rec)', camp_id: CAMP_ID, recurrence_truth_status: 'obligation' }

    const result = await emitTwoRowSplit({
      repo,
      existingActivity,
      existingActivities: [existingActivity, collidingRow],
      newRowStatus: 'obligation',
    })

    expect(result.outcome).toBe('collision')
    expect(result.created).toBe(false)
    expect(result.newActivityId).toBe('act-swim-rec')
    // No writes at all — not even the existing-row 'asserted' stamp.
    expect(repo.writeActivityFields).not.toHaveBeenCalled()
    expect(repo.calls).toHaveLength(0)
  })

  it('degenerate: an empty/whitespace suffix is rejected and writes NOTHING (Red Hat HIGH)', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: null }

    for (const suffix of ['', '   ']) {
      const r = mockRepo()
      const result = await emitTwoRowSplit({
        repo: r, existingActivity, existingActivities: [existingActivity], newRowStatus: 'obligation', suffix,
      })
      expect(result.outcome).toBe('degenerate')
      expect(result.newActivityId).toBeNull()
      // Crucially, the existing row is NOT stamped 'asserted' on a rejected split.
      expect(r.calls).toHaveLength(0)
      expect(r.writeActivityFields).not.toHaveBeenCalled()
    }
  })

  it('is idempotent on the existing row: does not re-write recurrence_truth_status when already asserted', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: 'asserted' }

    await emitTwoRowSplit({ repo, existingActivity, existingActivities: [existingActivity], newRowStatus: 'obligation' })

    const existingWrite = repo.calls.find((c) => c.entity === 'activities' && c.id === 'act-swim')
    expect(existingWrite).toBeUndefined()
  })

  it('is INTENTIONALLY destructive on the existing row when it carries a different status (director-confirmed action)', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: 'permission' }

    await emitTwoRowSplit({ repo, existingActivity, existingActivities: [existingActivity], newRowStatus: 'obligation' })

    const existingWrite = repo.calls.find((c) => c.entity === 'activities' && c.id === 'act-swim')
    expect(existingWrite.fields).toEqual({ recurrence_truth_status: 'asserted' })
  })

  it('uses the default " (rec)" suffix', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: null }
    const result = await emitTwoRowSplit({ repo, existingActivity, existingActivities: [existingActivity], newRowStatus: 'obligation' })
    expect(result.newActivityName).toBe(`Swim${DEFAULT_SPLIT_SUFFIX}`)
  })

  it('honors a director-edited suffix (OD-2)', async () => {
    const existingActivity = { id: 'act-swim', name: 'Swim', camp_id: CAMP_ID, recurrence_truth_status: null }
    const result = await emitTwoRowSplit({
      repo, existingActivity, existingActivities: [existingActivity], newRowStatus: 'obligation', suffix: ' (flex)',
    })
    expect(result.newActivityName).toBe('Swim (flex)')
  })
})
