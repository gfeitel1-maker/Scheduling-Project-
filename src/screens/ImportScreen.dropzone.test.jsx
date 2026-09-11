// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// T138 — "Import last year" is the primary button on SeedScreen, so the file
// control is the first real thing a director touches. It used to be a raw
// browser input ("Choose Files / No file chosen") with no drop handler at all —
// and dropping a spreadsheet is the gesture someone with one on their desktop
// actually reaches for.
//
// These live in their own file because the drop path is about the CONTROL, not
// the commit payload the main suite guards.
//
// Original note from the shared fixture:
// T35 — the rule summary this test checks for is inferred from activityPages/
// seenCounts/dayCount, which real parsing would have to build a whole grid to
// exercise. Stubbing extractEntities/parseTextGrid keeps the test about
// "does the inferred rule render and drive the commit payload", not about the
// grid parser (which has its own tests).
vi.mock('../ingest/textGrid', () => ({ parseTextGrid: vi.fn(() => ({ pages: [{ title: 'x', columns: [], rows: [] }] })) }))
// Base proposal fixture, reused as the default mock return and cloned by
// individual tests (via extractEntities.mockReturnValueOnce) that need a
// different activity shape — e.g. one with no per-group signal at all, to
// drive the eligibility-unknown branch (round 2 review).
const baseProposal = {
  orientation: { columns: 'days', pages: 'groups', confident: true },
  entities: {
    groups: ['Yeladim', 'Bogrim'],
    days_of_operation: ['Monday', 'Tuesday'],
    time_blocks: [],
    activities: ['Swim'],
    tiers: [],
    cohorts: [],
  },
  groupUnits: {},
  groupNameByTitle: {},
  activityPages: { swim: ['Yeladim'] },
  seenCounts: { activities: { Swim: 4 }, activityUnitShare: { swim: 0.9 } },
  counts: { groups: 2, days_of_operation: 2, activities: 1 },
}
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: vi.fn(),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: vi.fn(() => ({ fixedEvents: [] })) }))
// HIGH regression test (split-failure surfacing) — mocked so a staged
// two-row split can be forced to fail at commit time without exercising
// twoRowSplit.js's own real write logic (that module has its own tests).
vi.mock('../ingest/twoRowSplit', async () => {
  const actual = await vi.importActual('../ingest/twoRowSplit')
  return {
    ...actual,
    emitTwoRowSplit: vi.fn(),
    pinActivityAsserted: vi.fn(),
  }
})
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    // useSetupCounts calls getCamp() in a mount effect on every ImportScreen
    // render, so the mock must implement it or every test throws in that effect.
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    // T61 — present so the "the renderer deletes nothing" test can assert it
    // was never reached, not because this screen may call it.
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
    // T118 slice 4 — the camp's already-confirmed compound-cell-pattern
    // decisions, fetched at parse time. Defaults to none; individual tests
    // override with mockResolvedValueOnce to prove the re-import regression
    // (a confirmed pattern never shows a card again).
    listCompoundCellDecisions: vi.fn().mockResolvedValue(new Map()),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'
import { extractEntities } from '../ingest/extractEntities'
import { inferFixedEvents } from '../ingest/fixedEvents'
import { IMPORT_LIMITS } from '../utils/exportSanitize'

beforeEach(() => {
  vi.clearAllMocks()
  extractEntities.mockReturnValue(baseProposal)
  localClient.list.mockResolvedValue([])
  localClient.ingestCommit.mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } })
  localClient.listCompoundCellDecisions.mockResolvedValue(new Map())
  inferFixedEvents.mockReturnValue({ fixedEvents: [] })
})

describe('ImportScreen — the file control', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function renderScreen() {
    render(<ImportScreen campId="camp-1" role="admin" onNavigate={vi.fn()} />)
  }

  it('says which file types it takes, instead of leaving the director to guess', async () => {
    renderScreen()
    expect(await screen.findByText(/Excel, CSV or a plain text schedule/)).toBeTruthy()
  })

  it('invites a drop rather than only a click', async () => {
    renderScreen()
    expect(await screen.findByText(/Drop last year's schedule here/)).toBeTruthy()
  })

  it('still opens the OS picker through a real file input, so it stays keyboard-reachable', async () => {
    const { container } = render(<ImportScreen campId="camp-1" role="admin" onNavigate={vi.fn()} />)
    const input = container.querySelector('input[type=file]')
    expect(input).toBeTruthy()
    // Visually replaced, not removed: display:none would make it unfocusable.
    expect(input.style.display).not.toBe('none')
    expect(input.accept).toContain('.xlsx')
    expect(input.accept).toContain('.txt')
  })

  it('reads a dropped file the same way it reads a chosen one', async () => {
    renderScreen()
    const zone = (await screen.findByText(/Drop last year's schedule here/)).parentElement
    const file = new File(['grid'], 'lastyear.txt', { type: 'text/plain' })

    fireEvent.drop(zone, { dataTransfer: { files: [file] } })

    // The proposal renders, which only happens once a file has actually been read.
    await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))
  })

  it('names the dropped file back to the director', async () => {
    renderScreen()
    const zone = (await screen.findByText(/Drop last year's schedule here/)).parentElement
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['g'], 'lastyear.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText(/lastyear\.txt/)).toBeTruthy())
  })

  it('ignores a drop carrying no files rather than throwing mid-render', async () => {
    renderScreen()
    const zone = (await screen.findByText(/Drop last year's schedule here/)).parentElement
    expect(() => fireEvent.drop(zone, { dataTransfer: { files: [] } })).not.toThrow()
  })
})
