// @vitest-environment jsdom
//
// Slice 2b (docs/work/specs/2026-08-23-two-rows-slice2-affordance.md) — the
// two-rows split suggestion attached to a dual-use Recurring Events chip.
// Mirrors ImportScreen.fixedEventRouting.test.jsx's mocking shape: dualUseNames
// from inferFixedEvents drives which chip gets the disclosure; 'Ceramics' is
// dual-use, 'Lunch' is pin-only and must never show it.
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
        groups: ['Yeladim'],
        days_of_operation: ['Monday', 'Tuesday'],
        time_blocks: [],
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

// HIGH #1 — the real ReconciliationScreen's normal-flow render has no
// discard affordance visible outside its error state (only the error branch
// renders a "Back" button), so driving handleReconciliationCommitted/
// handleReconciliationDiscard through the real triage/dry-run UI (as
// ImportScreen.test.jsx's goToCommit does for unrelated tests) is the wrong
// tool here — this file's tests are about ImportScreen's own commit/discard
// seam, not ReconciliationScreen's readiness gate. Stubbed the same way
// App.test.jsx stubs it, exposing exactly the two callbacks this feature
// cares about.
vi.mock('./ReconciliationScreen', () => ({
  default: ({ onCommitted, onDiscard }) => (
    <div>
      <button onClick={() => onCommitted({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } })}>
        Commit (test)
      </button>
      <button onClick={onDiscard}>Discard (test)</button>
    </div>
  ),
}))

let emitTwoRowSplitMock
vi.mock('../ingest/twoRowSplit', async () => {
  const actual = await vi.importActual('../ingest/twoRowSplit')
  return {
    ...actual,
    emitTwoRowSplit: (...args) => emitTwoRowSplitMock(...args),
  }
})

const READY_ENTITIES = new Set(['tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities'])
const EXISTING_CERAMICS = { id: 'act-ceramics', name: 'Ceramics', camp_id: 'camp-1', recurrence_truth_status: null }
let declinedNames

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn((entity) => {
      if (entity === 'activities') return Promise.resolve([EXISTING_CERAMICS])
      return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
    }),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 2, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
    write: vi.fn().mockResolvedValue({ status: 'applied' }),
    recordDeclinedSplit: vi.fn().mockResolvedValue({ ok: true }),
    listDeclinedSplitNames: vi.fn(() => Promise.resolve(declinedNames)),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  // "Reuse it"'s stage-and-apply path goes through the real
  // setupCrudRepository.writeFields (unlike Split, which routes through the
  // mocked emitTwoRowSplit), whose default getToken() reads
  // localStorage — absent by default under jsdom in this project's setup.
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'test-token') })
  declinedNames = []
  localClient.list.mockImplementation((entity) => {
    if (entity === 'activities') return Promise.resolve([EXISTING_CERAMICS])
    return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
  })
  localClient.write.mockResolvedValue({ status: 'applied' })
  localClient.recordDeclinedSplit.mockResolvedValue({ ok: true })
  localClient.listDeclinedSplitNames.mockImplementation(() => Promise.resolve(declinedNames))
  emitTwoRowSplitMock = vi.fn(async ({ existingActivity, suffix }) => ({
    outcome: 'split',
    existingActivityId: existingActivity.id,
    newActivityId: 'act-ceramics-rec',
    newActivityName: `${existingActivity.name}${suffix}`,
    created: true,
  }))
})

async function uploadFile(onNavigate = () => {}) {
  render(<ImportScreen campId="camp-1" onNavigate={onNavigate} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getAllByText(/Ceramics/).length).toBeGreaterThan(0))
}

// Reaches the (stubbed) ReconciliationScreen and fires its onCommitted, so
// HIGH #1's commit-time apply seam (handleReconciliationCommitted ->
// applyStagedSplits) actually runs.
async function goToCommit() {
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await userEvent.click(await screen.findByText('Commit (test)'))
}

describe('ImportScreen — two-rows split suggestion (Slice 2b)', () => {
  it('shows the disclosure link only for the dual-use non-declined name', async () => {
    await uploadFile()
    expect(screen.getByText('Also a flexible activity — split into two?')).toBeTruthy()
    // Lunch is pin-only (not dual-use) — no suggestion for it, and only one
    // link total even though only one name qualifies.
    expect(screen.getAllByText('Also a flexible activity — split into two?')).toHaveLength(1)
  })

  it('does not render the suggestion for a declined name', async () => {
    declinedNames = ['ceramics']
    await uploadFile()
    expect(screen.queryByText('Also a flexible activity — split into two?')).toBeNull()
  })

  it('expands into the editable-suffix card and can collapse again', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    expect(await screen.findByRole('textbox')).toBeTruthy()
    expect(screen.getByText(/also appears on its own/)).toBeTruthy()
  })

  it('editable suffix updates the live preview', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    const input = await screen.findByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, ' (flex)')
    expect(await screen.findByText('→ "Ceramics (flex)" (flexible)')).toBeTruthy()
  })

  it('a degenerate suffix disables Split and shows the validation message', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    const input = await screen.findByRole('textbox')
    await userEvent.clear(input)
    expect(await screen.findByText('Add a suffix so the two activities have different names.')).toBeTruthy()
    expect(screen.getByText('Split').closest('button').disabled).toBe(true)
  })

  // HIGH #1 (Red Hat, Slice 2b round 2) — Split must STAGE, not write. The
  // screen's own contract ("Nothing is added until you have looked at the
  // list and said so") is violated if a Split click mints an activities row
  // during review, before the import itself is committed.
  it('a clean Split does NOT write — it stages the decision and shows the confirmed line', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    await userEvent.click(await screen.findByText('Split'))
    expect(await screen.findByText('Split into Ceramics + Ceramics (rec).')).toBeTruthy()
    expect(screen.queryByText('Also a flexible activity — split into two?')).toBeNull()
    // The confirmed line renders from the client-side preview alone —
    // emitTwoRowSplit is not called until commit.
    expect(emitTwoRowSplitMock).not.toHaveBeenCalled()
  })

  it('the staged split is applied via emitTwoRowSplit once, at import commit', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    await userEvent.click(await screen.findByText('Split'))
    expect(emitTwoRowSplitMock).not.toHaveBeenCalled()

    await goToCommit()

    await waitFor(() => expect(emitTwoRowSplitMock).toHaveBeenCalledTimes(1))
    const call = emitTwoRowSplitMock.mock.calls[0][0]
    expect(call.existingActivity).toEqual(EXISTING_CERAMICS)
    expect(call.suffix).toBe(' (rec)')
    // The re-fetched (post-commit) activities list, not the stale
    // existingRecordsAll snapshot from readFiles (LOW/MED #3).
    expect(call.existingActivities).toEqual([EXISTING_CERAMICS])
  })

  // ADR docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md retired the
  // onImported carrier (Roots has no post-import banner of its own anymore)
  // — a split failure is now surfaced locally in ImportScreen's own danger
  // banner, and the screen holds the director there instead of navigating
  // to Roots. The property this guards (a split failure is never silently
  // dropped) is unchanged; only the surfacing mechanism moved.
  it('surfaces every staged split failure when the activity re-fetch FAILS at commit — not silently dropped (Red Hat HIGH A)', async () => {
    const onNavigate = vi.fn()
    await uploadFile(onNavigate)
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    await userEvent.click(await screen.findByText('Split'))

    // The post-commit activities re-fetch rejects (e.g. lock contention).
    localClient.list.mockImplementation((entity) => {
      if (entity === 'activities') return Promise.reject(new Error('db locked'))
      return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
    })
    await goToCommit()

    await waitFor(() => expect(screen.getByText(/couldn.t be saved/)).toBeTruthy())
    expect(screen.getByText(/Ceramics/)).toBeTruthy()
    expect(screen.getByText(/could.?n.?t be applied/)).toBeTruthy()
    expect(onNavigate).not.toHaveBeenCalledWith('roots')
    expect(emitTwoRowSplitMock).not.toHaveBeenCalled()
  })

  it('surfaces a staged split whose activity vanished between staging and commit (Red Hat)', async () => {
    const onNavigate = vi.fn()
    await uploadFile(onNavigate)
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    await userEvent.click(await screen.findByText('Split'))

    // The pinned activity is gone from the re-fetched list at commit time.
    localClient.list.mockImplementation((entity) => {
      if (entity === 'activities') return Promise.resolve([])
      return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
    })
    await goToCommit()

    await waitFor(() => expect(screen.getByText(/no longer in your setup/)).toBeTruthy())
    expect(onNavigate).not.toHaveBeenCalledWith('roots')
  })

  it('discarding the import drops the staged split — no write happens', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    await userEvent.click(await screen.findByText('Split'))
    expect(await screen.findByText('Split into Ceramics + Ceramics (rec).')).toBeTruthy()

    await userEvent.click(screen.getByText(/Add \d+ record/))
    await userEvent.click(await screen.findByText('Discard (test)'))

    expect(emitTwoRowSplitMock).not.toHaveBeenCalled()
    expect(localClient.write).not.toHaveBeenCalled()
    // Back on the file-upload antechamber (ledger + proposal cleared) — the
    // staged split decision was dropped along with everything else review-time.
    expect(await screen.findByText('Choose the file, or all of them')).toBeTruthy()
  })

  it('a collision found at review time shows the three-way reuse/rename/cancel, without writing', async () => {
    // A row already named "Ceramics (rec)" exists — the client precheck
    // (computeSplitPreview) must catch this before Split ever calls
    // emitTwoRowSplit. Since preview.collision is already true before any
    // click, the card renders straight into the three-way — there is no
    // Split button to click through in this state.
    const collidingRow = { id: 'act-existing-rec', name: 'Ceramics (rec)', camp_id: 'camp-1', recurrence_truth_status: null }
    localClient.list.mockImplementation((entity) => {
      if (entity === 'activities') return Promise.resolve([EXISTING_CERAMICS, collidingRow])
      return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
    })
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    expect(await screen.findByText('Reuse it')).toBeTruthy()
    expect(screen.getByText('Pick a different name')).toBeTruthy()
    // Disambiguate from the main-form Cancel button by its subtitle.
    expect(screen.getByText('Leave "Ceramics" as one activity.')).toBeTruthy()
    expect(emitTwoRowSplitMock).not.toHaveBeenCalled()
  })

  it('"Reuse it" stages a pin-only decision, applied at commit without calling emitTwoRowSplit', async () => {
    const collidingRow = { id: 'act-existing-rec', name: 'Ceramics (rec)', camp_id: 'camp-1', recurrence_truth_status: null }
    localClient.list.mockImplementation((entity) => {
      if (entity === 'activities') return Promise.resolve([EXISTING_CERAMICS, collidingRow])
      return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
    })
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    await userEvent.click(await screen.findByText('Reuse it'))
    expect(await screen.findByText('Split into Ceramics + Ceramics (rec).')).toBeTruthy()
    expect(localClient.write).not.toHaveBeenCalled()

    await goToCommit()

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    expect(emitTwoRowSplitMock).not.toHaveBeenCalled()
  })

  it('"Not now" records the decline and suppresses the suggestion for the rest of the session', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Also a flexible activity — split into two?'))
    await userEvent.click(await screen.findByText('Not now'))
    await waitFor(() => expect(localClient.recordDeclinedSplit).toHaveBeenCalledWith('Ceramics'))
    expect(screen.queryByText('Also a flexible activity — split into two?')).toBeNull()
  })
})
