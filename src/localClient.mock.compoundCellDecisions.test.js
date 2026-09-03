// @vitest-environment jsdom
//
// T118 slice 4 dev/mock parity: the mock's ingestCommit `compoundCellDecisions`
// fan-out and listCompoundCellDecisions (src/localClient.mock.js) must mirror
// the real IPC boundary's OBSERVABLE contract — a resolved decision is
// recorded (upsert by pattern) and readable back on the next call — so :5200
// can be used to verify the ImportScreen flow without Electron.
// docs/adr/2026-09-03-compound-cell-interpretation.md.

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
    groups: [],
    tiers: [],
    days_of_operation: [],
    time_blocks: [],
    locations: [],
    activities: [],
    cohorts: [],
    anchor_activities: [],
  }
}

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage()
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
  globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(seedState()))
})

describe('mockShoresh.ingestCommit — compound-cell decisions (T118 slice 4)', () => {
  it('records a resolved decision, reported in outcome.compoundCellDecisionsWritten', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const outcome = await mockShoresh.ingestCommit({
      approved: {},
      cohort_id: null,
      compoundCellDecisions: [
        { pattern: 'Lunch + Leave', interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' },
      ],
    })

    expect(outcome.compoundCellDecisionsWritten).toEqual({ count: 1, failed: [] })

    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    expect(state.__compoundCellDecisions).toEqual([
      { pattern: 'Lunch + Leave', interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' },
    ])
  })

  it('a second confirmation for the same pattern updates rather than duplicates', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.ingestCommit({
      approved: {},
      cohort_id: null,
      compoundCellDecisions: [
        { pattern: 'Lunch + Leave', interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' },
      ],
    })
    await mockShoresh.ingestCommit({
      approved: {},
      cohort_id: null,
      compoundCellDecisions: [{ pattern: 'Lunch + Leave', interpretation: 'as_written' }],
    })

    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    expect(state.__compoundCellDecisions).toHaveLength(1)
    expect(state.__compoundCellDecisions[0].interpretation).toBe('as_written')
  })

  it('omits outcome.compoundCellDecisionsWritten when none were passed (back-compat)', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const outcome = await mockShoresh.ingestCommit({ approved: {}, cohort_id: null })
    expect(outcome.compoundCellDecisionsWritten).toBeUndefined()
  })

  it('listCompoundCellDecisions reads back what was recorded, in the [pattern, value] shape localClient.js expects', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.ingestCommit({
      approved: {},
      cohort_id: null,
      compoundCellDecisions: [
        { pattern: 'Lunch + Leave', interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' },
      ],
    })

    const entries = await mockShoresh.listCompoundCellDecisions()
    expect(entries).toEqual([
      ['Lunch + Leave', { interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' }],
    ])
  })

  it('a dry run (ingestReconcile) never records a decision', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.ingestReconcile({ approved: {}, cohort_id: null })
    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    expect(state.__compoundCellDecisions).toBeUndefined()
  })
})
