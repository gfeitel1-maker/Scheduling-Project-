// @vitest-environment jsdom
// Audit 714 review: the buttons answer the question the title asks.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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

  it('an unknown-field card offers no decline button (declining it would do nothing)', () => {
    render(<DecisionCard decision={{ ...base, entityId: 'a1', field: 'max_per_week', unknownField: true, unknowns: ['max_per_week'], title: 'Confirm Swim?' }} answer={undefined} onAnswer={vi.fn()} />)
    expect(screen.queryByText('Don’t add')).toBeNull()
    expect(screen.queryByText('Keep mine')).toBeNull()
  })

  const multi = { ...base, entityId: 'a1', field: ['min_per_week', 'max_per_week'], proposedValue: { min_per_week: 2, max_per_week: 4 }, currentValue: { min_per_week: 1, max_per_week: 3 }, title: 'Update Swim?' }

  it('per-field toggles render only for a multi-field update, with both values shown', () => {
    const { unmount } = render(<DecisionCard decision={multi} answer={undefined} onAnswer={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'min_per_week' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'max_per_week' })).toBeTruthy()
    expect(screen.getByText(/Yours: 3/)).toBeTruthy()
    expect(screen.getByText(/File: 4/)).toBeTruthy()
    unmount()
    render(<DecisionCard decision={{ ...base, entityId: 'a1', field: ['min_per_week'], proposedValue: 3 }} answer={undefined} onAnswer={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'min_per_week' })).toBeNull()
  })

  it('whole-card buttons still answer for every field', () => {
    const onAnswer = vi.fn()
    render(<DecisionCard decision={multi} answer={undefined} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByText('Use the file’s'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'looks_right' })
    fireEvent.click(screen.getByText('Keep mine'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'edited' })
  })

  it('a mixed choice answers with only the kept fields; all-kept collapses to Keep mine', () => {
    const onAnswer = vi.fn()
    render(<DecisionCard decision={multi} answer={undefined} onAnswer={onAnswer} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'max_per_week' })).getByText('Keep yours'))
    fireEvent.click(screen.getByText('Apply these choices'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'mixed', keep: ['max_per_week'] })
    fireEvent.click(within(screen.getByRole('group', { name: 'min_per_week' })).getByText('Keep yours'))
    fireEvent.click(screen.getByText('Apply these choices'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'edited' })
  })

  it('the resolved line says what was kept and what was taken', () => {
    render(<DecisionCard decision={multi} answer={{ action: 'mixed', keep: ['max_per_week'] }} onAnswer={vi.fn()} />)
    expect(screen.getByText(/Kept yours for max_per_week; took the file’s min_per_week/)).toBeTruthy()
  })
})
