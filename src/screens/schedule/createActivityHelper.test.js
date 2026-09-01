import { describe, it, expect, vi } from 'vitest'
import { createActivity, newActivityDefaultFields } from './createActivityHelper'

function makeRepo(overrides = {}) {
  return {
    writeActivityFields: vi.fn(async () => ({ status: 'applied' })),
    ...overrides,
  }
}

describe('newActivityDefaultFields', () => {
  it('builds the usage-derived default field set byte-identical to the T105 shape', () => {
    expect(newActivityDefaultFields('Kayaking', 'camp-1')).toEqual({
      name: 'Kayaking',
      camp_id: 'camp-1',
      priority: null,
      is_locked: false,
      span_blocks: 1,
      location_id: null,
      is_outdoor: false,
      max_groups_per_slot: 1,
      min_per_week: 1,
      max_per_week: null,
      same_tier_only: false,
      eligible_tier_ids: [],
      eligible_group_ids: [],
      prefer_before_day: null,
      prefer_before_day_min: null,
      weather_alternative_id: null,
      notes: null,
    })
  })
})

describe('createActivity', () => {
  it('mints a new activity on no dedupe match: writes fields, returns {activityId, activity, isNew:true}', async () => {
    const repo = makeRepo()
    const result = await createActivity({ name: 'Kayaking', groupId: 'g1', campId: 'camp-1', activities: [] }, repo)

    expect(repo.writeActivityFields).toHaveBeenCalledTimes(1)
    const [writtenId, fields] = repo.writeActivityFields.mock.calls[0]
    expect(fields).toMatchObject({ name: 'Kayaking', camp_id: 'camp-1', min_per_week: 1, max_per_week: null })
    expect(result.isNew).toBe(true)
    expect(result.activityId).toBe(writtenId)
    expect(result.activity).toEqual({ id: writtenId, ...fields })
  })

  it('a normalized-name dedupe hit returns the existing activity, isNew:false, with NO write', async () => {
    const repo = makeRepo()
    const existing = { id: 'act-existing', name: 'Kayaking', eligible_tier_ids: [], eligible_group_ids: [] }
    const result = await createActivity({ name: '  kayaking  ', groupId: 'g1', campId: 'camp-1', activities: [existing] }, repo)

    expect(repo.writeActivityFields).not.toHaveBeenCalled()
    expect(result).toEqual({ activityId: 'act-existing', activity: existing, isNew: false })
  })

  it('a whitespace/case typo-variant REUSES the existing activity (no duplicate minted)', async () => {
    const repo = makeRepo()
    const existing = { id: 'act-lunch2', name: 'Lunch 2', eligible_tier_ids: [], eligible_group_ids: [] }
    // typing "Lunch2" (no space) when "Lunch 2" exists must not mint a second one
    const result = await createActivity({ name: 'Lunch2', groupId: 'g1', campId: 'camp-1', activities: [existing] }, repo)
    expect(repo.writeActivityFields).not.toHaveBeenCalled()
    expect(result).toEqual({ activityId: 'act-lunch2', activity: existing, isNew: false })
  })

  it('does NOT merge a word-ending variant — "Swim Returning" mints distinct from "Swim Return"', async () => {
    const repo = makeRepo()
    const existing = { id: 'act-swimreturn', name: 'Swim Return', eligible_tier_ids: [], eligible_group_ids: [] }
    const result = await createActivity({ name: 'Swim Returning', groupId: 'g1', campId: 'camp-1', activities: [existing] }, repo)
    expect(repo.writeActivityFields).toHaveBeenCalledTimes(1)
    expect(result.isNew).toBe(true)
  })

  it('trims the name before dedupe/mint', async () => {
    const repo = makeRepo()
    const result = await createActivity({ name: '  Archery  ', groupId: 'g1', campId: 'camp-1', activities: [] }, repo)
    expect(result.activity.name).toBe('Archery')
  })

  it('propagates a write failure to the caller (no swallowed error)', async () => {
    const repo = makeRepo({ writeActivityFields: vi.fn(async () => { throw new Error('boom') }) })
    await expect(createActivity({ name: 'Kayaking', groupId: 'g1', campId: 'camp-1', activities: [] }, repo))
      .rejects.toThrow('boom')
  })
})
