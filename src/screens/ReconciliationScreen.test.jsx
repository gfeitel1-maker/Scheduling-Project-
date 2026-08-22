// @vitest-environment jsdom
//
// Behavior-level tests for the one-screen reconciliation surface (R2'b),
// per handoff §23: high-confidence understood does NOT demand review;
// ambiguity does; resolving changes the eventual model; counts update after
// resolution; read-only reconciliation never mutates; the last-issued-wins
// guard protects the debounced dry-run re-issue (ADR Risk #3).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    ingestReconcile: vi.fn(),
    ingestCommit: vi.fn(),
    confirmAlias: vi.fn().mockResolvedValue({ id: 'alias-1', superseded: null }),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    latestOpSeq: vi.fn().mockResolvedValue(0),
    // Task 4 — the surviving grace-window undo now lives on Roots.
    ingestUndo: vi.fn().mockResolvedValue({ deleted: [], skipped: [], kept: [] }),
  },
}))

// Text broken across sibling nodes by interleaved JSX expressions — the
// deepest element whose full text matches, per RTL's own docs.
function textNode(regex) {
  return (_, element) => {
    const has = (node) => regex.test(node.textContent ?? '')
    return has(element) && Array.from(element.children).every((child) => !has(child))
  }
}

const downloadWorkbook = vi.fn()
vi.mock('../utils/exportWorkbook.js', () => ({ downloadWorkbook: (...a) => downloadWorkbook(...a) }))

import ReconciliationScreen from './ReconciliationScreen.jsx'
import { localClient } from '../localClient'
import { getReadiness, describeReadiness } from '../engine/readiness.js'

const baseInputs = { approved: { activities: ['Art'] }, cohort_id: null, mode: 'add' }

function understoodOnlyResult() {
  return {
    planItems: [{ op: 'create', entity: 'activities', entity_id: null, _name: 'Art', fields: {}, evidence: { tier: 'new' } }],
    fixedEventsReport: {},
    legacyPriorityActivities: [],
    fieldProvenance: {},
    evidenceSupport: {},
  }
}

function oneChangedResult() {
  return {
    planItems: [
      {
        op: 'update', entity: 'activities', entity_id: 'a1', _name: 'Swim',
        fields: { min_per_week: { to: 2 } }, evidence: { tier: 'low' },
      },
    ],
    fixedEventsReport: {},
    legacyPriorityActivities: [],
    fieldProvenance: {},
    evidenceSupport: {},
  }
}

function ambiguousIdentityHeld() {
  return {
    held: true,
    conflicts: [{
      entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity',
      candidates: [{ entity_id: 'g1', name: 'Chipmunks' }],
    }],
  }
}

// F3 changes what an empty `list()` means for readiness: every required area
// (tiers/groups/days/timeblocks/activities) reads as `missing`, which now
// surfaces as a `required_gap` hold-lane card (docs/adr/2026-08-17-onescreen-
// reconciliation-merge.md §5). Tests that aren't exercising readiness need a
// "ready" camp by default so their pre-existing spine-count assertions still
// hold; only the F3-specific tests below opt into an unready camp.
beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([{ id: 'x' }])
  localClient.confirmAlias.mockResolvedValue({ id: 'alias-1', superseded: null })
})

describe('understood vs. needs-attention', () => {
  it('a high-confidence create never demands review — no card, spine denominator 0', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/0 of 0 done/)).toBeTruthy())
    expect(screen.queryByText(/Use the file's value/)).toBeNull()
    expect(screen.getByText(/1 rows read cleanly/)).toBeTruthy()
  })

  it('a low-confidence field change on an existing row surfaces a card and counts in the spine denominator', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())
  })
})

describe('resolving a decision', () => {
  it('updates the done count and stages a confirmed decision, without writing anything (read-only reconciliation)', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    await userEvent.click(screen.getByText('Use this value'))
    await waitFor(() => expect(screen.getByText(/1 of 1 done/)).toBeTruthy())
    expect(screen.getByText(/1 decisions staged/)).toBeTruthy()
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
  })

  it('leaving a decision unresolved and applying only confirmed changes never touches it, per the two truthful buttons', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    localClient.ingestCommit.mockResolvedValue({ total: 1 })
    const onCommitted = vi.fn()
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={onCommitted} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    const applyConfirmedOnly = screen.getByText('Apply confirmed changes and keep the rest for review')
    expect(applyConfirmedOnly.disabled).toBe(true)

    const useThisSetup = screen.getByText('Use this setup')
    expect(useThisSetup.disabled).toBe(true)
  })
})

describe('evidence disclosure (FIX 2, design spec §4)', () => {
  it('renders a human-readable sentence, never raw JSON, for a decision with structured evidence but no locator/editor identity', async () => {
    localClient.ingestReconcile.mockResolvedValue({
      planItems: [{
        op: 'update', entity: 'activities', entity_id: 'a1', _name: 'Swim',
        fields: { min_per_week: { to: 2 } }, evidence: { tier: 'low' },
      }],
      fixedEventsReport: {},
      legacyPriorityActivities: [],
      fieldProvenance: {},
      evidenceSupport: { activities: { a1: { matched_groups: ['Bunk 1', 'Bunk 2'], appearances: 2, eligible_group_count: 2 } } },
    })
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    await userEvent.click(screen.getByText('Why?'))

    // Scoped to the panel — RootMap's own chip info layer (docs/work/specs/
    // 2026-08-21-roots-metaphor-visual.md) can surface the same evidence
    // sentence on its attention chip, so an unscoped query is ambiguous.
    const panel = within(screen.getByLabelText('Needs your attention'))
    expect(panel.getByText(/seen across 2 groups/)).toBeTruthy()
    expect(screen.queryByText(/matched_groups/)).toBeNull()
    expect(screen.queryByText(/[{}]/)).toBeNull()
  })

  it('degrades to the plain collapsed line, never an empty table or JSON, when evidence has no locator or editor identity', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    await userEvent.click(screen.getByText('Why?'))

    expect(screen.getByText(/No evidence details available for this field\.|From this file — a guess/)).toBeTruthy()
    expect(screen.queryByText('Current Shoresh record')).toBeNull()
  })
})

// docs/adr/2026-08-18-rootmap-screen-port.md §5 replaces the old chip-row
// multi-select-by-domain filter with the root-map's single-selection union
// (a tile filters by STATE across domains; a root node selects one
// domain/child, any state). This is an intentional UX narrowing dictated by
// the interaction spec, not a regression — verified here against the root
// map's own aria-labelled nodes/tiles instead of the retired chip labels.
describe('root-map selection (replaces the old chip-row filter)', () => {
  it('a root node click shows only that node\'s decisions; clicking a different node replaces, never appends', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    // Default view shows the one decision unfiltered.
    expect(screen.getByText('Keep current')).toBeTruthy()

    // The Facility domain node has zero decisions — selecting it clears the
    // Scheduling decision from view (single-select, node replaces node).
    await userEvent.click(screen.getByLabelText(/Facility — /))
    expect(screen.queryByText('Keep current')).toBeNull()
    expect(screen.getByText('Everything here looks right.')).toBeTruthy()

    // Selecting the Scheduling domain node brings it back.
    await userEvent.click(screen.getByLabelText(/Scheduling — /))
    expect(screen.getByText('Keep current')).toBeTruthy()

    // "Show all" clears the selection back to the default view.
    await userEvent.click(screen.getByText('Show all'))
    expect(screen.getByText('Keep current')).toBeTruthy()
  })

  it('a tile click filters the root map to that state across domains; clicking it again toggles off', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    const attentionTile = screen.getByText('Needs attention').closest('button')
    await userEvent.click(attentionTile)
    expect(screen.getByText('Keep current')).toBeTruthy()
    expect(attentionTile.getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(attentionTile) // toggle back off
    expect(attentionTile.getAttribute('aria-pressed')).toBe('false')
  })
})

// RA-10 (docs/adr/2026-08-21-roots-tree-as-primary.md §(c)) — on a wide
// canvasWrap (>= 900px measured width), RootMapPanel lifts into the
// lower-canvas region via CSS position only; below the breakpoint it sits in
// normal document flow. Round-2 review fix (MEDIUM-HIGH): this must NOT be
// implemented via createPortal toggling between two parent elements — that
// unmounts/remounts RootMapPanel (losing its internal `showResolved` state
// and replaying its enter animation) on every plain window resize. The panel
// stays mounted at ONE stable JSX position; only its wrapper's style changes.
describe('RootMapPanel placement (RA-10)', () => {
  const originalResizeObserver = global.ResizeObserver
  let observedCallback
  let observedElements

  beforeEach(() => {
    observedElements = []
    global.ResizeObserver = class {
      constructor(callback) { observedCallback = callback }
      observe(el) { observedElements.push(el) }
      unobserve() {}
      disconnect() {}
    }
  })
  afterEach(() => {
    global.ResizeObserver = originalResizeObserver
  })

  it('switches the panel wrapper to absolute positioning on wide width and back to normal flow on narrow width', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    const panelWrapper = screen.getByLabelText('Needs your attention').parentElement

    // Before any resize signal — today's normal-flow placement.
    expect(panelWrapper.style.position).not.toBe('absolute')

    act(() => { observedCallback([{ contentRect: { width: 1000 } }]) })
    expect(panelWrapper.style.position).toBe('absolute')

    act(() => { observedCallback([{ contentRect: { width: 500 } }]) })
    expect(panelWrapper.style.position).not.toBe('absolute')
  })

  it('applies hysteresis so a slow drag across the edge does not flip-flop (enter wide at >=900, exit at <880)', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)
    const panelWrapper = screen.getByLabelText('Needs your attention').parentElement

    act(() => { observedCallback([{ contentRect: { width: 900 } }]) })
    expect(panelWrapper.style.position).toBe('absolute')

    // Dips into the dead zone between 880 and 900 — must stay wide.
    act(() => { observedCallback([{ contentRect: { width: 890 } }]) })
    expect(panelWrapper.style.position).toBe('absolute')

    act(() => { observedCallback([{ contentRect: { width: 875 } }]) })
    expect(panelWrapper.style.position).not.toBe('absolute')
  })

  it('never remounts RootMapPanel across a breakpoint crossing — internal state and DOM identity persist', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    const panelNode = screen.getByLabelText('Needs your attention')

    // Resolve the one decision (client-side, synchronous) so RootMapPanel's
    // own `showResolved` local state becomes reachable via a real click.
    await userEvent.click(screen.getByText('Keep current'))
    await userEvent.click(screen.getByText(/resolved · Show all/))
    expect(screen.getByText('Hide resolved')).toBeTruthy()

    act(() => { observedCallback([{ contentRect: { width: 1000 } }]) })
    expect(screen.getByText('Hide resolved')).toBeTruthy() // state persisted
    expect(screen.getByLabelText('Needs your attention')).toBe(panelNode) // same DOM node

    act(() => { observedCallback([{ contentRect: { width: 500 } }]) })
    expect(screen.getByText('Hide resolved')).toBeTruthy()
    expect(screen.getByLabelText('Needs your attention')).toBe(panelNode)

    // Drain the 250ms debounced dry-run stage() scheduled by the "Keep
    // current" click above, with REAL timers — otherwise that setTimeout
    // fires after this test has already ended, consuming a
    // mockImplementationOnce entry queued by a later, unrelated test (the
    // "last-issued-wins guard" describe right after this one).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })
  })
})

describe('last-issued-wins guard (ADR Risk #3)', () => {
  it('a stale, out-of-order dry-run response never overwrites a newer in-flight one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let resolveGen2
      const gen2 = new Promise((resolve) => { resolveGen2 = resolve })
      let resolveGen3
      const gen3 = new Promise((resolve) => { resolveGen3 = resolve })

      localClient.ingestReconcile
        .mockImplementationOnce(() => Promise.resolve(oneChangedResult())) // mount (gen 1)
        .mockImplementationOnce(() => gen2) // first debounced re-issue — stays pending
        .mockImplementationOnce(() => gen3) // second debounced re-issue — resolves LAST but was issued LAST

      render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
      await vi.waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())

      // First triage action: schedules the debounced re-issue (gen 2).
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText('Use this value'))
      await vi.advanceTimersByTimeAsync(250)
      // gen 2's request is now in flight (pending on gen2 promise).

      // H1 (docs/work/specs/2026-08-19-roots-reconciliation-audit.md §12
      // Slice 1) — the default panel view now scopes to the unresolved
      // subset, so the just-resolved decision (and its Undo affordance)
      // moved behind the "N resolved · Show all" reveal. Reveal it before
      // undoing — this is the new, intended path, not a workaround.
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText(/resolved · Show all/))
      // Second triage action before gen 2 resolves: schedules gen 3.
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText('Undo'))
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText('Use this value'))
      await vi.advanceTimersByTimeAsync(250)
      // gen 3's request is now in flight too.

      // Resolve them OUT OF ORDER: gen 3 (newer) lands first, then gen 2 (stale) lands late.
      resolveGen3(understoodOnlyResult())
      await vi.waitFor(() => expect(screen.getByText(/0 of 0 done/)).toBeTruthy())

      resolveGen2(oneChangedResult())
      await vi.advanceTimersByTimeAsync(0)
      // The stale gen-2 response must have been dropped — the newer gen-3
      // result (0 of 0, understood-only) must still be what's rendered.
      expect(screen.getByText(/0 of 0 done/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('held-identity: skip this row', () => {
  it('offers a "leave unset for now" option that leaves the row pending and writes nothing', async () => {
    localClient.ingestReconcile.mockResolvedValue(ambiguousIdentityHeld())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    await userEvent.click(screen.getByText('Leave unset for now'))

    // Skipping is not a resolution — the count stays unresolved and the
    // "apply confirmed only" path (the only one that would write anything)
    // stays disabled, so nothing is ever sent to ingestCommit.
    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())
    expect(screen.getByText('Apply confirmed changes and keep the rest for review').disabled).toBe(true)
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
  })
})

describe('held-identity: remember this alias (confirmAlias)', () => {
  it('shows a default-checked "remember" checkbox only after choosing an existing candidate', async () => {
    localClient.ingestReconcile.mockResolvedValue(ambiguousIdentityHeld())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    expect(screen.queryByRole('checkbox')).toBeNull()
    await userEvent.click(screen.getByText('Use "Chipmunks"'))
    // H1 — resolving the decision moves it behind the default view's "N
    // resolved · Show all" reveal (docs/work/specs/2026-08-19-roots-
    // reconciliation-audit.md §12 Slice 1); reveal it to see its checkbox.
    await waitFor(() => expect(screen.getByText(/resolved · Show all/)).toBeTruthy())
    await userEvent.click(screen.getByText(/resolved · Show all/))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy())
    expect(screen.getByRole('checkbox').checked).toBe(true)
  })

  it('calls confirmAlias with the mapped args after a successful apply, left checked (default)', async () => {
    localClient.ingestReconcile.mockResolvedValue(ambiguousIdentityHeld())
    localClient.ingestCommit.mockResolvedValue({ held: false, total: 1 })
    const onCommitted = vi.fn()
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={onCommitted} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    await userEvent.click(screen.getByText('Use "Chipmunks"'))
    await waitFor(() => expect(screen.getByText(/1 of 1 done/)).toBeTruthy())
    await userEvent.click(screen.getByText('Use this setup'))

    await waitFor(() => expect(localClient.confirmAlias).toHaveBeenCalledTimes(1))
    expect(localClient.confirmAlias).toHaveBeenCalledWith({
      entity_type: 'groups', cohort_id: null, source_label: 'Chipmunks', entity_id: 'g1',
    })
    expect(onCommitted).toHaveBeenCalled()
  })

  it('unchecking the checkbox excludes the mapping from confirmAlias', async () => {
    localClient.ingestReconcile.mockResolvedValue(ambiguousIdentityHeld())
    localClient.ingestCommit.mockResolvedValue({ held: false, total: 1 })
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    await userEvent.click(screen.getByText('Use "Chipmunks"'))
    // H1 — reveal the resolved decision to reach its checkbox (see the
    // sibling test above for why).
    await waitFor(() => expect(screen.getByText(/resolved · Show all/)).toBeTruthy())
    await userEvent.click(screen.getByText(/resolved · Show all/))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy())
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByText('Use this setup'))

    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    expect(localClient.confirmAlias).not.toHaveBeenCalled()
  })

  it('a confirmAlias rejection is best-effort — the commit still succeeds', async () => {
    localClient.ingestReconcile.mockResolvedValue(ambiguousIdentityHeld())
    localClient.ingestCommit.mockResolvedValue({ held: false, total: 1 })
    localClient.confirmAlias.mockRejectedValueOnce(new Error('confirmAlias: target_locked'))
    const onCommitted = vi.fn()
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={onCommitted} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    await userEvent.click(screen.getByText('Use "Chipmunks"'))
    await waitFor(() => expect(screen.getByText(/1 of 1 done/)).toBeTruthy())
    await userEvent.click(screen.getByText('Use this setup'))

    await waitFor(() => expect(onCommitted).toHaveBeenCalled())
  })
})

describe('done state', () => {
  it('a genuinely empty report (nothing understood, nothing to decide, nothing left out) shows the end state without requiring an apply click', async () => {
    localClient.ingestReconcile.mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} })
    localClient.list.mockResolvedValue([])
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    // readinessGreen depends on getReadiness(collections) — localClient.list
    // returns [] for everything, so every required area is NOT ready and the
    // end state must NOT show. Post-F3, those gaps render as required_gap
    // hold-lane cards, so the spine denominator is no longer 0 — the "0 of 0"
    // contradiction this finding fixes.
    await waitFor(() => expect(screen.getByText(/0 of 5 done/)).toBeTruthy())
    expect(screen.queryByText('Nothing left to reconcile.')).toBeNull()
  })
})

// R7 — the consolidated review_legacy_priority batch decision carries count/
// reason/activities but the card rendered none of it (bare "Acknowledge",
// generic "this record" question). Rendering-only fix; acknowledge-only
// resolution and applyResolutions' `continue` (never a write) stay as-is.
function legacyPriorityResult() {
  return {
    planItems: [],
    fixedEventsReport: {},
    legacyPriorityActivities: [
      { entity_id: 'a1', name: 'Swim' },
      { entity_id: 'a2', name: 'Archery' },
    ],
    fieldProvenance: {},
    evidenceSupport: {},
  }
}

describe('review_legacy_priority — batch decision rendering (R7)', () => {
  it('renders the count in the question, the reason, and the activity names, and acknowledges without writing a priority field', async () => {
    localClient.ingestReconcile.mockResolvedValue(legacyPriorityResult())
    localClient.ingestCommit.mockResolvedValue({ total: 1 })
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())

    expect(screen.getByText(/Review priority for 2 activities carried over from an earlier import/)).toBeTruthy()
    expect(screen.queryByText(/Review activity priority for "this record"/)).toBeNull()
    // Scoped to the panel — see the evidence-disclosure test above for why.
    const panel = within(screen.getByLabelText('Needs your attention'))
    expect(panel.getByText(/Shoresh cannot tell whether each value is a leftover/)).toBeTruthy()

    await userEvent.click(screen.getByText('Show the 2 activities'))
    expect(screen.getByText('Swim')).toBeTruthy()
    expect(screen.getByText('Archery')).toBeTruthy()

    await userEvent.click(screen.getByText('Acknowledge'))
    await waitFor(() => expect(screen.getByText(/1 of 1 done/)).toBeTruthy())

    await userEvent.click(screen.getByText('Use this setup'))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const inputs = localClient.ingestCommit.mock.calls[0][0]
    expect(JSON.stringify(inputs)).not.toMatch(/priority/)
  })
})

describe('F3 — required readiness gap card', () => {
  it('renders a required_gap hold-lane card, sorted first, when a required readiness area is missing', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation((table) => Promise.resolve(table === 'tiers' ? [] : [{ id: 'x' }]))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())
    expect(screen.getByText('READY TO BUILD?')).toBeTruthy()
    expect(screen.getByText(/Age Divisions aren't set up yet/)).toBeTruthy()
    expect(screen.getByText('Set up Age Divisions')).toBeTruthy()
  })

  it('"Skip for now" dismisses the card locally without staging an answer or touching the commit payload', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.ingestCommit.mockResolvedValue({ total: 1 })
    localClient.list.mockImplementation((table) => Promise.resolve(table === 'tiers' ? [] : [{ id: 'x' }]))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())

    await userEvent.click(screen.getByText(/Skip Age Divisions for now/))

    await waitFor(() => expect(screen.getByText(/1 of 1 done/)).toBeTruthy())
    // H1 (docs/work/specs/2026-08-19-roots-reconciliation-audit.md §12
    // Slice 1) — dismissing the gap resolves it (isDecisionResolvedFor),
    // which moves it behind the default view's "N resolved · Show all"
    // reveal; reveal it to see its "Skipped —" confirmation.
    await userEvent.click(screen.getByText(/resolved · Show all/))
    expect(screen.getByText(/Skipped — Age Divisions still isn't set up\./)).toBeTruthy()

    await userEvent.click(screen.getByText('Use this setup'))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const inputs = localClient.ingestCommit.mock.calls[0][0]
    expect(JSON.stringify(inputs)).not.toMatch(/readiness:|required_gap/)
  })

  it('clicking "Set up Age Divisions" navigates to the readiness row\'s screen', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation((table) => Promise.resolve(table === 'tiers' ? [] : [{ id: 'x' }]))
    const onNavigate = vi.fn()
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.getByText('Set up Age Divisions')).toBeTruthy())

    await userEvent.click(screen.getByText('Set up Age Divisions'))
    expect(onNavigate).toHaveBeenCalledWith('tiers')
  })
})

// §22 compression — Tester's finding: 5+ stacked required_gap cards read as
// a "setup gauntlet." 2+ required_gap decisions now fold into ONE summary
// card; the fold is rendering-only — each gap stays individually
// dismissible and doneCount still counts them individually.
describe('required-gap summary card (§22 compression)', () => {
  function missingAreas(...tables) {
    return (table) => Promise.resolve(tables.includes(table) ? [] : [{ id: 'x' }])
  }

  it('renders ONE summary card listing all required areas when 2+ are missing, not one card per area', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation(missingAreas('tiers', 'groups', 'days_of_operation'))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/0 of 3 done/)).toBeTruthy())
    expect(screen.getAllByText('READY TO BUILD?')).toHaveLength(1)
    expect(screen.getByText(/Age Divisions, Groups, Days/)).toBeTruthy()
    expect(screen.getByText('Set up Age Divisions')).toBeTruthy()
    expect(screen.getByText('Set up Groups')).toBeTruthy()
    expect(screen.getByText('Set up Days')).toBeTruthy()
  })

  it('keeps the single-card treatment when exactly 1 required area is missing', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation(missingAreas('tiers'))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())
    expect(screen.getAllByText('READY TO BUILD?')).toHaveLength(1)
    expect(screen.getByText(/Age Divisions aren't set up yet/)).toBeTruthy()
  })

  it('dismissing one item inside the summary card updates dismissedGaps and the spine doneCount, leaving the others open', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation(missingAreas('tiers', 'groups'))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/0 of 2 done/)).toBeTruthy())

    await userEvent.click(screen.getByText(/Skip Age Divisions for now/))

    await waitFor(() => expect(screen.getByText(/1 of 2 done/)).toBeTruthy())
    expect(screen.getByText('Set up Groups')).toBeTruthy()
  })

  it('clicking "Set up Groups" inside the summary card navigates to that row\'s screen', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation(missingAreas('tiers', 'groups'))
    const onNavigate = vi.fn()
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.getByText('Set up Groups')).toBeTruthy())

    await userEvent.click(screen.getByText('Set up Groups'))
    expect(onNavigate).toHaveBeenCalledWith('groups')
  })
})

// Slice 4 — persistent inspect mode, docs/adr/2026-08-19-roots-census-and-
// persistent-inspector.md §(e)/(f). Reachable outside the import flow (a
// director opens Roots months later); must never touch ingestReconcile or
// ingestCommit — this is the safety-critical read-only property.
describe('inspect mode (persistent inspector, mode="inspect")', () => {
  it('never calls ingestReconcile or ingestCommit — reads the live snapshot only', async () => {
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)
    await waitFor(() => expect(localClient.list).toHaveBeenCalled())

    expect(localClient.ingestReconcile).not.toHaveBeenCalled()
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
  })

  it('renders the root map without the import header, tray, apply buttons, or end state', async () => {
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)
    await waitFor(() => expect(localClient.list).toHaveBeenCalled())

    expect(screen.queryByText(/Reconciling/)).toBeNull()
    expect(screen.queryByText('Use this setup')).toBeNull()
    expect(screen.queryByText(/Apply confirmed changes/)).toBeNull()
    // The import-only "genuinely empty" short-circuit (§10) must never fire
    // in inspect mode — there is no import to "settle" into (ADR §(e)).
    expect(screen.queryByText('Nothing left to reconcile.')).toBeNull()
  })

  // A populated census (several groups, several activities) is the realistic
  // case a director actually opens Roots for — the 6 prior tests all used
  // empty/rejected list() mocks, so none of them exercised a roster with real
  // rows through this path. The safety property (no write/dry-run) must hold
  // WITH data, not just on an empty camp.
  it('a populated camp renders a real roster on node selection, and the safety property still holds', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'groups') {
        return Promise.resolve([
          { id: 'g1', name: 'Bogrim', tier_id: null },
          { id: 'g2', name: 'Amitim', tier_id: null },
        ])
      }
      if (entity === 'activities') {
        return Promise.resolve([
          { id: 'a1', name: 'Swim' },
          { id: 'a2', name: 'Archery' },
          { id: 'a3', name: 'Ceramics' },
        ])
      }
      return Promise.resolve([])
    })
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    const groupsNode = await screen.findByLabelText(/^Groups — /)
    await userEvent.click(groupsNode)
    expect(screen.getByText('Bogrim')).toBeTruthy()
    expect(screen.getByText('Amitim')).toBeTruthy()

    expect(localClient.ingestReconcile).not.toHaveBeenCalled()
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
  })

  it('a fresh, empty camp marks a required area not_set_up, never a false "Understood" (ADR §(d))', async () => {
    localClient.list.mockResolvedValue([])
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    const groupsNode = await screen.findByLabelText('Groups — Not started')
    expect(groupsNode.getAttribute('aria-label')).not.toMatch(/Understood/)
  })

  it('a per-entity read failure never throws, and surfaces the inline "couldn\'t read part of your setup" notice', async () => {
    localClient.list.mockRejectedValue(new Error('disk full'))
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    await screen.findByText(/Couldn.t read part of your setup/)
  })

  it('renders the dashboard banner with the SAME verdict describeReadiness(getReadiness(...)) would produce', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([{ id: 'x' }])
    })
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    const expectedReadiness = getReadiness({
      cohorts: [{ id: 'x' }],
      tiers: [{ id: 'x' }],
      groups: [],
      days: [{ id: 'x' }],
      timeBlocks: [{ id: 'x' }],
      activities: [{ id: 'x' }],
      anchors: [{ id: 'x' }],
      dayOverrides: [{ id: 'x' }],
      locations: [{ id: 'x' }],
    })
    const { blocking } = describeReadiness(expectedReadiness)

    await screen.findByText(blocking)
    expect(screen.getByText('Import last year')).toBeTruthy()
    expect(screen.getByText('Download worksheet')).toBeTruthy()
    expect(screen.getByText('Facility map')).toBeTruthy()
  })

  it('the banner does not render when a census read fails (never a false "ready" verdict)', async () => {
    localClient.list.mockRejectedValue(new Error('disk full'))
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    await screen.findByText(/Couldn.t read part of your setup/)
    expect(screen.queryByText('Import last year')).toBeNull()
  })

  it('the Download worksheet control calls the shared downloadWorkbook builder', async () => {
    localClient.list.mockResolvedValue([{ id: 'x' }])
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    await screen.findByText('Download worksheet')
    await userEvent.click(screen.getByText('Download worksheet'))
    await waitFor(() => expect(downloadWorkbook).toHaveBeenCalled())
  })

  // Governor review, round 2: the worksheet's cohort_id must come from the
  // canonical useCohorts(campId) source (the same one ReadinessHub/
  // AnchorsScreen/TiersScreen use), not an ad-hoc read off the census
  // snapshot — that would be a second, divergent source of cohort truth.
  it('the worksheet uses the useCohorts(campId)-derived cohort_id, not a census-snapshot guess', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'cohorts') {
        return Promise.resolve([
          { id: 'cohort-b', camp_id: 'camp-1', sort_order: 1, name: 'B' },
          { id: 'cohort-a', camp_id: 'camp-1', sort_order: 0, name: 'A' },
        ])
      }
      return Promise.resolve([{ id: 'x' }])
    })
    render(<ReconciliationScreen mode="inspect" campId="camp-1" onNavigate={vi.fn()} />)

    await screen.findByText('Download worksheet')
    await userEvent.click(screen.getByText('Download worksheet'))
    await waitFor(() => expect(downloadWorkbook).toHaveBeenCalled())

    const call = downloadWorkbook.mock.calls[0][0]
    // useCohorts picks the lowest sort_order first — cohort-a (sort_order 0)
    // — not the census snapshot's array order, which would have picked
    // cohort-b (the first row returned by the mock above).
    expect(call.cohort_id).toBe('cohort-a')
  })

  it('a rapid double-click on Download worksheet only calls downloadWorkbook once', async () => {
    // A deferred getCamp lets both clicks land while the first call is still
    // in flight — the real race the `preparingWorksheet` guard exists for.
    let resolveGetCamp
    localClient.getCamp.mockImplementation(() => new Promise((resolve) => { resolveGetCamp = resolve }))
    localClient.list.mockResolvedValue([{ id: 'x' }])
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    await screen.findByText('Download worksheet')
    const btn = screen.getByText('Download worksheet')
    fireEvent.click(btn)
    fireEvent.click(btn)
    resolveGetCamp({ id: 'camp-1' })

    await waitFor(() => expect(downloadWorkbook).toHaveBeenCalled())
    expect(downloadWorkbook).toHaveBeenCalledTimes(1)
  })

  // Task 4 (Roots-as-dashboard plan) — a finished import routes here carrying
  // its outcome as `justImported`. The post-import banner and the surviving
  // grace-window undo live on Roots now, not on ImportScreen.
  it('with a justImported outcome, shows the post-import summary, a Go to Schedule control, and a reachable grace-window undo', async () => {
    localClient.list.mockResolvedValue([{ id: 'x' }])
    const onNavigate = vi.fn()
    render(
      <ReconciliationScreen
        mode="inspect"
        onNavigate={onNavigate}
        justImported={{
          total: 5,
          fixedEvents: { created: 0, skipped: [], partial: [], moved: [] },
          invertibleOps: [{ op: '__deleted__' }],
          createdEntityIds: ['id-1'],
        }}
      />
    )

    await screen.findByText(textNode(/Imported 5 records/))

    await userEvent.click(screen.getByText('Go to Schedule'))
    expect(onNavigate).toHaveBeenCalledWith('schedule')

    await userEvent.click(screen.getByText('Undo this import'))
    await waitFor(() => expect(localClient.ingestUndo).toHaveBeenCalled())
  })

  it('disables Go to Schedule while an undo is in flight, so the director cannot leave mid-undo (write-failure surfacing)', async () => {
    localClient.list.mockResolvedValue([{ id: 'x' }])
    let resolveUndo
    localClient.ingestUndo.mockReturnValue(new Promise((resolve) => { resolveUndo = resolve }))
    render(
      <ReconciliationScreen
        mode="inspect"
        onNavigate={vi.fn()}
        justImported={{
          total: 5,
          fixedEvents: { created: 0, skipped: [], partial: [], moved: [] },
          invertibleOps: [{ op: '__deleted__' }],
          createdEntityIds: ['id-1'],
        }}
      />
    )

    await screen.findByText(textNode(/Imported 5 records/))
    const goToSchedule = screen.getByText('Go to Schedule')
    expect(goToSchedule.disabled).toBe(false)

    await userEvent.click(screen.getByText('Undo this import'))
    await waitFor(() => expect(goToSchedule.disabled).toBe(true))

    resolveUndo({ deleted: [], skipped: [], kept: [] })
  })

  // Owner decision: ONE focused banner post-import. The dashboard RootsBanner
  // is suppressed while justImported is live, and the readiness verdict is
  // folded INTO the PostImportBanner as a secondary line — so there is no
  // second banner to disagree with. This asserts the folded-in verdict agrees
  // with the just-imported complete camp AND the standalone RootsBanner is not
  // rendered.
  it('folds the readiness verdict into the post-import banner and suppresses the standalone RootsBanner', async () => {
    // A complete camp: every required area present after the import.
    localClient.list.mockResolvedValue([{ id: 'x' }])
    render(
      <ReconciliationScreen
        mode="inspect"
        onNavigate={vi.fn()}
        justImported={{
          total: 7,
          fixedEvents: { created: 0, skipped: [], partial: [], moved: [] },
          invertibleOps: [],
        }}
      />
    )

    await screen.findByText(textNode(/Imported 7 records/))

    const expectedReadiness = getReadiness({
      cohorts: [{ id: 'x' }], tiers: [{ id: 'x' }], groups: [{ id: 'x' }],
      days: [{ id: 'x' }], timeBlocks: [{ id: 'x' }], activities: [{ id: 'x' }],
      anchors: [{ id: 'x' }], dayOverrides: [{ id: 'x' }], locations: [{ id: 'x' }],
    })
    const { blocking } = describeReadiness(expectedReadiness)
    // The folded-in verdict line reads the "ready" sentence, agreeing with the
    // just-imported camp — no "not set up" under "Imported N".
    expect(blocking).toMatch(/Ready to build a week/)
    await screen.findByText(blocking)
    expect(screen.queryByText(/not set up/i)).toBeNull()

    // The standalone dashboard RootsBanner (its three entry-point buttons) is
    // suppressed while the import continuation is live — one focused banner.
    expect(screen.queryByText('Import last year')).toBeNull()
    expect(screen.queryByText('Download worksheet')).toBeNull()
    expect(screen.queryByText('Facility map')).toBeNull()
  })

  // Degrade path: a failed census read must not show a false "ready" verdict
  // line — matching how RootsBanner declines to render on the same failure.
  it('omits the folded-in verdict line when the census read failed (never a false "ready")', async () => {
    localClient.list.mockRejectedValue(new Error('disk full'))
    render(
      <ReconciliationScreen
        mode="inspect"
        onNavigate={vi.fn()}
        justImported={{
          total: 3,
          fixedEvents: { created: 0, skipped: [], partial: [], moved: [] },
          invertibleOps: [],
        }}
      />
    )

    await screen.findByText(textNode(/Imported 3 records/))
    // The post-import banner still shows, but with no readiness verdict line.
    expect(screen.queryByText('Ready to build a week.')).toBeNull()
    expect(screen.queryByText(/Couldn.t read part of your setup/)).toBeTruthy()
  })

  it('without justImported, shows the normal readiness banner and no post-import summary (Task 2 unbroken)', async () => {
    localClient.list.mockResolvedValue([{ id: 'x' }])
    render(<ReconciliationScreen mode="inspect" onNavigate={vi.fn()} />)

    await screen.findByText('Import last year')
    expect(screen.queryByText(/Imported .* records/)).toBeNull()
    expect(screen.queryByText('Go to Schedule')).toBeNull()
    expect(screen.queryByText('Undo this import')).toBeNull()
  })

  it('the post-import banner surfaces migrated fixed-event caveats (skipped and moved)', async () => {
    localClient.list.mockResolvedValue([{ id: 'x' }])
    render(
      <ReconciliationScreen
        mode="inspect"
        onNavigate={vi.fn()}
        justImported={{
          total: 2,
          fixedEvents: {
            created: 0,
            skipped: [{ name: 'Flag' }],
            partial: [],
            moved: [{ name: 'Lunch', reason: 'time changed' }],
          },
          invertibleOps: [],
        }}
      />
    )

    await screen.findByText(textNode(/1 fixed event couldn.t\s+be created/))
    expect(screen.getByText(textNode(/moved since this file was last imported/))).toBeTruthy()
  })

  it('defaults to import mode when no mode prop is given (ImportScreen call site unchanged)', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await waitFor(() => expect(localClient.ingestReconcile).toHaveBeenCalled())
  })
})
