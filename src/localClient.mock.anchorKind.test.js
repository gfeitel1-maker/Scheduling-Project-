// @vitest-environment jsdom
//
// Dev/mock parity for anchor_activities.kind (docs/adr/2026-08-28-fixed-vs-
// recurring-events.md §6/§8.4): the mock's ingestCommit fixed-events fan-out
// (src/localClient.mock.js ~line 976) must attach the same `kind` the real
// commit path (electron/ops/ingest.js) does, for the same input — same isAll
// test, same result — so the dev-mock environment used at :5200 doesn't
// silently diverge from electron:dev.

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
    users: [],
    conflicts: [],
    devices: [],
    __fieldSource: {},
    time_blocks: [{ id: 'tb1', camp_id: 'camp1', cohort_id: null, name: 'Morning' }],
    days_of_operation: [{ id: 'd1', camp_id: 'camp1', label: 'Monday' }],
    groups: [
      { id: 'g1', camp_id: 'camp1', name: 'Group A' },
      { id: 'g2', camp_id: 'camp1', name: 'Group B' },
    ],
    anchor_activities: [],
  }
}

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage()
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
  globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(seedState()))
})

describe('mockShoresh.ingestCommit — anchor_activities.kind parity with the real commit path', () => {
  it('an all-groups fixed event commits as kind=fixed (mirrors electron/ops/ingest.js)', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.ingestCommit({
      approved: {},
      cohort_id: null,
      fixedEvents: [{
        name: 'Flagpole', time_block: 'Morning', days: ['Monday'],
        scope: { is_all_groups: true, groups: null },
      }],
    })
    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    const row = state.anchor_activities.find((a) => a.name === 'Flagpole')
    expect(row).toBeTruthy()
    expect(row.is_all_groups).toBe(1)
    expect(row.kind).toBe('fixed')
  })

  it('a group-scoped subset event commits as kind=recurring', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.ingestCommit({
      approved: {},
      cohort_id: null,
      fixedEvents: [{
        name: 'Lunch A', time_block: 'Morning', days: ['Monday'],
        scope: { is_all_groups: false, groups: ['Group A'] },
      }],
    })
    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    const row = state.anchor_activities.find((a) => a.name === 'Lunch A')
    expect(row).toBeTruthy()
    expect(row.is_all_groups).toBe(0)
    expect(row.kind).toBe('recurring')
  })
})
