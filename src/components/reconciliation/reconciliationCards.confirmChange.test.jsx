// @vitest-environment jsdom
//
// T96 — the confirm_change card names BOTH sides of the choice.
//
// This card appears at one specific moment: a re-import wants to overwrite a
// value the director typed themselves. It offers "use the file's value" vs
// "keep the current value" — and it used to print only the file's value, so
// the director weighed a number they could see against one they could not.
//
// Deliberately NOT the field-level ledger T96 originally described. The
// decision a re-import presents is already narrowed by the machinery: an
// import-owned field read at HIGH confidence is applied silently (the new
// file wins), and only a hand-edited field forces a choice at all. The single
// thing missing at that moment was what the director would be giving up.
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DecisionCard } from './reconciliationCards.jsx'

function changeDecision(over = {}) {
  return {
    id: 'activities:a1:update',
    kind: 'confirm_change',
    entity: 'activities',
    entityId: 'a1',
    entityName: 'Sail',
    field: ['location'],
    confidence: 'changed',
    proposedValue: 'Field',
    currentValue: 'Dock',
    unknowns: [],
    evidence: null,
    reason: null,
    ...over,
  }
}

const renderCard = (decision) =>
  render(<DecisionCard decision={decision} answer={undefined} onAnswer={() => {}} />)

describe('confirm_change card — both sides of the choice are named (T96)', () => {
  it('shows the value being kept, not just the value from the file', () => {
    renderCard(changeDecision())
    // Matched against the container text: the label is assembled from a
    // template literal, so RTL's per-element matcher can see it split.
    const body = document.body.textContent
    expect(body).toMatch(/Keep the current value — "Dock"/)
    expect(body).toMatch(/Use the file's value — "Field"/)
  })

  it('falls back to the bare label when there is no current value to name', () => {
    // null means the field was never written. Printing `""` there would read
    // as "the current value is an empty string", which is a different and
    // wrong claim.
    renderCard(changeDecision({ currentValue: null }))
    expect(screen.getByText('Keep the current value')).toBeTruthy()
  })

  it('still renders when currentValue is absent entirely — an older decision shape', () => {
    const { currentValue, ...withoutCurrent } = changeDecision()
    expect(currentValue).toBe('Dock')
    renderCard(withoutCurrent)
    expect(screen.getByText('Keep the current value')).toBeTruthy()
  })

  it('quotes a string value ONCE — it used to render as ""Field"" (pre-existing)', () => {
    // The template wrapped in quotes and JSON.stringify added its own. Fixed on
    // BOTH options, since the file's-value line had the same defect before T96
    // ever added a line beside it.
    renderCard(changeDecision())
    const body = document.body.textContent
    expect(body).not.toMatch(/""/)
  })

  it('names several hand-edited fields when they ride one row', () => {
    renderCard(changeDecision({
      field: ['location', 'min_per_week'],
      proposedValue: { location: 'Field', min_per_week: 4 },
      currentValue: { location: 'Dock', min_per_week: 2 },
    }))
    const body = document.body.textContent
    expect(body).toMatch(/Keep the current value —/)
    expect(body).toMatch(/"Dock"/)
  })
})
