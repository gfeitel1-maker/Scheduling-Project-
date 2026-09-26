// @vitest-environment jsdom
//
// T257 parity: the dev mock's ingestCommit must resolve an existing-tier
// TOKEN the exact same way the real committer (electron/ops/ingest.js) does
// — by id, directly, never by re-resolving the name (which can only ever
// find the lower-id winner of two same-named tiers) — or `npm run dev`
// diverges from `electron:dev` on exactly the path this ticket fixes.
// Both paths share buildPlan/foldApprovedToRecords (src/ingest/*), so this
// mirrors electron/ops/ingest.unitTokenSecondDivision.test.js's HIGH-id case
// through the mock's own commit surface instead of commitPlan.
import { describe, it, expect, beforeEach } from 'vitest'

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}
globalThis.localStorage = makeLocalStorage()
globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }

const { mockShoresh } = await import('./localClient.mock.js')

beforeEach(() => {
  localStorage.clear()
})

function seedState({ campId, tiers }) {
  localStorage.setItem('shoresh-mock-state', JSON.stringify({
    camp: { id: campId, name: 'Camp Test' },
    users: [], conflicts: [], devices: [], __fieldSource: {},
    tiers, groups: [], activities: [], time_blocks: [], days_of_operation: [], cohorts: [], locations: [],
  }))
}

describe('localClient.mock ingestCommit — existing-tier token resolves by id (T257 parity)', () => {
  it('picks the HIGH-id same-named tier, not the low-id one a name lookup would find', async () => {
    const campId = 'camp-1'
    const lowId = 'tier-aaa-low'
    const highId = 'tier-zzz-high'
    seedState({ campId, tiers: [
      { id: lowId, name: 'Bunk B', camp_id: campId, cohort_id: null },
      { id: highId, name: 'Bunk B', camp_id: campId, cohort_id: null },
    ] })

    const out = await mockShoresh.ingestCommit({
      approved: { groups: ['Chagalls'], tiers: [], activities: [], time_blocks: [], days_of_operation: [] },
      links: { groups: { Chagalls: { kind: 'existing', id: highId, name: 'Bunk B' } } },
      mode: 'add',
    })
    expect(out.held ?? false).toBe(false)

    const state = JSON.parse(localStorage.getItem('shoresh-mock-state'))
    const group = state.groups.find((g) => g.name === 'Chagalls')
    expect(group.tier_id).toBe(highId)
    expect(group.tier_id).not.toBe(lowId)
  })
})
