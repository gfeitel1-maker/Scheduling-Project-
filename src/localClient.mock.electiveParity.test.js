// @vitest-environment jsdom
//
// T229 parity: localClient.mock.js's commitElectiveRun must mirror the real
// commitElectiveRunHandler's refusals and its additive contract
// (occurrences/scheduleWeekId/scheduleTemplateId), or browser-dev diverges
// from `electron:dev` on exactly the paths this slice adds.
import { describe, it, expect, beforeEach } from 'vitest'

// Node's own global `localStorage` (backed by --localstorage-file) shadows
// jsdom's and lacks removeItem — same workaround as
// localClient.mock.anchorKind.test.js's makeLocalStorage.
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

const PARSED = {
  campers: [{ id: 'cam-1', display_name: 'Ari Green' }],
  choices: [{ label: 'Archery', labelKey: 'archery' }],
  preferences: [
    { camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 },
    { camper_id: 'cam-1', label: 'Gaga', labelKey: 'gaga', rank: 1 },
  ],
  sameNameCampers: [],
  skippedRows: [],
}

beforeEach(() => {
  localStorage.clear()
})

describe('localClient.mock commitElectiveRun parity', () => {
  it('refuses a sheet with contradictory ranks, mirroring the real handler', async () => {
    const out = await mockShoresh.commitElectiveRun({ name: 'Week 1', parsed: PARSED, assignments: [] })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/rank/i)
  })

  it('writes elective_occurrences rows and the run schedule linkage', async () => {
    const parsed = { ...PARSED, preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }] }
    const occurrences = [{ id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' }]
    const out = await mockShoresh.commitElectiveRun({
      name: 'Week 1', parsed, assignments: [],
      occurrences, scheduleWeekId: 'week-1', scheduleTemplateId: 'tpl-1',
    })
    expect(out.ok).toBe(true)
    const runs = JSON.parse(localStorage.getItem('shoresh-mock-state')).elective_assignment_runs
    expect(runs.find((r) => r.id === out.runId)).toMatchObject({ schedule_week_id: 'week-1', schedule_template_id: 'tpl-1' })
    const occs = JSON.parse(localStorage.getItem('shoresh-mock-state')).elective_occurrences
    expect(occs).toEqual([expect.objectContaining({ id: 'occ-1', run_id: out.runId })])
  })
})

// C3 (board item 9b) — electron/main.js's listElectiveRunsHandler now joins
// finalized_by_name off the users table so RunIdentity never renders the raw
// finalized_by id. The mock mirrors the same field so browser-dev (what
// Tester drives) matches electron:dev.
describe('localClient.mock listElectiveRuns — finalized_by_name parity', () => {
  it('resolves finalized_by_name from state.users by finalized_by, mirroring the real read-side join', async () => {
    const parsed = { ...PARSED, preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }] }
    const out = await mockShoresh.commitElectiveRun({ name: 'Week 1', parsed, assignments: [] })
    expect(out.ok).toBe(true)

    const state = JSON.parse(localStorage.getItem('shoresh-mock-state'))
    state.elective_assignment_runs = state.elective_assignment_runs.map((r) =>
      r.id === out.runId ? { ...r, finalized_by: 'user-1' } : r
    )
    state.users = [...(state.users || []), { id: 'user-1', name: 'Director Dana' }]
    localStorage.setItem('shoresh-mock-state', JSON.stringify(state))

    const runs = await mockShoresh.listElectiveRuns()
    const run = runs.find((r) => r.id === out.runId)
    expect(run.finalized_by).toBe('user-1')
    expect(run.finalized_by_name).toBe('Director Dana')
  })

  it('resolves to null (never a crash, never the raw id) when finalized_by names no users row', async () => {
    const parsed = { ...PARSED, preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }] }
    const out = await mockShoresh.commitElectiveRun({ name: 'Week 1', parsed, assignments: [] })
    expect(out.ok).toBe(true)

    const state = JSON.parse(localStorage.getItem('shoresh-mock-state'))
    state.elective_assignment_runs = state.elective_assignment_runs.map((r) =>
      r.id === out.runId ? { ...r, finalized_by: 'ghost-user-id' } : r
    )
    localStorage.setItem('shoresh-mock-state', JSON.stringify(state))

    const runs = await mockShoresh.listElectiveRuns()
    const run = runs.find((r) => r.id === out.runId)
    expect(run.finalized_by).toBe('ghost-user-id')
    expect(run.finalized_by_name).toBeNull()
  })
})

// F8 (board item 9b round 3) — the mock's finalizeElectiveRun always
// succeeded unconditionally, so a director-facing OUTER_RESOURCE_CONFLICT
// Finalize refusal could never be reached through browser-dev (what Tester
// drives), only pinned in jsdom unit tests with a mocked IPC response. Mirrors
// electron/ops/electiveRunResourceConflicts.js's own mapTemplateSlot +
// findRouteConflicts call, scoped to the run's own occurrences — mock/seed
// behavior only, no new IPC, no production (electron) code touched.
describe('localClient.mock finalizeElectiveRun — OUTER_RESOURCE_CONFLICT parity', () => {
  it('refuses to finalize when the run\'s own template_slots double-book a location over capacity', async () => {
    const state = JSON.parse(localStorage.getItem('shoresh-mock-state')) ?? {}
    state.locations = [{ id: 'loc-1', name: 'Boathouse', capacity: 1 }]
    state.activities = [
      { id: 'act-canoe', name: 'Canoeing', location_id: 'loc-1' },
      { id: 'act-kayak', name: 'Kayaking', location_id: 'loc-1' },
    ]
    state.template_slots = [
      { template_id: 'tpl-1', group_id: 'grp-1', activity_id: 'act-canoe', day_id: 'day-1', time_block_id: 'tb-1' },
      { template_id: 'tpl-1', group_id: 'grp-2', activity_id: 'act-kayak', day_id: 'day-1', time_block_id: 'tb-1' },
    ]
    localStorage.setItem('shoresh-mock-state', JSON.stringify(state))

    const parsed = { ...PARSED, preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }] }
    const occurrences = [{ id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' }]
    const out = await mockShoresh.commitElectiveRun({
      name: 'Week 1', parsed, assignments: [], occurrences, scheduleTemplateId: 'tpl-1',
    })
    expect(out.ok).toBe(true)

    const result = await mockShoresh.finalizeElectiveRun({ runId: out.runId })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('OUTER_RESOURCE_CONFLICT')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings[0].locationName).toBe('Boathouse')

    // The run stays draft — a refused finalize must not have written 'final'.
    const runs = await mockShoresh.listElectiveRuns()
    expect(runs.find((r) => r.id === out.runId).status).toBe('draft')
  })

})

// F8 (board item 9b round 3) — the mock's commitElectiveRun had NO concept of
// elective_bundles at all, so a BUNDLE_TIER_NOT_COVERED finding (and
// therefore DraftRunView's whole grouped-mismatch row, C1) could never be
// reached through browser-dev. Mirrors the ONE resolution rule
// (electron/ops/camperElectiveIdentity.js's makeCamperIdentityResolver,
// division beats roster group) rather than re-deriving a second one.
describe('localClient.mock commitElectiveRun — BUNDLE_TIER_NOT_COVERED parity', () => {
  it("emits a BUNDLE_TIER_NOT_COVERED finding carrying tier_id when a camper's own tier is not in the bundle's scope", async () => {
    const state = JSON.parse(localStorage.getItem('shoresh-mock-state')) ?? {}
    state.tiers = [{ id: 'tier-older', name: 'Older' }, { id: 'tier-younger', name: 'Younger' }]
    state.groups = []
    state.elective_bundles = [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-ropes', name: 'Ropes', scope_mode: 'only' }]
    state.elective_bundle_tiers = [{ id: 'ebt-1', bundle_id: 'bundle-1', tier_id: 'tier-older' }]
    localStorage.setItem('shoresh-mock-state', JSON.stringify(state))

    const parsed = {
      campers: [{ id: 'cam-y1', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Younger' }],
      choices: [{ label: 'Ropes', labelKey: 'ropes' }],
      preferences: [{ camper_id: 'cam-y1', label: 'Ropes', labelKey: 'ropes', rank: 1 }],
      sameNameCampers: [], skippedRows: [],
    }
    const out = await mockShoresh.commitElectiveRun({ name: 'Week 1', parsed, assignments: [] })
    expect(out.ok).toBe(true)
    const mismatch = out.findings.find((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(mismatch).toBeTruthy()
    expect(mismatch.camper_id).toBe('cam-y1')
    expect(mismatch.tier_id).toBe('tier-younger')
  })

  it('emits NO finding when the camper IS covered by the bundle', async () => {
    const state = JSON.parse(localStorage.getItem('shoresh-mock-state')) ?? {}
    state.tiers = [{ id: 'tier-older', name: 'Older' }]
    state.groups = []
    state.elective_bundles = [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-ropes', name: 'Ropes', scope_mode: 'only' }]
    state.elective_bundle_tiers = [{ id: 'ebt-1', bundle_id: 'bundle-1', tier_id: 'tier-older' }]
    localStorage.setItem('shoresh-mock-state', JSON.stringify(state))

    const parsed = {
      campers: [{ id: 'cam-o1', display_name: 'Ari Green', external_id: null, group_id: null, division_label: 'Older' }],
      choices: [{ label: 'Ropes', labelKey: 'ropes' }],
      preferences: [{ camper_id: 'cam-o1', label: 'Ropes', labelKey: 'ropes', rank: 1 }],
      sameNameCampers: [], skippedRows: [],
    }
    const out = await mockShoresh.commitElectiveRun({ name: 'Week 1', parsed, assignments: [] })
    expect(out.ok).toBe(true)
    expect(out.findings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')).toEqual([])
  })

  // M2 (Red Hat round 4) — makeCamperIdentityResolver's enrichment step falls
  // back to the ROSTER's division_label when THIS commit's sheet cell is
  // empty for that camper (electron/ops/commitElectiveRun.js passes
  // rosterCampers for exactly this reason). The mock's own call omitted
  // rosterCampers, so a sheet with a blank Division column for a camper who
  // already has a division on the roster resolved differently here than in
  // Electron — a false-confidence gap in the ONE surface a Tester is meant
  // to trust. Existing tests above all supply division_label directly on the
  // sheet, so this gap was unexercised until now.
  it("falls back to the ROSTER's division when THIS sheet's Division cell is empty for that camper — matching the real resolver", async () => {
    const state = JSON.parse(localStorage.getItem('shoresh-mock-state')) ?? {}
    state.tiers = [{ id: 'tier-older', name: 'Older' }, { id: 'tier-younger', name: 'Younger' }]
    state.groups = []
    // The PRE-EXISTING roster: this camper already has a division from an
    // earlier import.
    state.campers = [{ id: 'cam-y1', display_name: 'Noa Katz', group_id: null, division_label: 'Younger' }]
    state.elective_bundles = [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-ropes', name: 'Ropes', scope_mode: 'only' }]
    state.elective_bundle_tiers = [{ id: 'ebt-1', bundle_id: 'bundle-1', tier_id: 'tier-older' }]
    localStorage.setItem('shoresh-mock-state', JSON.stringify(state))

    const parsed = {
      // THIS commit's sheet names NO division for this camper (the Division
      // cell is empty) — only the roster still knows 'Younger'.
      campers: [{ id: 'cam-y1', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: null }],
      choices: [{ label: 'Ropes', labelKey: 'ropes' }],
      preferences: [{ camper_id: 'cam-y1', label: 'Ropes', labelKey: 'ropes', rank: 1 }],
      sameNameCampers: [], skippedRows: [],
    }
    const out = await mockShoresh.commitElectiveRun({ name: 'Week 1', parsed, assignments: [] })
    expect(out.ok).toBe(true)
    const mismatch = out.findings.find((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(mismatch).toBeTruthy()
    // Must resolve via the ROSTER's 'Younger' — null/unresolved would mean
    // rosterCampers never reached the resolver.
    expect(mismatch.tier_id).toBe('tier-younger')
  })
})

describe('localClient.mock finalizeElectiveRun — OUTER_RESOURCE_CONFLICT parity, continued', () => {
  it('finalizes normally when no conflict exists (no regression to the happy path)', async () => {
    const parsed = { ...PARSED, preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }] }
    const out = await mockShoresh.commitElectiveRun({ name: 'Week 1', parsed, assignments: [] })
    expect(out.ok).toBe(true)
    const result = await mockShoresh.finalizeElectiveRun({ runId: out.runId })
    expect(result.ok).toBe(true)
  })
})
