// @vitest-environment jsdom
//
// D2 — decision cards + one-at-a-time resolution flow. Generalizes
// HeldResolution's existing queue UX (ImportScreen.jsx:1233) to Phase C's
// confirm_value/confirm_change/review_legacy_priority decision kinds.
// Round 2: fixes the silent-write Edit bug (only offer Edit when the value
// can actually reach the commit — reconciliationResolutions.isEditableDecision),
// the fake fixed-event overwrite gate (isBackedConfirmChange), footer
// Back/Defer/Next per the mockup, and legacy-priority progress persisted in
// `answers` instead of local state that vanished on close/reopen.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReconciliationQueue } from './ReconciliationQueue.jsx'

const confirmValueEditable = {
  id: 'activities:act-1', kind: 'confirm_value', entity: 'activities', entityId: 'act-1',
  entityName: 'Archery', field: ['max_per_week'], confidence: 'medium', proposedValue: 5,
  unknowns: [], evidence: null, reason: 'Only appeared once in the file',
}

const confirmValueNotEditable = {
  id: 'activities:act-9', kind: 'confirm_value', entity: 'activities', entityId: 'act-9',
  entityName: 'Nature', field: ['max_per_week', 'min_per_week'], confidence: 'medium', proposedValue: { max_per_week: 5, min_per_week: 1 },
  unknowns: [], evidence: null, reason: 'Two fields changed at once',
}

const confirmChangeBacked = {
  id: 'activities:act-2', kind: 'confirm_change', entity: 'activities', entityId: 'act-2',
  entityName: 'Swim', field: ['max_per_week'], confidence: 'changed', proposedValue: 7,
  unknowns: [], evidence: null, reason: 'A director set this by hand',
}

const confirmChangeNotBacked = {
  id: 'anchor_activities:null:confirm_change:moved:Movie Night', kind: 'confirm_change', entity: 'anchor_activities',
  entityId: null, entityName: 'Movie Night', field: null, confidence: 'changed', proposedValue: null,
  unknowns: [], evidence: null, reason: 'This fixed event moved since the last import.',
}

const legacyPriority = {
  id: 'activities:legacy_priority', kind: 'review_legacy_priority', entity: 'activities', entityId: null,
  entityName: null, field: 'priority', confidence: 'low', proposedValue: null, count: 2,
  activities: [{ entityId: 'act-3', name: 'Canoe' }, { entityId: 'act-4', name: 'Kayak' }],
  unknowns: [], evidence: null, reason: 'These carry a legacy priority from before Shoresh stopped inferring it.',
}

function noop() {}

describe('ReconciliationQueue — (a) card shape per decision kind', () => {
  it('renders an editable confirm_value card with Looks right AND Edit', () => {
    render(<ReconciliationQueue decisions={[confirmValueEditable]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText('Archery')).toBeTruthy()
    expect(screen.getByText(/Only appeared once in the file/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Looks right/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy()
  })

  it('a NON-editable (multi-field) confirm_value card offers ONLY Looks right — no accept-and-discard Edit', () => {
    render(<ReconciliationQueue decisions={[confirmValueNotEditable]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByRole('button', { name: /Looks right/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull()
  })

  it('renders a BACKED confirm_change card with the firmer Overwrite/Keep buttons', () => {
    render(<ReconciliationQueue decisions={[confirmChangeBacked]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText('Swim')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Overwrite with new value/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Keep my value/ })).toBeTruthy()
  })

  it('a NOT-backed confirm_change (fixed-event drift, field:null) renders a read-only "Got it" ack — no overwrite gate, no "director set by hand" claim', () => {
    render(<ReconciliationQueue decisions={[confirmChangeNotBacked]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText('Movie Night')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Got it/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Overwrite with new value/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Keep my value/ })).toBeNull()
    expect(screen.queryByText(/director set this by hand/)).toBeNull()
  })

  it('renders a batched review_legacy_priority card with the mockup copy and its activity count', () => {
    render(<ReconciliationQueue decisions={[legacyPriority]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText(/2 activities carry a priority Shoresh never confirmed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Review each/ })).toBeTruthy()
  })

  it('the why-disclosure is an honest shell when evidence is null', async () => {
    render(<ReconciliationQueue decisions={[confirmValueEditable]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText(/Why does Shoresh think this\?/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Why does Shoresh think this\?/ }))
    expect(screen.getByText(/isn't populated yet/)).toBeTruthy()
  })

  // D3 — real support renders when evidence is present. Activity shape:
  // { matched_groups, appearances, eligible_group_count } from
  // src/ingest/activityRules.js.
  it('renders real per-group evidence for an activity decision when evidence is present', async () => {
    const withEvidence = {
      ...confirmValueEditable,
      evidence: { matched_groups: ['Yeladim', 'Bogrim'], appearances: 8, eligible_group_count: 2 },
    }
    render(<ReconciliationQueue decisions={[withEvidence]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Why does Shoresh think this\?/ }))
    expect(screen.getByText(/2 of 2 eligible groups matched/)).toBeTruthy()
    expect(screen.getByText(/8 appearances/)).toBeTruthy()
    expect(screen.getByText(/Yeladim, Bogrim/)).toBeTruthy()
    expect(screen.queryByText(/isn't populated yet/)).toBeNull()
  })

  // Fixed-event shape: { days, occupied_days, operating_days, groups_in_scope }
  // from src/ingest/fixedEvents.js, joined by name (never entity_id — see
  // reconciliationReport.js's addFixedEventDecision).
  it('renders real day/scope evidence for a fixed-event decision when evidence is present', async () => {
    const withEvidence = {
      ...confirmChangeNotBacked,
      evidence: { days: ['Monday', 'Wednesday'], occupied_days: 2, operating_days: 5, groups_in_scope: ['Yeladim'] },
    }
    render(<ReconciliationQueue decisions={[withEvidence]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Why does Shoresh think this\?/ }))
    expect(screen.getByText(/Monday, Wednesday/)).toBeTruthy()
    expect(screen.getByText(/Occupied 2 of 5 operating days/)).toBeTruthy()
    expect(screen.getByText(/Yeladim/)).toBeTruthy()
    expect(screen.queryByText(/isn't populated yet/)).toBeNull()
  })
})

describe('ReconciliationQueue — resolving cards', () => {
  it('Looks right answers the confirm_value card', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[confirmValueEditable]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Looks right/ }))
    expect(onAnswer).toHaveBeenCalledWith('activities:act-1', { action: 'looks_right' })
  })

  it('Edit reveals an inline editor and Save answers with the edited value', async () => {
    const onAnswer = vi.fn()
    const onEditField = vi.fn()
    render(<ReconciliationQueue decisions={[confirmValueEditable]} answers={{}} onAnswer={onAnswer} onEditField={onEditField} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Edit/ }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '6')
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))
    expect(onEditField).toHaveBeenCalledWith(confirmValueEditable, '6')
    expect(onAnswer).toHaveBeenCalledWith('activities:act-1', { action: 'edited', value: '6' })
  })

  it('Overwrite answers a backed confirm_change card with choice:accept', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[confirmChangeBacked]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Overwrite with new value/ }))
    expect(onAnswer).toHaveBeenCalledWith('activities:act-2', { choice: 'accept' })
  })

  it('Keep my value answers a backed confirm_change card with choice:keep', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[confirmChangeBacked]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Keep my value/ }))
    expect(onAnswer).toHaveBeenCalledWith('activities:act-2', { choice: 'keep' })
  })

  it('Got it answers a NOT-backed confirm_change with {ack:true}, never a choice', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[confirmChangeNotBacked]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Got it/ }))
    expect(onAnswer).toHaveBeenCalledWith(confirmChangeNotBacked.id, { ack: true })
  })

  it('review_legacy_priority resolves ALL-OR-NOTHING at the batch level via onAnswer, reviewedIds tracked per-click', async () => {
    const onAnswer = vi.fn()
    const { rerender } = render(<ReconciliationQueue decisions={[legacyPriority]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Review each/ }))
    expect(screen.getByText(/0 of 2 reviewed/)).toBeTruthy()

    await userEvent.click(screen.getByText('Canoe'))
    expect(onAnswer).toHaveBeenLastCalledWith(legacyPriority.id, { reviewedIds: ['act-3'], resolved: false })

    // Simulate the parent applying that answer (it owns queueAnswers).
    rerender(<ReconciliationQueue decisions={[legacyPriority]} answers={{ [legacyPriority.id]: { reviewedIds: ['act-3'], resolved: false } }} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText(/1 of 2 reviewed/)).toBeTruthy()

    await userEvent.click(screen.getByText('Kayak'))
    expect(onAnswer).toHaveBeenLastCalledWith(legacyPriority.id, { reviewedIds: ['act-3', 'act-4'], resolved: false })

    rerender(<ReconciliationQueue decisions={[legacyPriority]} answers={{ [legacyPriority.id]: { reviewedIds: ['act-3', 'act-4'], resolved: false } }} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Mark all reviewed/ }))
    expect(onAnswer).toHaveBeenLastCalledWith(legacyPriority.id, { reviewedIds: ['act-3', 'act-4'], resolved: true })
  })

  it('legacy-priority sub-review progress is read from `answers` (persists across a close/reopen — the parent owns it, not local state)', () => {
    render(<ReconciliationQueue decisions={[legacyPriority]} answers={{ [legacyPriority.id]: { reviewedIds: ['act-3'], resolved: false } }} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    // Card auto-expands and shows the persisted progress immediately, without a fresh "Review each" click.
    expect(screen.getByText(/1 of 2 reviewed/)).toBeTruthy()
  })
})

describe('ReconciliationQueue — (e) Back / Defer / Next navigation (mockup panel 5)', () => {
  const decisions = [confirmValueEditable, confirmChangeBacked]

  it('Next steps to the next UNRESOLVED card', async () => {
    render(<ReconciliationQueue decisions={decisions} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText('Archery')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByText('Swim')).toBeTruthy()
  })

  it('Next skips a resolved card and lands on the next unresolved one (not a plain modulo cycle)', async () => {
    const answers = { [confirmValueEditable.id]: { action: 'looks_right' } }
    const threeDecisions = [confirmValueEditable, confirmChangeBacked, legacyPriority]
    render(<ReconciliationQueue decisions={threeDecisions} answers={answers} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    // Starts on the first (resolved) card; Next must jump past it to the first unresolved.
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByText('Swim')).toBeTruthy()
  })

  it('Defer — decide later moves off the current card without answering it, and it stays returnable via the dots', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={decisions} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Defer — decide later/ }))
    expect(screen.getByText('Swim')).toBeTruthy()
    expect(onAnswer).not.toHaveBeenCalled()
    // Deferred card is returnable via its dot.
    await userEvent.click(screen.getByRole('button', { name: 'Archery' }))
    expect(screen.getByRole('button', { name: /Looks right/ })).toBeTruthy()
  })

  it('← Back steps to the previous card', async () => {
    render(<ReconciliationQueue decisions={decisions} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByText('Swim')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /← Back/ }))
    expect(screen.getByText('Archery')).toBeTruthy()
  })

  it('Return to summary preserves already-given answers', async () => {
    const onReturnToSummary = vi.fn()
    const answers = { [confirmValueEditable.id]: { action: 'looks_right' } }
    render(<ReconciliationQueue decisions={decisions} answers={answers} onAnswer={noop} onEditField={noop} onReturnToSummary={onReturnToSummary} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Return to summary/ }))
    expect(onReturnToSummary).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/1 of 2 resolved/)).toBeTruthy()
  })
})
