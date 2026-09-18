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
