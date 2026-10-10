// @vitest-environment jsdom
// Audit 714 review: the buttons answer the question the title asks.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DecisionCard } from './reconciliationCards.jsx'

const base = { id: 'd1', kind: 'confirm_value', entity: 'activities', entityId: null, entityName: 'Carpool', confidence: 'low', proposedValue: null, unknowns: [], evidence: null, reason: null }

describe('confirm_value card buttons', () => {
  it('a new record asks Add it / Don’t add, and they map to the same answers as before', () => {
    const onAnswer = vi.fn()
    render(<DecisionCard decision={{ ...base, field: null, title: 'Add Carpool as an activity?' }} answer={undefined} onAnswer={onAnswer} />)
    expect(screen.queryByText('Use this value')).toBeNull()
    expect(screen.queryByText('Keep current')).toBeNull()
    fireEvent.click(screen.getByText('Add it'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'looks_right' })
    fireEvent.click(screen.getByText('Don’t add'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'edited' })
  })

  it('a field change asks Use the file’s / Keep mine', () => {
    const onAnswer = vi.fn()
    render(<DecisionCard decision={{ ...base, entityId: 'a1', field: ['min_per_week'], proposedValue: 3, title: 'Set Swim’s fewest per week to 3?' }} answer={undefined} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByText('Use the file’s'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'looks_right' })
    fireEvent.click(screen.getByText('Keep mine'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'edited' })
  })
})
