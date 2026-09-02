// @vitest-environment jsdom
//
// T117 slice 2 dev/mock parity: the mock's ingestCommit `placements` fan-out
// (src/localClient.mock.js) must resolve them via the SAME
// electron/ops/resolveImportedPlacements.js pure function the real
// materializeImportedVersion.js calls, and land a schedule_snapshots row in
// the mock's in-memory store — so :5200 can be used to verify the flow
// without Electron.

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
    time_blocks: [{ id: 'tb1', camp_id: 'camp1', cohort_id: null, name: '09:00' }],
    days_of_operation: [{ id: 'd1', camp_id: 'camp1', label: 'Monday' }],
    groups: [{ id: 'g1', camp_id: 'camp1', name: 'Bunk 1' }],
    activities: [{ id: 'a1', camp_id: 'camp1', name: 'Swim' }],
    anchor_activities: [],
    schedule_weeks: [{ id: 'w1', camp_id: 'camp1', name: 'Week 1', sort_order: 0, is_archived: 0 }],
    schedule_templates: [],
    schedule_snapshots: [],
  }
}

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage()
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
  globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(seedState()))
})

describe('mockShoresh.ingestCommit — placements materialize a version (T117 slice 2)', () => {
  it('does not throw and creates a schedule_snapshots row for a resolvable placement', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const outcome = await mockShoresh.ingestCommit({
      approved: {},
      cohort_id: null,
      placements: [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }],
    })

    expect(outcome.version.created).toBe(true)
    expect(outcome.version.unresolvedCount).toBe(0)

    const state = JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
    expect(state.schedule_snapshots).toHaveLength(1)
    expect(state.schedule_snapshots[0].id).toBe(outcome.version.snapshotId)
    const slots = JSON.parse(state.schedule_snapshots[0].slots)
    expect(slots).toEqual([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'tb1', activity_id: 'a1', anchor_id: null, is_anchor: false, flags: {} },
    ])
    expect(state.schedule_templates.find((t) => t.week_id === 'w1' && t.kind === 'manual')).toBeTruthy()
  })

  it('omits outcome.version when no placements were passed (back-compat)', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const outcome = await mockShoresh.ingestCommit({ approved: {}, cohort_id: null })
    expect(outcome.version).toBeUndefined()
  })
})
