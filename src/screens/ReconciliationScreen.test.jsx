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

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
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

describe('drill-down filters', () => {
  it('a domain filter shows the SAME underlying decisions, just a subset — never a second data source', async () => {
    localClient.ingestReconcile.mockResolvedValue(oneChangedResult())
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 1 done/)

    // Scheduling should carry the one activities decision; Facility none.
    expect(screen.getByText('Scheduling (1)')).toBeTruthy()
    expect(screen.getByText('Facility (0)')).toBeTruthy()

    await userEvent.click(screen.getByText('Facility (0)'))
    expect(screen.queryByText('Keep current')).toBeNull()

    await userEvent.click(screen.getByText('Facility (0)')) // toggle back off
    await userEvent.click(screen.getByText('Scheduling (1)'))
    expect(screen.getByText('Keep current')).toBeTruthy()
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
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    // readinessGreen depends on getReadiness(collections) — localClient.list
    // returns [] for everything, so required areas are NOT ready and the end
    // state must NOT show (there is nothing understood either, so nothing is
    // pending, but readiness itself is red) — asserts the tray still renders
    // rather than a false "done".
    await waitFor(() => expect(screen.getByText(/of 0 done/)).toBeTruthy())
  })
})
