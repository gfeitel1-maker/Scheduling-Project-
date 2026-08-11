// @vitest-environment jsdom
//
// D4 — after a successful commit, the success banner shows an honest
// readiness verdict (ready + optional-not-configured, together) and a
// handoff button to the Readiness hub. Follows the localClient mock +
// render pattern from ImportScreen.reconciliationQueue.test.jsx.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../ingest/textGrid', () => ({ parseTextGrid: () => ({ pages: [{ title: 'x', columns: [], rows: [] }] }) }))
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: () => ({
      orientation: { columns: 'days', pages: 'groups', confident: true },
      entities: {
        groups: ['Bunk 1'], days_of_operation: ['Monday'], time_blocks: ['Morning'],
        activities: ['Archery'], tiers: [], cohorts: [],
      },
      groupUnits: {}, groupNameByTitle: {}, activityPages: {},
      seenCounts: { activities: { Archery: 4 }, groups: { 'Bunk 1': 4 } },
      counts: { activities: 1 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [] }) }))
vi.mock('../ingest/activityRules', () => ({ inferActivityRules: () => new Map() }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))

// After commit, ImportScreen re-lists every readiness collection (see the
// stageReconciliationSummary readiness build) to compute the handoff
// verdict. Required areas come back populated so the verdict can show
// "Ready to build a week." alongside an absent optional area (Fixed Events).
const LIST_BY_TABLE = {
  cohorts: [{ id: 'cohort-1' }],
  tiers: [{ id: 't1' }],
  groups: [{ id: 'g1' }],
  days_of_operation: [{ id: 'd1' }],
  time_blocks: [{ id: 'tb1' }],
  activities: [{ id: 'a1' }],
  anchor_activities: [],
  day_override_templates: [],
}

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn((table) => Promise.resolve(LIST_BY_TABLE[table] ?? [])),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    ingestCommit: vi.fn().mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn(),
    getCurrentProject: vi.fn().mockResolvedValue({ path: null, isDev: false, build: null }),
    getSyncStatus: vi.fn().mockResolvedValue(null),
    onSyncStatusChanged: vi.fn(() => () => {}),
    onOpApplied: vi.fn(() => () => {}),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockImplementation((table) => Promise.resolve(LIST_BY_TABLE[table] ?? []))
  localClient.getCamp.mockResolvedValue({ id: 'camp-1' })
  localClient.ingestCommit.mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } })
  localClient.ingestReconcile.mockResolvedValue({
    planItems: [
      { op: 'create', entity: 'activities', entity_id: null, _name: 'Archery', fields: {}, evidence: { tier: 'new' } },
    ],
    fixedEventsReport: { created: 0, unchanged: 0, skipped: [], partial: [], rejected: [], moved: [], scopeChanged: [] },
    legacyPriorityActivities: [],
    fieldProvenance: {},
  })
})

async function importAndCommit() {
  render(<ImportScreen campId="camp-1" onNavigate={onNavigate} />)
  const input = document.querySelector('input[type="file"]')
  await userEvent.upload(input, new File(['x'], 'schedule.txt', { type: 'text/plain' }))
  await waitFor(() => expect(screen.getAllByText(/Archery/).length).toBeGreaterThan(0))
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await screen.findByText(/Nothing is saved yet/)
  await userEvent.click(screen.getByText(/Commit \d+ record/))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(1))
}

let onNavigate

beforeEach(() => {
  onNavigate = vi.fn()
})

describe('D4 — Setup Readiness integration in the post-import success banner', () => {
  it('shows the ready verdict together with optional-not-configured areas, and a handoff button that navigates to readiness', async () => {
    await importAndCommit()

    await screen.findByText(/Imported 3 records/)

    await waitFor(() => expect(screen.getByText(/Ready to build a week/)).toBeTruthy())
    expect(screen.getByText(/Fixed Events/)).toBeTruthy()

    const handoff = screen.getByRole('button', { name: /Readiness/i })
    await userEvent.click(handoff)
    expect(onNavigate).toHaveBeenCalledWith('readiness')
  })

  it('still shows the existing Go to Groups button alongside the handoff', async () => {
    await importAndCommit()

    await screen.findByText(/Imported 3 records/)
    expect(screen.getByText('Go to Groups')).toBeTruthy()
  })
})
