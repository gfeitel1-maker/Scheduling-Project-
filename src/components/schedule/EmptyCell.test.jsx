// @vitest-environment jsdom
//
// T112. Empty-cell click opens the inline editor (point-of-intent gap). This
// file pins the shared EmptyCell component's own behavior: click/Enter opens
// CellInlineEditor, commit calls onPlace/onCreateNew/onCreateElective with the
// cell's identity, Escape cancels without committing, a second click while
// already editing does not flicker/close, and the three-way stamp > paste >
// edit precedence (design doc addendum decision 4) holds.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import EmptyCell from './EmptyCell'

const baseProps = {
  groupId: 'g1', dayId: 'd1', blockId: 'b1',
  gridRow: '1 / span 1', gridColumn: '2 / span 1', ariaColIndex: 2,
  blockNames: ['Block 1'], column: 'Mon',
  eligibleActivities: [{ id: 'a1', name: 'Soccer' }],
}

function renderCell(extra = {}) {
  const onPlace = vi.fn()
  const onCreateNew = vi.fn()
  const onCreateElective = vi.fn()
  const utils = render(
    <EmptyCell {...baseProps} onPlace={onPlace} onCreateNew={onCreateNew} onCreateElective={onCreateElective} {...extra} />
  )
  return { ...utils, onPlace, onCreateNew, onCreateElective }
}

describe('EmptyCell — click opens the inline editor (T112)', () => {
  it('renders as an empty gridcell with the T59 aria label, no editor mounted', () => {
    const { container } = renderCell()
    const cell = container.querySelector('[role="gridcell"]')
    expect(cell.hasAttribute('data-empty')).toBe(true)
    expect(cell.getAttribute('data-cell-key')).toBe('g1|d1|b1')
    expect(cell.getAttribute('aria-label')).toBe('Open, Block 1, Mon')
    expect(container.querySelector('.cell-inline-editor-input')).toBeNull()
  })

  it('click opens CellInlineEditor', () => {
    const { container } = renderCell()
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    expect(container.querySelector('.cell-inline-editor-input')).not.toBeNull()
  })

  it('typing an exact match and pressing Enter calls onPlace with the cell identity', () => {
    const { container, onPlace } = renderCell()
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    const input = container.querySelector('.cell-inline-editor-input')
    fireEvent.change(input, { target: { value: 'Soccer' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPlace).toHaveBeenCalledWith({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'a1')
    // The editor unmounts on commit.
    expect(container.querySelector('.cell-inline-editor-input')).toBeNull()
  })

  it('typing an unknown name and pressing Enter calls onCreateNew with the cell identity', () => {
    const { container, onCreateNew } = renderCell()
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    const input = container.querySelector('.cell-inline-editor-input')
    fireEvent.change(input, { target: { value: 'Brand New Activity' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreateNew).toHaveBeenCalledWith({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'Brand New Activity')
  })

  it('colon grammar calls onCreateElective with the cell identity', () => {
    const { container, onCreateElective } = renderCell()
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    const input = container.querySelector('.cell-inline-editor-input')
    fireEvent.change(input, { target: { value: 'Free Choice: Art, Music' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreateElective).toHaveBeenCalledWith({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'Free Choice', ['Art', 'Music'])
  })

  it('Escape cancels without calling any commit callback', () => {
    const { container, onPlace, onCreateNew, onCreateElective } = renderCell()
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    const input = container.querySelector('.cell-inline-editor-input')
    fireEvent.change(input, { target: { value: 'Soccer' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(container.querySelector('.cell-inline-editor-input')).toBeNull()
    expect(onPlace).not.toHaveBeenCalled()
    expect(onCreateNew).not.toHaveBeenCalled()
    expect(onCreateElective).not.toHaveBeenCalled()
  })

  it('Enter on a focused (not editing) empty cell opens the editor', () => {
    const { container } = renderCell()
    const cell = container.querySelector('[role="gridcell"]')
    fireEvent.keyDown(cell, { key: 'Enter' })
    expect(container.querySelector('.cell-inline-editor-input')).not.toBeNull()
  })

  it('double-click on an empty cell opens once and does not flicker/close (design addendum decision 7)', () => {
    // Physically, a double-click is two click events landing on whatever is
    // under the pointer at each moment: the first click hits the empty cell
    // and mounts the editor; the second lands on the now-rendered editor,
    // which stops propagation before it reaches the cell's own onClick.
    const { container } = renderCell()
    const cell = container.querySelector('[role="gridcell"]')
    fireEvent.click(cell)
    fireEvent.click(container.querySelector('.cell-inline-editor'))
    fireEvent.doubleClick(cell)
    expect(container.querySelectorAll('.cell-inline-editor-input').length).toBe(1)
  })

  it('a click on the open editor itself does not flicker/close it (CellInlineEditor stopPropagation)', () => {
    const { container } = renderCell()
    const cell = container.querySelector('[role="gridcell"]')
    fireEvent.click(cell)
    const editorRoot = container.querySelector('.cell-inline-editor')
    expect(editorRoot).not.toBeNull()
    fireEvent.click(editorRoot)
    // Still open, still exactly one editor instance mounted.
    expect(container.querySelectorAll('.cell-inline-editor-input').length).toBe(1)
  })
})

describe('EmptyCell — three-way precedence: stamp > paste > edit (T112 design addendum decision 4)', () => {
  it('stamp mode active: click stamps and does not open the editor', () => {
    const onCellClick = vi.fn()
    const onCellSelect = vi.fn()
    const { container } = renderCell({ onCellClick, pasteMode: true, onCellSelect })
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    expect(onCellClick).toHaveBeenCalledWith({ groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    expect(onCellSelect).not.toHaveBeenCalled()
    expect(container.querySelector('.cell-inline-editor-input')).toBeNull()
  })

  it('paste mode active (no stamp): click pastes via onCellSelect and does not open the editor', () => {
    const onCellSelect = vi.fn()
    const { container } = renderCell({ pasteMode: true, onCellSelect })
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    expect(onCellSelect).toHaveBeenCalledTimes(1)
    expect(onCellSelect.mock.calls[0][0]).toEqual({ groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    expect(container.querySelector('.cell-inline-editor-input')).toBeNull()
  })

  it('pasteMode false: click opens the editor even though onCellSelect is provided', () => {
    const onCellSelect = vi.fn()
    const { container } = renderCell({ pasteMode: false, onCellSelect })
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    expect(onCellSelect).not.toHaveBeenCalled()
    expect(container.querySelector('.cell-inline-editor-input')).not.toBeNull()
  })

  it('neither stamp nor paste active: click opens the editor', () => {
    const { container } = renderCell()
    fireEvent.click(container.querySelector('[role="gridcell"]'))
    expect(container.querySelector('.cell-inline-editor-input')).not.toBeNull()
  })
})
