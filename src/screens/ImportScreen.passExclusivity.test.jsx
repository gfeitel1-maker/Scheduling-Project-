// @vitest-environment jsdom
//
// T266 leftover (docs/work/tickets/T266-ingest-pass-exclusivity.md:184-187):
// "ImportScreen's React layer is not exercised by the acceptance test … the
// component is not mounted." The derivation (src/ingest/pinOnlyActivityNames.js,
// exercised through ImportScreen.jsx:756-771's dualUseSet/pinOnlyActivityNames
// computation) and buildPlan's tier:'low' + catalog_role forcing
// (src/ingest/buildPlan.js:669-678) are both unit-tested elsewhere. What was
// never exercised end to end is the mounted screen driving a real commit
// through the real buildPlan and landing on a real persisted row.
//
// Unlike ImportScreen.fixedEventRouting.test.jsx (which stubs localClient
// entirely and asserts on the ingestCommit call's *input* payload), this file
// deliberately does NOT mock '../localClient'. In jsdom, window.shoresh is
// undefined, so src/localClient.js falls back to the real mockShoresh
// (src/localClient.mock.js) — which runs the SAME buildPlan the real
// committer uses (electron/ops/ingest.js) against a localStorage-backed
// store. That lets this test assert on the actual persisted ROW the rule
// produces (catalog_role on the created `activities` row), not on a mock's
// recorded call.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// T146 — must be schedule-shaped (day column) or ImportScreen's
// isScheduleShaped precondition declines it before extractEntities runs.
// Mirrors ImportScreen.fixedEventRouting.test.jsx's minimal fixture.
vi.mock('../ingest/textGrid', () => ({ parseTextGrid: () => ({ pages: [{ title: 'x', columns: [], rows: [{ label: '9:00', cells: [] }] }] }) }))
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: () => ({
      orientation: { columns: 'days', pages: 'groups', confident: true },
      entities: {
        groups: ['Yeladim'],
        days_of_operation: ['Monday', 'Tuesday'],
        time_blocks: [],
        // 'Lunch' is pin-only (fixed only, not dual-use) — the name this test
        // proves gets excluded from the free-choice catalog. 'Ceramics' is
        // genuinely dual-use — the non-vacuity control: the same guard must
        // NOT mark it, so its created row must NOT carry catalog_role.
        activities: ['Lunch', 'Ceramics'],
        tiers: [],
        cohorts: [],
      },
      groupUnits: {},
      groupNameByTitle: {},
      activityPages: { lunch: ['Yeladim'], ceramics: ['Yeladim'] },
      seenCounts: {
        activities: { Lunch: 4, Ceramics: 4 },
        activityUnitShare: { lunch: 0.9, ceramics: 0.9 },
      },
      counts: { groups: 1, days_of_operation: 2, activities: 2 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({
  inferFixedEvents: () => ({
    fixedEvents: [
      { name: 'Lunch', time_block: '12:00-12:30', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null }, confidence: 'high' },
      { name: 'Ceramics', time_block: '10:00-10:30', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null }, confidence: 'high' },
    ],
    dualUseNames: ['Ceramics'],
  }),
}))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))

// Deliberately NOT mocking '../localClient' — see file header. Seed the
// mock's localStorage-backed store with just a camp, the same way
// src/localClient.mock.electives.test.js and friends do, so the real
// mockShoresh has somewhere to write.
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
  // Seed one pre-existing row per readiness-required collection
  // (src/engine/readiness.js's REQUIRED_AREAS) so the mounted
  // ReconciliationScreen doesn't also raise 5 unrelated "setup gap" hold-lane
  // decisions on a totally empty camp — this test is about the pin-only
  // guard's single confirm_value decision, not camp readiness.
  globalThis.localStorage.setItem(
    'shoresh-mock-state',
    JSON.stringify({
      camp: { id: 'camp-1', name: 'Camp' },
      users: [],
      conflicts: [],
      devices: [],
      tiers: [{ id: 'seed-tier', camp_id: 'camp-1', name: 'Seed Tier' }],
      groups: [{ id: 'seed-group', camp_id: 'camp-1', name: 'Seed Group' }],
      days_of_operation: [{ id: 'seed-day', camp_id: 'camp-1', name: 'Wednesday' }],
      time_blocks: [{ id: 'seed-block', camp_id: 'camp-1', name: '08:00-08:30' }],
      activities: [{ id: 'seed-activity', camp_id: 'camp-1', name: 'Seed Activity' }],
    })
  )
})

async function uploadFile() {
  const { default: ImportScreen } = await import('./ImportScreen')
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getAllByText(/Ceramics/).length).toBeGreaterThan(0))
}

async function commitAndFetchActivities() {
  const { localClient } = await import('../localClient')
  await userEvent.click(screen.getByText(/Review \d+ record/))
  // The pin-only mechanism forces the Lunch create to a LOW-confidence
  // ('low') tier deliberately (buildPlan.js:669-678) — a standard-lane
  // confirm_value decision, requiring the director's explicit "Use this
  // value" before it is anything but held back. Resolve any such decisions
  // here so the commit below actually creates the row(s) this test asserts
  // on; this is the real director gesture the pin-only tier exists to
  // force, not a workaround for it. A genuinely dual-use / high-confidence
  // create (Ceramics) never raises this decision, so zero matches is valid.
  await screen.findByText('Understood', {}, { timeout: 5000 })
  for (const btn of screen.queryAllByText('Use this value')) await userEvent.click(btn)
  // ReconciliationScreen's mount-time dry run (localClient.ingestReconcile) is
  // no longer stubbed to resolve instantly — it runs the real buildPlan
  // against the real mock store — so this needs a longer findByText timeout
  // than the default. Label varies with whether every lane decision is
  // resolved ('Use this setup') or some remain open ('Use what Shoresh
  // understood') — see reconciliationTray.js's applyTrayState; either mode
  // still commits every already-understood create, which is all this test's
  // two brand-new, high-confidence activities are.
  await userEvent.click(await screen.findByText(/^Use (this setup|what Shoresh understood)$/, {}, { timeout: 5000 }))
  await waitFor(async () => {
    const rows = await localClient.list('activities')
    expect(rows.length).toBeGreaterThan(0)
  })
  return localClient.list('activities')
}

describe('ImportScreen — pin-only pass exclusivity, mounted through a real commit (T266 known limit)', () => {
  it('a pin-only (non-dual-use) name is persisted with catalog_role pinned_event, never a free catalog entry', async () => {
    await uploadFile()
    const rows = await commitAndFetchActivities()
    const lunch = rows.find((r) => r.name === 'Lunch')
    expect(lunch).toBeDefined()
    expect(lunch.catalog_role).toBe('pinned_event')
  })

  it('a genuinely dual-use name is persisted WITHOUT catalog_role pinned_event (non-vacuity control)', async () => {
    await uploadFile()
    const rows = await commitAndFetchActivities()
    const ceramics = rows.find((r) => r.name === 'Ceramics')
    expect(ceramics).toBeDefined()
    expect(ceramics.catalog_role ?? null).not.toBe('pinned_event')
  })
})
