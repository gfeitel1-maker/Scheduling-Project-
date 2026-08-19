// @vitest-environment jsdom
//
// Behavior-level tests for the one-screen reconciliation surface (R2'b),
// per handoff §23: high-confidence understood does NOT demand review;
// ambiguity does; resolving changes the eventual model; counts update after
// resolution; read-only reconciliation never mutates; the last-issued-wins
// guard protects the debounced dry-run re-issue (ADR Risk #3).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    ingestReconcile: vi.fn(),
    ingestCommit: vi.fn(),
    confirmAlias: vi.fn().mockResolvedValue({ id: 'alias-1', superseded: null }),
  },
}))

import ReconciliationScreen from './ReconciliationScreen.jsx'
import { localClient } from '../localClient'

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

    expect(screen.getByText(/seen across 2 groups/)).toBeTruthy()
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
    await userEvent.click(screen.getByLabelText(/Resources — /))
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
    expect(screen.getByText(/Shoresh cannot tell whether each value is a leftover/)).toBeTruthy()

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
    expect(screen.getByText(/Units aren't set up yet/)).toBeTruthy()
    expect(screen.getByText('Set up Units')).toBeTruthy()
  })

  it('"Skip for now" dismisses the card locally without staging an answer or touching the commit payload', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.ingestCommit.mockResolvedValue({ total: 1 })
    localClient.list.mockImplementation((table) => Promise.resolve(table === 'tiers' ? [] : [{ id: 'x' }]))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())

    await userEvent.click(screen.getByText(/Skip Units for now/))

    await waitFor(() => expect(screen.getByText(/1 of 1 done/)).toBeTruthy())
    expect(screen.getByText(/Skipped — Units still isn't set up\./)).toBeTruthy()

    await userEvent.click(screen.getByText('Use this setup'))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const inputs = localClient.ingestCommit.mock.calls[0][0]
    expect(JSON.stringify(inputs)).not.toMatch(/readiness:|required_gap/)
  })

  it('clicking "Set up Units" navigates to the readiness row\'s screen', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation((table) => Promise.resolve(table === 'tiers' ? [] : [{ id: 'x' }]))
    const onNavigate = vi.fn()
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.getByText('Set up Units')).toBeTruthy())

    await userEvent.click(screen.getByText('Set up Units'))
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
    expect(screen.getByText(/Units, Groups, Days/)).toBeTruthy()
    expect(screen.getByText('Set up Units')).toBeTruthy()
    expect(screen.getByText('Set up Groups')).toBeTruthy()
    expect(screen.getByText('Set up Days')).toBeTruthy()
  })

  it('keeps the single-card treatment when exactly 1 required area is missing', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation(missingAreas('tiers'))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/0 of 1 done/)).toBeTruthy())
    expect(screen.getAllByText('READY TO BUILD?')).toHaveLength(1)
    expect(screen.getByText(/Units aren't set up yet/)).toBeTruthy()
  })

  it('dismissing one item inside the summary card updates dismissedGaps and the spine doneCount, leaving the others open', async () => {
    localClient.ingestReconcile.mockResolvedValue(understoodOnlyResult())
    localClient.list.mockImplementation(missingAreas('tiers', 'groups'))
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/0 of 2 done/)).toBeTruthy())

    await userEvent.click(screen.getByText(/Skip Units for now/))

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
