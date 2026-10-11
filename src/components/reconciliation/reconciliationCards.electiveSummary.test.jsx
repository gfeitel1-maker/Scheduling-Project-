// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DecisionCard } from './reconciliationCards.jsx'

const decision = {
  id: 'elective_candidate:Chugim',
  kind: 'elective_candidate',
  entity: 'elective_sets',
  entityId: null,
  entityName: 'Chugim',
  field: null,
  confidence: 'inferred',
  proposedValue: null,
  unknowns: [],
  evidence: {},
  reason: 'Read as electives',
}

describe('elective_candidate answered summary', () => {
  it('does not claim the set is empty (it may carry proposed choices)', () => {
    render(<DecisionCard decision={decision} answer={{ choice: 'confirm' }} onAnswer={() => {}} />)
    const summary = screen.getByText(/^✓/)
    expect(summary.textContent).not.toMatch(/empty/i)
    expect(summary.textContent).toMatch(/Electives/)
  })
})

describe('elective_candidate question', () => {
  it('says unanswered stays an elective and does not promise an empty set', () => {
    render(<DecisionCard decision={decision} answer={undefined} onAnswer={() => {}} />)
    expect(screen.queryByText(/empty/i)).toBeNull()
    expect(screen.getByText(/stays an elective unless/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep as electives' })).toBeTruthy()
  })
})
