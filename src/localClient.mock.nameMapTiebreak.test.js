// @vitest-environment jsdom
//
// T252 round 2 — src/localClient.mock.js parity with the deterministic
// lowest-id tie-break landed in electron/ops/ingest.js and
// materializeImportedVersion.js (see electron/ops/ingest.nameMapTiebreak.test.js).
//
// Schema v73 relaxed the UNIQUE constraint on ten tables, so two rows can
// legitimately share a name after a cross-device merge. The mock is the
// parity oracle the ingest tests and `npm run dev` reproductions run
// against — every one of its own name->id maps must resolve a duplicate the
// same way: sort by id ASC, first-write-wins, so the lowest id always wins
// regardless of array order.
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

function setState(state) {
  globalThis.localStorage = makeLocalStorage()
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
  globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(state))
}

function getState() {
  return JSON.parse(globalThis.localStorage.getItem(STORE_KEY))
}

function baseState() {
  return {
    camp: { id: 'camp1', name: 'Camp' },
    users: [],
    conflicts: [],
    devices: [],
    __fieldSource: {},
    tiers: [],
    time_blocks: [],
    days_of_operation: [],
    groups: [],
    locations: [],
    activities: [],
    anchor_activities: [],
    schedule_weeks: [{ id: 'w1', camp_id: 'camp1', name: 'Week 1', sort_order: 0, is_archived: 0 }],
    schedule_templates: [],
    schedule_snapshots: [],
  }
}

beforeEach(() => {
  setState(baseState())
})

describe('T252 round 2 — placements nameMap() resolves duplicates to the lowest id', () => {
  it('resolves a duplicated group name to the lowest id regardless of array order, in both directions', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')

    async function run(order) {
      const state = baseState()
      state.time_blocks = [{ id: 'tb1', camp_id: 'camp1', cohort_id: null, name: '09:00' }]
      state.days_of_operation = [{ id: 'd1', camp_id: 'camp1', label: 'Monday' }]
      state.activities = [{ id: 'a1', camp_id: 'camp1', name: 'Swim' }]
      const groupLow = { id: 'aaa-group-low', camp_id: 'camp1', name: 'Bunk 1' }
      const groupHigh = { id: 'zzz-group-high', camp_id: 'camp1', name: 'Bunk 1' }
      state.groups = order === 'forward' ? [groupLow, groupHigh] : [groupHigh, groupLow]
      setState(state)
      const outcome = await mockShoresh.ingestCommit({
        approved: {},
        cohort_id: null,
        placements: [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }],
      })
      expect(outcome.version.created).toBe(true)
      expect(outcome.version.unresolvedCount).toBe(0)
      const s = getState()
      const slots = JSON.parse(s.schedule_snapshots[0].slots)
      return slots[0].group_id
    }

    expect(await run('forward')).toBe('aaa-group-low')
    expect(await run('reverse')).toBe('aaa-group-low')
  })
})

describe('T252 round 2 — fixed-events groupIdByName/blockIdByName resolve duplicates to the lowest id', () => {
  it('an anchor scoped to an ambiguous group/time-block name resolves to the lowest id in both insertion orders', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')

    async function run(order) {
      const state = baseState()
      state.days_of_operation = [{ id: 'd1', camp_id: 'camp1', label: 'Monday' }]
      const blockLow = { id: 'aaa-block-low', camp_id: 'camp1', cohort_id: null, name: '09:00' }
      const blockHigh = { id: 'zzz-block-high', camp_id: 'camp1', cohort_id: null, name: '09:00' }
      const groupLow = { id: 'aaa-group-low', camp_id: 'camp1', name: 'Bunk 1' }
      const groupHigh = { id: 'zzz-group-high', camp_id: 'camp1', name: 'Bunk 1' }
      state.time_blocks = order === 'forward' ? [blockLow, blockHigh] : [blockHigh, blockLow]
      state.groups = order === 'forward' ? [groupLow, groupHigh] : [groupHigh, groupLow]
      setState(state)
      const outcome = await mockShoresh.ingestCommit({
        approved: {},
        cohort_id: null,
        fixedEvents: [{
          name: 'Mifkad', time_block: '09:00', days: ['Monday'],
          scope: { is_all_groups: false, groups: ['Bunk 1'] },
        }],
      })
      expect(outcome.held).toBeFalsy()
      const s = getState()
      const anchor = s.anchor_activities[0]
      return anchor
    }

    const anchorForward = await run('forward')
    const anchorReverse = await run('reverse')
    expect(anchorForward.time_block_id).toBe('aaa-block-low')
    expect(anchorReverse.time_block_id).toBe('aaa-block-low')
    const groupsForward = anchorForward.group_ids ?? anchorForward.scope_groups ?? ''
    const groupsReverse = anchorReverse.group_ids ?? anchorReverse.scope_groups ?? ''
    expect(String(groupsForward)).toContain('aaa-group-low')
    expect(String(groupsReverse)).toContain('aaa-group-low')
  })
})

// Regression: the mock's commitCreate mirror (~1088-1096) used to
// unconditionally `.set()` into the SAME name maps its own seeding block
// (~884-892) carefully populated first-write-wins — so a row created THIS
// SAME ingestCommit call could evict the already-established lowest-id
// winner. Mirrors the real ingest.js FIX 1 regression test.
describe('T252 round 2 — mock commitCreate must not evict an already-seeded name-map winner', () => {
  it('groupIdByNameRun: a group created THIS run does not evict the established lowest-id "Bunk 1"', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const state = baseState()
    state.days_of_operation = [{ id: 'd1', camp_id: 'camp1', label: 'Monday' }]
    state.time_blocks = [{ id: 'tb1', camp_id: 'camp1', cohort_id: null, name: '09:00' }]
    const groupLow = { id: 'aaa-group-low', camp_id: 'camp1', name: 'Bunk 1' }
    const groupHigh = { id: 'zzz-group-high', camp_id: 'camp1', name: 'Bunk 1' }
    state.groups = [groupHigh, groupLow]
    setState(state)

    const outcome = await mockShoresh.ingestCommit({
      approved: { groups: ['BUNK 1'] },
      cohort_id: null,
      resolutions: [{ entity: 'groups', name: 'BUNK 1', reason: 'ambiguous_identity', choice: 'create' }],
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00', days: ['Monday'],
        scope: { is_all_groups: false, groups: ['Bunk 1'] },
      }],
    })

    expect(outcome.held).toBeFalsy()
    const s = getState()
    const newGroup = s.groups.find((g) => g.name === 'BUNK 1')
    expect(newGroup).toBeTruthy()
    expect(newGroup.id).not.toBe('aaa-group-low')
    expect(newGroup.id).not.toBe('zzz-group-high')

    const anchor = s.anchor_activities[0]
    const anchorGroups = String(anchor.group_ids ?? anchor.scope_groups ?? '')
    expect(anchorGroups).toContain('aaa-group-low')
    expect(anchorGroups).not.toContain(newGroup.id)
  })
})
