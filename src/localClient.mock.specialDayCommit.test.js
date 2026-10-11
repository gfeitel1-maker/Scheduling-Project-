// @vitest-environment jsdom
//
// Mock parity for the one-day-file special day (electron/ops/ingest.js plan.specialDay): ingestCommit({ specialDay })
// writes the day, its periods and cells, and mints unmatched activities, so :5200 shows what electron:dev would.

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

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage()
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
  globalThis.localStorage.setItem(STORE_KEY, JSON.stringify({
    camp: { id: 'camp1', name: 'Camp' }, users: [], conflicts: [], devices: [], __fieldSource: {},
    groups: [{ id: 'g1', camp_id: 'camp1', name: 'Red' }],
    activities: [{ id: 'a1', camp_id: 'camp1', name: 'Relay' }],
  }))
})

const day = () => ({
  name: 'Maccabiah',
  columns: [{ columnName: 'Red', groupId: 'g1' }],
  timeBlocks: [{ name: '9:15', sort_order: 0, start_time: '9:15', end_time: null }],
  activities: [{ name: 'Relay', activityId: 'a1' }, { name: 'Tug', activityId: null }],
  slots: [{ columnName: 'Red', blockName: '9:15', activityName: 'Tug' }],
  notes: 'n',
  ready: true,
  blockedBy: [],
})

describe('mockShoresh.ingestCommit — specialDay', () => {
  it('writes the day, its period and its cell, minting the unmatched activity', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const out = await mockShoresh.ingestCommit({ approved: {}, links: {}, mode: 'add', specialDay: day() })
    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    expect(state.special_days).toHaveLength(1)
    expect(state.special_days[0]).toMatchObject({ name: 'Maccabiah', camp_id: 'camp1', notes: 'n' })
    expect(state.special_day_time_blocks).toHaveLength(1)
    const tug = state.activities.find((a) => a.name === 'Tug')
    expect(tug).toBeTruthy()
    expect(state.special_day_slots).toHaveLength(1)
    expect(state.special_day_slots[0]).toMatchObject({ special_day_id: state.special_days[0].id, group_id: 'g1', activity_id: tug.id })
    expect(out.specialDay).toMatchObject({ created: true, periods: 1, cells: 1, activitiesCreated: 1 })
  })

  it('a same-named live day is left alone', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.ingestCommit({ approved: {}, links: {}, mode: 'add', specialDay: day() })
    const out = await mockShoresh.ingestCommit({ approved: {}, links: {}, mode: 'add', specialDay: day() })
    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    expect(state.special_days).toHaveLength(1)
    expect(out.specialDay).toMatchObject({ created: false })
  })
})
