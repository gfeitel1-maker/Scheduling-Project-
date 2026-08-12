// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CellInlineEditor from './CellInlineEditor'

const eligible = [
  { id: 'act-1', name: 'Swimming', priority: 'normal' },
  { id: 'act-2', name: 'Arts & Crafts', priority: 'normal' },
]

describe('CellInlineEditor', () => {
  it('typing filters the suggestion list to matching eligible activities', () => {
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={vi.fn()} onCreateNew={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'swi' } })
    expect(screen.getByText('Swimming')).toBeTruthy()
    expect(screen.queryByText('Arts & Crafts')).toBeNull()
  })

  it('Enter places the top match', () => {
    const onPlace = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={onPlace} onCreateNew={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'swi' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onPlace).toHaveBeenCalledWith('act-1')
  })

  it('no match offers "Create <name>" and Enter confirms it', () => {
    const onCreateNew = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={vi.fn()} onCreateNew={onCreateNew} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Kayaking' } })
    expect(screen.getByText(/Create.*Kayaking/)).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onCreateNew).toHaveBeenCalledWith('Kayaking')
  })

  it('a name that collapses to an existing name (case/space-insensitive) is treated as a match, not create-new', () => {
    const onPlace = vi.fn()
    const onCreateNew = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={onPlace} onCreateNew={onCreateNew} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  swimming  ' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onPlace).toHaveBeenCalledWith('act-1')
    expect(onCreateNew).not.toHaveBeenCalled()
  })

  it('Escape cancels without placing or creating', () => {
    const onCancel = vi.fn()
    const onPlace = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={onPlace} onCreateNew={vi.fn()} onCancel={onCancel} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'swi' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
    expect(onPlace).not.toHaveBeenCalled()
  })

  it('blur with nothing typed cancels (empty no-op)', () => {
    const onCancel = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={vi.fn()} onCreateNew={vi.fn()} onCancel={onCancel} />)
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onCancel).toHaveBeenCalled()
  })
})
