// @vitest-environment jsdom
//
// D2 — proves the decision queue's resolutions actually flow through the
// SINGLE existing commit call (ImportScreen's runCommit -> localClient.
// ingestCommit), via commitInputsWithResolutions (ImportScreen.jsx) and
// applyResolutions (reconciliationResolutions.js). Mocks localClient.
// ingestReconcile directly (full control over the decisions the real
// buildReconciliationReport classifies), same pattern as ImportScreen.
// ledger.test.jsx uses for the ledger's own wiring.

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
      entities: { groups: [], days_of_operation: [], time_blocks: [], activities: ['Archery', 'Swim', 'Canoe'], tiers: [], cohorts: [] },
      groupUnits: {}, groupNameByTitle: {}, activityPages: {},
      seenCounts: { activities: { Archery: 4, Swim: 4, Canoe: 4 } },
      counts: { activities: 1 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [] }) }))
vi.mock('../ingest/activityRules', () => ({ inferActivityRules: () => new Map() }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    ingestCommit: vi.fn().mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn(),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

// Archery = needsAttention (medium-confidence update, no human field) -> confirm_value.
// Swim = human-owned field being overwritten -> confirm_change.
// Canoe = plain create, HIGH confidence -> understood, no decision at all.
const PLAN_ITEMS = [
  {
    op: 'update', entity: 'activities', entity_id: 'act-archery', _name: 'Archery',
    fields: { max_per_week: { from: 1, to: 5, source: 'import' } },
    evidence: { tier: 'medium', matched_name: 'Archery' },
  },
  {
    op: 'update', entity: 'activities', entity_id: 'act-swim', _name: 'Swim',
    fields: { max_per_week: { from: 3, to: 7, source: 'import' } },
    evidence: { tier: 'exact_name', matched_name: 'Swim' },
  },
  { op: 'create', entity: 'activities', entity_id: null, _name: 'Canoe', fields: {}, evidence: { tier: 'new' } },
]

const FIELD_PROVENANCE = { 'activities:act-swim:max_per_week': 'human' }

const RECONCILE_RESULT = {
  planItems: PLAN_ITEMS,
  fixedEventsReport: { created: 0, unchanged: 0, skipped: [], partial: [], rejected: [], moved: [], scopeChanged: [] },
  legacyPriorityActivities: [],
  fieldProvenance: FIELD_PROVENANCE,
}

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
  localClient.getCamp.mockResolvedValue({ id: 'camp-1' })
  localClient.ingestCommit.mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } })
  localClient.ingestReconcile.mockResolvedValue(RECONCILE_RESULT)
})

async function uploadAndStage() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  await userEvent.upload(input, new File(['x'], 'schedule.txt', { type: 'text/plain' }))
  await waitFor(() => expect(screen.getAllByText(/Archery/).length).toBeGreaterThan(0))
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await screen.findByText(/Nothing is saved yet/)
  await waitFor(() => expect(screen.getByText(/Review 2 decisions/)).toBeTruthy())
}

describe('D2 — the decision queue folds into the SAME commit ImportScreen already sends', () => {
  it('(c) LOAD-BEARING: an unresolved confirm_value is held back, an unresolved confirm_change commits choice:keep, and the rest still commits', async () => {
    await uploadAndStage()
    // Neither decision is touched — commit straight from the ledger with both unresolved.
    await userEvent.click(screen.getByText(/Commit \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(1))

    const sent = localClient.ingestCommit.mock.calls[0][0]
    expect(sent.approved.activities).not.toContain('Archery') // held back, never in approved
    expect(sent.approved.activities).toContain('Swim') // confirm_change doesn't touch approved
    expect(sent.approved.activities).toContain('Canoe') // already-reconciled (no decision) — commits normally
    expect(sent.resolutions).toEqual(
      expect.arrayContaining([{ entity: 'activities', name: 'Swim', reason: 'stale', field: 'max_per_week', choice: 'keep' }]),
    )
    expect(sent.resolutions.some((r) => r.name === 'Swim' && r.choice === 'accept')).toBe(false)
  })

  it('(b) resolving Looks-right + Overwrite applies both choices through the commit payload', async () => {
    await uploadAndStage()
    await userEvent.click(screen.getByText(/Review 2 decisions/))

    await userEvent.click(screen.getByRole('button', { name: /Looks right/ }))
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await userEvent.click(screen.getByRole('button', { name: /Overwrite with new value/ }))
    await userEvent.click(screen.getByRole('button', { name: /Return to summary/ }))

    await userEvent.click(screen.getByText(/Commit \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(1))

    const sent = localClient.ingestCommit.mock.calls[0][0]
    expect(sent.approved.activities).toContain('Archery') // resolved (looks right) -> not held back
    expect(sent.resolutions).toEqual(
      expect.arrayContaining([{ entity: 'activities', name: 'Swim', reason: 'stale', field: 'max_per_week', choice: 'accept' }]),
    )
  })
})
