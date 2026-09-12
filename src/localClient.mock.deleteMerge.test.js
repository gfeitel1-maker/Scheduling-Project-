// @vitest-environment jsdom
//
// The mock's deleteRecord and mergeLocation were stubs that returned
// { error: 'no-record' } for every call. The plumbing on both paths is
// complete end to end — preload, IPC handler, electron/ops/deleteRecord.js —
// so the operations worked in the packaged app and were dead at :5200, where
// the app is demonstrated. "Delete does not work" and "merge into a location
// does not work" were both this.
//
// These tests pin the behaviour so neither can quietly become a stub again.

import { describe, it, expect, beforeEach } from 'vitest'

const STORE_KEY = 'shoresh-mock-state'

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

function seedState() {
  return {
    camp: { id: 'camp1', name: 'Camp' },
    users: [], conflicts: [], devices: [], __fieldSource: {},
    time_blocks: [], days_of_operation: [], anchor_activities: [],
    schedule_weeks: [], schedule_templates: [], schedule_snapshots: [],
    groups: [{ id: 'g1', camp_id: 'camp1', name: 'Bunk 1' }],
    locations: [
      { id: 'l1', camp_id: 'camp1', name: 'Pool', capacity: 20 },
      { id: 'l2', camp_id: 'camp1', name: 'The Pool', capacity: null },
    ],
    activities: [
      { id: 'a1', camp_id: 'camp1', name: 'Swim', location_id: 'l2' },
      { id: 'a2', camp_id: 'camp1', name: 'Dive', location_id: 'l2' },
      { id: 'a3', camp_id: 'camp1', name: 'Art', location_id: 'l1' },
    ],
  }
}

function readState() {
  return JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
}

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage()
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
  globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(seedState()))
})

describe('mockShoresh.deleteRecord', () => {
  it('actually removes the record instead of refusing', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const result = await mockShoresh.deleteRecord({ entity: 'activities', entity_id: 'a1' })

    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.name).toBe('Swim')
    expect(readState().activities.map((a) => a.id)).toEqual(['a2', 'a3'])
  })

  it('reports a record that is not there rather than silently succeeding', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    expect((await mockShoresh.deleteRecord({ entity: 'activities', entity_id: 'nope' })).error).toBe('no-record')
    expect((await mockShoresh.deleteRecord({ entity: 'activities' })).error).toBe('no-record')
  })

  it('reads a day by its own name column, not a name field it does not have', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const state = readState()
    state.days_of_operation = [{ id: 'd1', camp_id: 'camp1', label: 'Monday' }]
    globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(state))

    const result = await mockShoresh.deleteRecord({ entity: 'days_of_operation', entity_id: 'd1' })
    expect(result.name).toBe('Monday')
    expect(result.destructive).toBe(true)
  })
})

describe('mockShoresh.mergeLocation', () => {
  it('repoints the loser’s activities at the winner and removes the loser', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const result = await mockShoresh.mergeLocation({ loser_id: 'l2', winner_id: 'l1' })

    expect(result.error).toBeUndefined()
    expect(result.moved).toBe(2)

    const state = readState()
    expect(state.locations.map((l) => l.id)).toEqual(['l1'])
    expect(state.activities.every((a) => a.location_id === 'l1')).toBe(true)
  })

  it('takes the surviving capacity onto the winner when one is chosen', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.mergeLocation({ loser_id: 'l1', winner_id: 'l2', winner_capacity: 20 })

    expect(readState().locations.find((l) => l.id === 'l2').capacity).toBe(20)
  })

  it('leaves capacity alone when none is passed', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.mergeLocation({ loser_id: 'l2', winner_id: 'l1' })

    expect(readState().locations.find((l) => l.id === 'l1').capacity).toBe(20)
  })

  it('refuses a missing side, and refuses merging a location into itself', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    expect((await mockShoresh.mergeLocation({ loser_id: 'l1', winner_id: 'gone' })).error).toBe('no-record')
    expect((await mockShoresh.mergeLocation({ loser_id: 'l1', winner_id: 'l1' })).error).toBe('no-record')
    expect(readState().locations).toHaveLength(2)
  })
})
