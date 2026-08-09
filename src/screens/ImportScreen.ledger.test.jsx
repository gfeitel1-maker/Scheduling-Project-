// @vitest-environment jsdom
//
// S5b/T75 — flow-level proof that BOTH import faces (schedule tick-preview and
// workbook re-import) funnel through the ONE shared reconciliation ledger before
// anything is written, and that a held commit from the ledger routes to the
// existing T73 held-resolution surface. The ledger's own rendering is unit-tested
// in ReconciliationLedger.test.jsx; this file is about the wiring.

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
      entities: { groups: [], days_of_operation: [], time_blocks: [], activities: ['Swim'], tiers: [], cohorts: [] },
      groupUnits: {}, groupNameByTitle: {}, activityPages: {},
      seenCounts: { activities: { Swim: 4 } },
      counts: { activities: 1 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [] }) }))
vi.mock('../ingest/activityRules', () => ({ inferActivityRules: () => new Map() }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))

// Workbook plumbing: a Shoresh enrichment workbook is recognized by its metadata
// sheet, then parsed into a buildPlan source by the (mocked) hardened adapter.
vi.mock('xlsx', () => ({ read: () => ({ SheetNames: ['__shoresh_meta__'], Sheets: {} }), utils: { sheet_to_json: () => [] } }))
vi.mock('../utils/exportWorkbook.js', () => ({ META_SHEET: '__shoresh_meta__', downloadWorkbook: () => {} }))
vi.mock('../utils/exportSanitize.js', () => ({ assertImportFileSize: () => {}, assertWorkbookComplexity: () => {}, unescapeRow: (r) => r }))
vi.mock('../ingest/workbookToSource.js', () => ({
  workbookToSource: () => ({
    approved: { activities: [{ name: 'Kayaking' }] },
    camp_id: 'camp-1', cohort_id: 'cohort-1', base_generation: 5, mode: 'add',
  }),
}))

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    ingestCommit: vi.fn().mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } }),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
  localClient.getCamp.mockResolvedValue({ id: 'camp-1' })
  localClient.ingestCommit.mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } })
})

async function uploadSchedule() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  await userEvent.upload(input, new File(['x'], 'schedule.txt', { type: 'text/plain' }))
  await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))
}

async function uploadWorkbook() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  await userEvent.upload(input, new File(['x'], 'enrichment.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
}

const heldOutcome = { held: true, conflicts: [
  { op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity', _name: 'Kayaking',
    fields: {}, evidence: { tier: 'exact_name', candidates: [{ id: 'k1', name: 'Kayaking' }, { id: 'k2', name: 'kayaking ' }] } },
], created: {}, total: 0, updated: 0, fixedEvents: { created: 0, skipped: [], partial: [] } }

describe('S5b/T75 — the schedule path funnels through the ledger', () => {
  it('shows the ledger BEFORE commit; ingestCommit runs only after confirming from it', async () => {
    await uploadSchedule()
    // Confirming the tick-preview stages the ledger — it does NOT commit.
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await screen.findByText(/Nothing is saved yet/)
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
    // Swim is a net-new record in the ledger.
    expect(screen.getByText(/^1 new$/)).toBeTruthy()
    // Only the ledger's Commit writes.
    await userEvent.click(screen.getByText(/Commit \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(1))
  })
})

describe('S5b/T75 — the workbook path funnels through the SAME ledger', () => {
  it('shows the ledger before commit (no straight-to-commit), then commits on confirm', async () => {
    await uploadWorkbook()
    await screen.findByText(/Nothing is saved yet/)
    // T75 closed: the workbook no longer bypasses the preview.
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
    // Kayaking is a net-new record (collapsed by default — the count reassures).
    expect(screen.getByText(/^1 new$/)).toBeTruthy()
    await userEvent.click(screen.getByText(/Commit \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(1))
    // The workbook's exported generation flows through to the commit unchanged.
    expect(localClient.ingestCommit.mock.calls[0][0].base_generation).toBe(5)
  })

  it('a held commit from the workbook ledger routes to the T73 held-resolution surface', async () => {
    localClient.ingestCommit.mockResolvedValueOnce(heldOutcome)
    await uploadWorkbook()
    await userEvent.click(await screen.findByText(/Commit \d+ record/))
    // The existing T73 entry banner — a pause, not an error.
    await waitFor(() => expect(screen.getByText(/Almost there/)).toBeTruthy())
    await userEvent.click(screen.getByText(/Review the \d+ item/))
    expect(screen.getByText(/A few things to sort out/)).toBeTruthy()
  })
})
