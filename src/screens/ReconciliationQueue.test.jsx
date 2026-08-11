// @vitest-environment jsdom
//
// D2 — decision cards + one-at-a-time resolution flow. Generalizes
// HeldResolution's existing queue UX (ImportScreen.jsx:1233) to Phase C's
// confirm_value/confirm_change/review_legacy_priority decision kinds.
// Test-first: written before ReconciliationQueue.jsx exists.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReconciliationQueue } from './ReconciliationQueue.jsx'

const confirmValue = {
  id: 'activities:act-1', kind: 'confirm_value', entity: 'activities', entityId: 'act-1',
  entityName: 'Archery', field: ['max_per_week'], confidence: 'medium', proposedValue: 5,
  unknowns: [], evidence: null, reason: 'Only appeared once in the file',
}

const confirmChange = {
  id: 'activities:act-2', kind: 'confirm_change', entity: 'activities', entityId: 'act-2',
  entityName: 'Swim', field: ['max_per_week'], confidence: 'changed', proposedValue: 7,
  unknowns: [], evidence: null, reason: 'A director set this by hand',
}

const legacyPriority = {
  id: 'activities:legacy_priority', kind: 'review_legacy_priority', entity: 'activities', entityId: null,
  entityName: null, field: 'priority', confidence: 'low', proposedValue: null, count: 2,
  activities: [{ entityId: 'act-3', name: 'Canoe' }, { entityId: 'act-4', name: 'Kayak' }],
  unknowns: [], evidence: null, reason: 'These carry a legacy priority from before Shoresh stopped inferring it.',
}

function noop() {}

describe('ReconciliationQueue — (a) card shape per decision kind', () => {
  it('renders a confirm_value card with Looks right / Edit', () => {
    render(<ReconciliationQueue decisions={[confirmValue]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getAllByText('Archery').length).toBeGreaterThan(0)
    expect(screen.getByText(/Only appeared once in the file/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Looks right/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy()
  })

  it('renders a confirm_change card with the firmer Overwrite/Keep buttons', () => {
    render(<ReconciliationQueue decisions={[confirmChange]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getAllByText('Swim').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Overwrite with new value/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Keep my value/ })).toBeTruthy()
  })

  it('renders a batched review_legacy_priority card, expandable, with its activity count', () => {
    render(<ReconciliationQueue decisions={[legacyPriority]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText(/2 activities/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Review each/ })).toBeTruthy()
  })

  it('the why-disclosure is an honest shell when evidence is null', () => {
    render(<ReconciliationQueue decisions={[confirmValue]} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getByText(/Why does Shoresh think this\?/)).toBeTruthy()
  })
})

describe('ReconciliationQueue — resolving cards', () => {
  it('Looks right answers the confirm_value card', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[confirmValue]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Looks right/ }))
    expect(onAnswer).toHaveBeenCalledWith('activities:act-1', { action: 'looks_right' })
  })

  it('Edit reveals an inline editor and Save answers with the edited value', async () => {
    const onAnswer = vi.fn()
    const onEditField = vi.fn()
    render(<ReconciliationQueue decisions={[confirmValue]} answers={{}} onAnswer={onAnswer} onEditField={onEditField} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Edit/ }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '6')
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))
    expect(onEditField).toHaveBeenCalledWith(confirmValue, '6')
    expect(onAnswer).toHaveBeenCalledWith('activities:act-1', { action: 'edited', value: '6' })
  })

  it('Overwrite answers the confirm_change card with choice:accept', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[confirmChange]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Overwrite with new value/ }))
    expect(onAnswer).toHaveBeenCalledWith('activities:act-2', { choice: 'accept' })
  })

  it('Keep my value answers the confirm_change card with choice:keep', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[confirmChange]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Keep my value/ }))
    expect(onAnswer).toHaveBeenCalledWith('activities:act-2', { choice: 'keep' })
  })

  it('review_legacy_priority resolves ALL-OR-NOTHING at the batch level — one answer call for the whole batch', async () => {
    const onAnswer = vi.fn()
    render(<ReconciliationQueue decisions={[legacyPriority]} answers={{}} onAnswer={onAnswer} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Review each/ }))
    // Sub-progress is local to the expanded card only.
    expect(screen.getByText(/0 of 2 reviewed/)).toBeTruthy()
    await userEvent.click(screen.getByText('Canoe'))
    expect(screen.getByText(/1 of 2 reviewed/)).toBeTruthy()
    await userEvent.click(screen.getByText('Kayak'))
    expect(screen.getByText(/2 of 2 reviewed/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Mark all reviewed/ }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith('activities:legacy_priority', { resolved: true })
  })
})

describe('ReconciliationQueue — (e) defer/return navigation', () => {
  const decisions = [confirmValue, confirmChange]

  it('defer (Next) moves to the next card without answering, and the deferred card is returnable via the rail', async () => {
    render(<ReconciliationQueue decisions={decisions} answers={{}} onAnswer={noop} onEditField={noop} onReturnToSummary={noop} onDone={noop} />)
    expect(screen.getAllByText('Archery').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getAllByText('Swim').length).toBeGreaterThan(0)
    // Return to the deferred (still-unanswered) first card via the rail.
    await userEvent.click(screen.getAllByText('Archery')[0])
    expect(screen.getByRole('button', { name: /Looks right/ })).toBeTruthy()
  })

  it('Return to summary preserves already-given answers', async () => {
    const onReturnToSummary = vi.fn()
    const answers = { [confirmValue.id]: { action: 'looks_right' } }
    render(<ReconciliationQueue decisions={decisions} answers={answers} onAnswer={noop} onEditField={noop} onReturnToSummary={onReturnToSummary} onDone={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /Return to summary/ }))
    expect(onReturnToSummary).toHaveBeenCalledTimes(1)
    // Answers themselves live in the parent (ImportScreen) — this component
    // just reads them back and renders the resolved state on re-entry.
    expect(screen.getByText(/1 of 2/)).toBeTruthy()
  })
})
