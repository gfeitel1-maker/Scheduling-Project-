// @vitest-environment jsdom
//
// T73 — the held-import resolution UI (design spec
// docs/work/onboarding-reconciliation/T73-HELD-CONFLICT-RESOLUTION-DESIGN.md).
//
// The dev mock never produces a held state and Electron can't run here, so this
// suite drives the interaction logic deterministically by mocking
// localClient.ingestCommit to return a HELD outcome, then asserting the queue's
// behaviour and, critically, the EXACT `resolutions` payload the re-commit sends
// (that payload is the wire contract the verified backend consumes).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Same parser/inference stubs as ImportScreen.test.jsx: the proposal here is a
// realistic small import (two activities incl. "Art", one day). The extracted
// names must include the ones our held conflicts refer to, because a "skip"
// resolution removes the name from the re-submit `approved` set and we assert it.
vi.mock('../ingest/textGrid', () => ({ parseTextGrid: () => ({ pages: [{ title: 'x', columns: [], rows: [] }] }) }))
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: () => ({
      orientation: { columns: 'days', pages: 'groups', confident: true },
      entities: {
        groups: [],
        days_of_operation: ['Monday'],
        time_blocks: [],
        activities: ['Art', 'Swim'],
        tiers: [],
        cohorts: [],
      },
      groupUnits: {},
      groupNameByTitle: {},
      activityPages: {},
      seenCounts: { activities: { Art: 5, Swim: 4 } },
      counts: { days_of_operation: 1, activities: 2 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [] }) }))
vi.mock('../ingest/activityRules', () => ({ inferActivityRules: () => new Map() }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    ingestCommit: vi.fn(),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

// A held outcome with a realistic mix: one ambiguous_identity (Art/art ) and one
// stale (Monday's sort_order, human set 3, file says 1). Shapes match exactly
// what electron/ops/ingest.js returns (buildPlan's makeConflict / makeStaleConflict).
const ambiguousArt = {
  op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity',
  fields: {}, _name: 'Art',
  evidence: { tier: 'exact_name', candidates: [{ id: 'art-1', name: 'Art' }, { id: 'art-2', name: 'art ' }] },
}
const staleMonday = {
  op: 'conflict', entity: 'days_of_operation', entity_id: 'd-mon', reason: 'stale', _name: 'Monday',
  fields: { sort_order: { from: 3, to: 1, source: 'import', conflict: { reason: 'stale' } } },
  evidence: { tier: 'exact_name', matched_name: 'Monday' },
}
const heldOutcome = (conflicts) => ({ held: true, conflicts, created: {}, total: 0, updated: 0, fixedEvents: { created: 0, skipped: [], partial: [] } })

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
})

// Upload the file, tick nothing extra, and commit — the mocked ingestCommit
// returns the held outcome, so the screen enters the held state.
async function uploadAndHold(conflicts = [ambiguousArt, staleMonday]) {
  localClient.ingestCommit.mockResolvedValueOnce(heldOutcome(conflicts))
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getAllByText(/Art/).length).toBeGreaterThan(0))
  // S5b/T75 — the tick-preview now stages the shared reconciliation ledger; the
  // director confirms from it before the atomic commit runs.
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await userEvent.click(await screen.findByText(/Commit \d+ record/))
  await waitFor(() => expect(screen.getByText(/Almost there/)).toBeTruthy())
}

async function enterQueue() {
  await userEvent.click(screen.getByText(/Review the \d+ item/))
}

// ---------------------------------------------------------------------------
// 1. Entry banner
// ---------------------------------------------------------------------------
describe('T73 — HeldEntry banner (spec §1)', () => {
  it('renders as a pause (not an error), counts the items, and gives the safety reassurance', async () => {
    await uploadAndHold()
    // Two conflicts → two queue items.
    expect(screen.getByText(/ready except for 2 items I need you on/)).toBeTruthy()
    expect(screen.getByText(/Nothing has been added or changed yet/)).toBeTruthy()
    // A held return must NOT surface as the error banner.
    expect(screen.queryByText(/Nothing was imported\. Your camp is exactly as it was/)).toBeNull()
  })

  it('entering the queue shows the first (identity) item first', async () => {
    await uploadAndHold()
    await enterQueue()
    expect(screen.getByText(/A few things to sort out/)).toBeTruthy()
    // Identity is ordered before stale (§2.3), so the focused card is the Art one.
    expect(screen.getByText(/Which one is this\?|Is this the same thing\?/)).toBeTruthy()
    expect(screen.getByText(/You’re on 1 of 2/)).toBeTruthy()
  })

  it('singularises the count for a single held item', async () => {
    await uploadAndHold([staleMonday])
    expect(screen.getByText(/ready except for 1 item I need you on/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 2. Identity item requires an explicit choice
// ---------------------------------------------------------------------------
describe('T73 — Confirm-identity card (spec §3.1)', () => {
  it('records {choice:existing, entity_id} for "use my existing", and finishes with that resolution', async () => {
    await uploadAndHold()
    await enterQueue()
    // Two candidates → the one-vs-many chooser. Pick "art " (art-2).
    await userEvent.click(screen.getByText(/Use “art ”/))
    // Answer the stale item too (default keep) by visiting it, then finish.
    await finishAll()
    const resolutions = lastResolutions()
    expect(resolutions).toContainEqual({ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'art-2' })
  })

  it('records {choice:create} for "add as new"', async () => {
    // Candidates that do NOT share the incoming raw name, so "add new" is offered.
    const ambiguous = {
      ...ambiguousArt,
      evidence: { tier: 'exact_name', candidates: [{ id: 'art-1', name: 'art ' }, { id: 'art-2', name: 'ART' }] },
    }
    await uploadAndHold([ambiguous])
    await enterQueue()
    await userEvent.click(screen.getByText(/add “Art” as new/))
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
    expect(lastResolutions()).toContainEqual({ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'create' })
  })

  it('"skip" removes that name from the re-submit approved set (and sends no resolution for it)', async () => {
    await uploadAndHold([ambiguousArt])
    await enterQueue()
    await userEvent.click(screen.getByText(/Skip this for now/))
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
    const recommit = localClient.ingestCommit.mock.calls[1][0]
    // "Art" is dropped from approved.activities; the clean "Swim" survives.
    expect(recommit.approved.activities).not.toContain('Art')
    expect(recommit.approved.activities).toContain('Swim')
    expect(recommit.resolutions).toEqual([]) // skip carries no resolution
  })

  it('suppresses "add as new" when a candidate shares the incoming raw name', async () => {
    // ambiguousArt's candidates include "Art" (raw-equal to the incoming label),
    // so offering "create new" would re-hold on UNIQUE — it must be suppressed.
    await uploadAndHold([ambiguousArt])
    await enterQueue()
    expect(screen.queryByText(/add “Art” as new/)).toBeNull()
    // The two existing candidates and Skip are still offered.
    expect(screen.getByText(/Use “Art”/)).toBeTruthy()
    expect(screen.getByText(/Use “art ”/)).toBeTruthy()
    expect(screen.getByText(/Skip this for now/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 3. Stale item — seen-is-answered, keep-mine default
// ---------------------------------------------------------------------------
describe('T73 — Kept-change card (spec §3.2)', () => {
  it('untouched stale item yields {choice:keep} and drops the field', async () => {
    // Only the stale item, so it is seen-answered on entry with keep-mine default
    // → the Finish card is available immediately.
    await uploadAndHold([staleMonday])
    await enterQueue()
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
    expect(lastResolutions()).toContainEqual({ entity: 'days_of_operation', name: 'Monday', reason: 'stale', field: 'sort_order', choice: 'keep' })
  })

  it('choosing "use the file\'s value" yields {choice:accept}', async () => {
    // A companion identity item keeps the gate open so the stale CARD stays on
    // screen while we toggle it (a lone stale jumps straight to the Finish card).
    await uploadAndHold([ambiguousArt, staleMonday])
    await enterQueue()
    await userEvent.click(screen.getByRole('button', { name: /Monday — the order it appears in/ })) // focus the stale via its rail row
    await userEvent.click(screen.getByRole('button', { name: /Use the file/ }))
    await userEvent.click(screen.getByText(/Use “Art”/))   // answer the identity → all answered
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
    expect(lastResolutions()).toContainEqual({ entity: 'days_of_operation', name: 'Monday', reason: 'stale', field: 'sort_order', choice: 'accept' })
  })

  it('the full-contrast value is always the one that will take effect (emphasis swaps on toggle)', async () => {
    await uploadAndHold([ambiguousArt, staleMonday])
    await enterQueue()
    await userEvent.click(screen.getByRole('button', { name: /Monday — the order it appears in/ })) // focus the stale card
    // Confirm the stale card is on screen via its "Use the file's" button, then
    // read the two diff value spans. Only the diff values are standalone <span>s
    // with exact text "3"/"1" (choice-button values live inside <div>s).
    await screen.findByRole('button', { name: /Use the file/ })
    const valueSpan = (val) => [...document.querySelectorAll('span')].find((s) => s.textContent === val)

    // Keep-mine default: the director's value (3) full-contrast, the file's (1) muted+struck.
    expect(valueSpan('3').getAttribute('style')).toMatch(/font-weight:\s*600/)
    expect(valueSpan('1').getAttribute('style')).not.toMatch(/font-weight:\s*600/)
    expect(valueSpan('3').getAttribute('style')).not.toMatch(/line-through/)

    // Flip to "use the file's". Answering auto-advances to the next item, so
    // re-open the stale card (its rail row) to see the swapped emphasis: the
    // file's value now full, the director's muted with a strike (being replaced).
    await userEvent.click(screen.getByRole('button', { name: /Use the file/ }))
    await userEvent.click(screen.getByRole('button', { name: /Monday — the order it appears in/ }))
    await screen.findByRole('button', { name: /Use the file/ })
    expect(valueSpan('1').getAttribute('style')).toMatch(/font-weight:\s*600/)
    expect(valueSpan('3').getAttribute('style')).toMatch(/line-through/)
  })
})

// ---------------------------------------------------------------------------
// 4. Commit gate
// ---------------------------------------------------------------------------
describe('T73 — commit gate (spec §4)', () => {
  it('is gated on the identity item until it is explicitly answered', async () => {
    await uploadAndHold([ambiguousArt, staleMonday])
    await enterQueue()
    // At entry only the current (identity) card is seen; the stale item hasn't
    // been opened yet, so both are unanswered and no Finish card shows.
    expect(screen.getByText(/Nothing goes in until all 2 are answered/)).toBeTruthy()
    expect(screen.queryByText(/Finish import/)).toBeNull()
    expect(screen.getByText(/Waiting on 2/)).toBeTruthy()

    // Answer the identity → auto-advance opens (sees) the stale item, which is
    // seen-is-answered, so the gate clears and the Finish card appears.
    await userEvent.click(screen.getByText(/Use “Art”/))
    await waitFor(() => expect(screen.getByText(/All sorted\. Here’s what will go in/)).toBeTruthy())
    expect(screen.getByText(/Finish import/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 5. Finish re-invokes ingestCommit with original inputs + resolutions
// ---------------------------------------------------------------------------
describe('T73 — Finish re-commits (spec §4.2, ADR §1)', () => {
  it('re-sends the ORIGINAL inputs plus the exact resolutions array', async () => {
    await uploadAndHold([ambiguousArt, staleMonday])
    const firstInputs = localClient.ingestCommit.mock.calls[0][0]
    await enterQueue()
    await userEvent.click(screen.getByText(/Use “Art”/))       // identity → existing art-1
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))

    const recommit = localClient.ingestCommit.mock.calls[1][0]
    // Original inputs preserved (same approved, cohort, mode).
    expect(recommit.approved).toEqual(firstInputs.approved)
    expect(recommit.cohort_id).toBe('cohort-1')
    expect(recommit.mode).toBe('add')
    // The exact resolutions payload (identity existing + stale keep-by-default).
    expect(recommit.resolutions).toEqual([
      { entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'art-1' },
      { entity: 'days_of_operation', name: 'Monday', reason: 'stale', field: 'sort_order', choice: 'keep' },
    ])
  })

  it('surfaces a re-held response honestly (a peer-race note), not as an error/throw', async () => {
    await uploadAndHold([ambiguousArt])
    await enterQueue()
    await userEvent.click(screen.getByText(/Use “Art”/))
    // The re-commit itself comes back held with a NEW conflict (peer race).
    localClient.ingestCommit.mockResolvedValueOnce(heldOutcome([staleMonday]))
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(screen.getByText(/One more came up while you were working/)).toBeTruthy())
    // Not thrown to the error banner. The new item is folded into the queue — its
    // question appears in the rail (a lone new stale is seen-answered on focus, so
    // the surface shows the Finish card again rather than throwing the director back).
    expect(screen.queryByText(/Nothing was imported\. Your camp is exactly as it was/)).toBeNull()
    expect(screen.getByText(/Monday — the order it appears in/)).toBeTruthy()
    expect(screen.getByText(/Finish import/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 6. Leaving mid-resolution
// ---------------------------------------------------------------------------
describe('T73 — leaving mid-resolution (spec §5)', () => {
  it('shows a leave-confirm (not a destructive gate) and discards in-progress answers', async () => {
    await uploadAndHold([ambiguousArt, staleMonday])
    await enterQueue()
    // Mid-resolution (identity still open, nothing committed): the footer Leave.
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(screen.getByText(/Leave without finishing\?/)).toBeTruthy()
    expect(screen.getByText(/won’t be saved/)).toBeTruthy()
    // Two "Leave" buttons now (footer + confirm); the confirm's is last.
    const leaveButtons = screen.getAllByRole('button', { name: 'Leave' })
    await userEvent.click(leaveButtons[leaveButtons.length - 1])
    await waitFor(() => expect(screen.queryByText(/A few things to sort out/)).toBeNull())
    // Back to the untouched pre-import state; only the first (held) commit ever
    // happened — leaving persisted nothing and sent no re-commit.
    expect(localClient.ingestCommit).toHaveBeenCalledTimes(1)
  })

  it('banner "Not now" dismisses without a prompt when the queue was never entered', async () => {
    await uploadAndHold([ambiguousArt])
    await userEvent.click(screen.getByText(/Not now/))
    await waitFor(() => expect(screen.queryByText(/Almost there/)).toBeNull())
    expect(screen.queryByText(/Leave without finishing\?/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// helpers that answer every item and finish
// ---------------------------------------------------------------------------
function lastResolutions() {
  const calls = localClient.ingestCommit.mock.calls
  return calls[calls.length - 1][0].resolutions
}

// Answer the identity (pick first candidate) if present, visit the stale (seen =
// answered), then click Finish. Used where the specific identity choice is set
// by the caller before calling this.
async function finishAll() {
  // The stale card only becomes reachable once identity is answered (auto-advance),
  // so by here identity is chosen. If a Finish button is present, click it.
  await waitFor(() => expect(screen.getByText(/Finish import/)).toBeTruthy())
  await userEvent.click(screen.getByText(/Finish import/))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
}
