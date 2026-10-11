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

describe('elective_candidate list cells', () => {
  const list = (detector, reason) => ({ ...decision, entityName: 'Arts/Crafts', evidence: { detector, choices: ['Arts', 'Crafts'] }, reason })

  it('the ambiguous question reads as the question and offers one activity or a choice of several', () => {
    render(<DecisionCard decision={list('list_question', "Is 'Arts/Crafts' one activity or a choice of several?")} answer={undefined} onAnswer={() => {}} />)
    expect(screen.getByText(/one activity or a choice of several\?/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'A choice of several' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'One activity' })).toBeTruthy()
  })

  it('a silent split shows what was read and offers One activity', () => {
    render(<DecisionCard decision={list('shape', 'Read as a choice of 2: Arts, Crafts.')} answer={undefined} onAnswer={() => {}} />)
    expect(screen.getByText(/Read as a choice of 2: Arts, Crafts\./)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'One activity' })).toBeTruthy()
  })
})
