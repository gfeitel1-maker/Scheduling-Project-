// docs/work/specs/2026-08-22-event-schedule-import-slices.md Step 2 + 3.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deriveEventImportId, populateEventGrid } from './eventGridPopulate'

const EVENT_ID = 'evt-1'
const CAMP_ID = 'camp-1'

function mockRepo() {
  const calls = []
  return {
    calls,
    writeField: vi.fn(async (entity, id, field, value) => { calls.push({ entity, id, field, value }) }),
    writeActivityFields: vi.fn(async (activityId, fields) => { calls.push({ entity: 'activities', id: activityId, fields }) }),
  }
}

function confidentParse({ timeAxis, groupAxis, cells, unmapped = [] }) {
  return { orientation: { axis: 'rows-are-time', confident: true }, timeAxis, groupAxis, cells, unmapped, locationKey: null }
}

const TWO_BY_TWO = confidentParse({
  timeAxis: [
    { name: '9:30-10:10', start_time: '09:30', end_time: '10:10', sourceLabel: '9:30-10:10', sourceIndex: 0 },
    { name: '10:15-10:55', start_time: '10:15', end_time: '10:55', sourceLabel: '10:15-10:55', sourceIndex: 1 },
  ],
  groupAxis: [
    { name: 'Kinders', sourceLabel: 'Kinders', sourceIndex: 0 },
    { name: '1st Grade', sourceLabel: '1st Grade', sourceIndex: 1 },
  ],
  cells: [
    { timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null },
    { timeIndex: 0, groupIndex: 1, activityName: 'Zumba', locationName: null },
    { timeIndex: 1, groupIndex: 0, activityName: 'Zumba', locationName: null },
    { timeIndex: 1, groupIndex: 1, activityName: 'Swim', locationName: null },
  ],
})

describe('deriveEventImportId', () => {
  it('is deterministic for identical inputs', () => {
    expect(deriveEventImportId(EVENT_ID, 'block', 0)).toBe(deriveEventImportId(EVENT_ID, 'block', 0))
    expect(deriveEventImportId(EVENT_ID, 'group', 3)).toBe(deriveEventImportId(EVENT_ID, 'group', 3))
    expect(deriveEventImportId(EVENT_ID, 'slot', '0:1')).toBe(deriveEventImportId(EVENT_ID, 'slot', '0:1'))
  })

  it('differs for a different sourceSignature', () => {
    expect(deriveEventImportId(EVENT_ID, 'block', 0)).not.toBe(deriveEventImportId(EVENT_ID, 'block', 1))
  })

  it('never collides with deriveEventSeedId\'s id space (different literal prefix)', () => {
    const importId = deriveEventImportId(EVENT_ID, 'block', 0)
    const seedId = `event-seed:${EVENT_ID}:block:0`
    expect(importId).not.toBe(seedId)
    expect(importId.startsWith('event-import:')).toBe(true)
    expect(seedId.startsWith('event-seed:')).toBe(true)
  })
})

describe('populateEventGrid', () => {
  let repo

  beforeEach(() => {
    repo = mockRepo()
  })

  it('happy path: writes event_time_blocks/event_groups/event_slots keyed by deriveEventImportId, matching existing activities', async () => {
    const existingActivities = [
      { id: 'act-swim', name: 'Swim' },
      { id: 'act-zumba', name: 'Zumba' },
    ]
    const result = await populateEventGrid(TWO_BY_TWO, {
      eventId: EVENT_ID, campId: CAMP_ID,
      existingLocations: [], existingActivities, existingEventSlots: [],
    }, repo)

    expect(result.ok).toBe(true)
    expect(repo.writeActivityFields).not.toHaveBeenCalled()

    const blockWrites = repo.calls.filter((c) => c.entity === 'event_time_blocks')
    expect(blockWrites.some((c) => c.id === deriveEventImportId(EVENT_ID, 'block', 0) && c.field === 'name' && c.value === '9:30-10:10')).toBe(true)

    const groupWrites = repo.calls.filter((c) => c.entity === 'event_groups')
    expect(groupWrites.some((c) => c.id === deriveEventImportId(EVENT_ID, 'group', 0) && c.field === 'name' && c.value === 'Kinders')).toBe(true)

    const slotId = deriveEventImportId(EVENT_ID, 'slot', '0:0')
    const activityWrite = repo.calls.find((c) => c.entity === 'event_slots' && c.id === slotId && c.field === 'activity_id')
    expect(activityWrite.value).toBe('act-swim')
  })

  it('create-if-new: an activity name not in existingActivities is created via createActivity', async () => {
    const result = await populateEventGrid(TWO_BY_TWO, {
      eventId: EVENT_ID, campId: CAMP_ID,
      existingLocations: [], existingActivities: [], existingEventSlots: [],
    }, repo)

    expect(result.ok).toBe(true)
    expect(repo.writeActivityFields).toHaveBeenCalled()
    const [, fields] = repo.writeActivityFields.mock.calls[0]
    expect(fields).toMatchObject({ camp_id: CAMP_ID, min_per_week: 1, max_per_week: null })

    const slotId = deriveEventImportId(EVENT_ID, 'slot', '0:0')
    const activityWrite = repo.calls.find((c) => c.entity === 'event_slots' && c.id === slotId && c.field === 'activity_id')
    // new id came from repo.writeActivityFields' own call, not existingActivities
    const newActivityId = repo.writeActivityFields.mock.calls[0][0]
    expect(activityWrite.value).toBe(newActivityId)
  })

  it('location match: recognitionKey is trim-only case-sensitive for locations', async () => {
    const withLocation = confidentParse({
      timeAxis: TWO_BY_TWO.timeAxis,
      groupAxis: TWO_BY_TWO.groupAxis,
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: 'Pool' }],
    })
    const existingLocations = [{ id: 'loc-pool', name: 'Pool' }]
    const result = await populateEventGrid(withLocation, {
      eventId: EVENT_ID, campId: CAMP_ID,
      existingLocations, existingActivities: [{ id: 'act-swim', name: 'Swim' }], existingEventSlots: [],
    }, repo)

    expect(result.ok).toBe(true)
    const slotId = deriveEventImportId(EVENT_ID, 'slot', '0:0')
    const locWrite = repo.calls.find((c) => c.entity === 'event_slots' && c.id === slotId && c.field === 'location_id')
    expect(locWrite.value).toBe('loc-pool')
  })

  it('location case differs: does NOT match ("pool" != "Pool")', async () => {
    const withLocation = confidentParse({
      timeAxis: TWO_BY_TWO.timeAxis,
      groupAxis: TWO_BY_TWO.groupAxis,
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: 'pool' }],
    })
    const existingLocations = [{ id: 'loc-pool', name: 'Pool' }]
    const result = await populateEventGrid(withLocation, {
      eventId: EVENT_ID, campId: CAMP_ID,
      existingLocations, existingActivities: [{ id: 'act-swim', name: 'Swim' }], existingEventSlots: [],
    }, repo)

    expect(result.ok).toBe(true)
    const slotId = deriveEventImportId(EVENT_ID, 'slot', '0:0')
    const locWrite = repo.calls.find((c) => c.entity === 'event_slots' && c.id === slotId && c.field === 'location_id')
    expect(locWrite).toBeUndefined()
    expect(result.unmapped.some((u) => u.sourceExcerpt === 'pool')).toBe(true)
  })

  it('location unmapped: no match in existingLocations leaves location_id unset and reports unmapped', async () => {
    const withLocation = confidentParse({
      timeAxis: TWO_BY_TWO.timeAxis,
      groupAxis: TWO_BY_TWO.groupAxis,
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: 'Field' }],
    })
    const result = await populateEventGrid(withLocation, {
      eventId: EVENT_ID, campId: CAMP_ID,
      existingLocations: [], existingActivities: [{ id: 'act-swim', name: 'Swim' }], existingEventSlots: [],
    }, repo)

    expect(result.ok).toBe(true)
    const slotId = deriveEventImportId(EVENT_ID, 'slot', '0:0')
    const locWrite = repo.calls.find((c) => c.entity === 'event_slots' && c.id === slotId && c.field === 'location_id')
    expect(locWrite).toBeUndefined()
    expect(result.unmapped).toEqual(expect.arrayContaining([{ sourceExcerpt: 'Field', reason: 'no matching location for this cell' }]))
  })

  it('re-import idempotency: identical input + identical eventId produce identical ids on a second run', async () => {
    const existingActivities = [{ id: 'act-swim', name: 'Swim' }, { id: 'act-zumba', name: 'Zumba' }]
    const repo1 = mockRepo()
    const repo2 = mockRepo()
    await populateEventGrid(TWO_BY_TWO, { eventId: EVENT_ID, campId: CAMP_ID, existingLocations: [], existingActivities, existingEventSlots: [] }, repo1)
    await populateEventGrid(TWO_BY_TWO, { eventId: EVENT_ID, campId: CAMP_ID, existingLocations: [], existingActivities, existingEventSlots: [] }, repo2)

    const pairs1 = new Set(repo1.calls.map((c) => `${c.entity}:${c.id}`))
    const pairs2 = new Set(repo2.calls.map((c) => `${c.entity}:${c.id}`))
    expect(pairs1).toEqual(pairs2)
  })

  it('different file, same event, second import blocked when event_slots already has a placed activity', async () => {
    const result = await populateEventGrid(TWO_BY_TWO, {
      eventId: EVENT_ID, campId: CAMP_ID,
      existingLocations: [], existingActivities: [],
      existingEventSlots: [{ id: 's1', activity_id: 'act-existing' }],
    }, repo)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/already has entries/i)
    expect(repo.writeField).not.toHaveBeenCalled()
    expect(repo.writeActivityFields).not.toHaveBeenCalled()
  })

  it('not confident / not a grid: refuses with the orientation message, writes nothing', async () => {
    const notConfident = { orientation: { axis: null, confident: false }, timeAxis: [], groupAxis: [], cells: [], unmapped: [], locationKey: null }
    const result = await populateEventGrid(notConfident, {
      eventId: EVENT_ID, campId: CAMP_ID, existingLocations: [], existingActivities: [], existingEventSlots: [],
    }, repo)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/couldn't tell/i)
    expect(repo.writeField).not.toHaveBeenCalled()
  })

  it('partial parse surfaces unmapped but is not treated as a failure', async () => {
    const partial = confidentParse({
      timeAxis: TWO_BY_TWO.timeAxis,
      groupAxis: TWO_BY_TWO.groupAxis,
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: 'Field' }],
      unmapped: [{ sourceExcerpt: 'garbled cell', reason: 'could not read an activity name from this cell' }],
    })
    const result = await populateEventGrid(partial, {
      eventId: EVENT_ID, campId: CAMP_ID,
      existingLocations: [], existingActivities: [{ id: 'act-swim', name: 'Swim' }], existingEventSlots: [],
    }, repo)

    expect(result.ok).toBe(true)
    expect(result.unmapped.some((u) => u.sourceExcerpt === 'garbled cell')).toBe(true)
    // the mappable row was still written
    const slotId = deriveEventImportId(EVENT_ID, 'slot', '0:0')
    expect(repo.calls.some((c) => c.entity === 'event_slots' && c.id === slotId && c.field === 'activity_id')).toBe(true)
  })
})
