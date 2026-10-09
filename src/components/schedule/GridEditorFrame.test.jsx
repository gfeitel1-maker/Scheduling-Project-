// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import GridEditorFrame from './GridEditorFrame'

const groups = [{ id: 'g1', name: 'Bunk 1' }, { id: 'g2', name: 'Bunk 2' }]
const timeBlocks = [{ id: 'b1', name: 'Morning' }, { id: 'b2', name: 'Lunch' }]

function renderFrame(props = {}) {
  const handlers = { onBack: vi.fn(), onMoveBlock: vi.fn(), onRenameBlock: vi.fn(), onRemoveBlock: vi.fn(), onPrint: vi.fn() }
  render(
    <GridEditorFrame
      backLabel="← Special Schedules"
      title={<div>Color War</div>}
      groups={groups}
      timeBlocks={timeBlocks}
      filledCount={1}
      totalCells={4}
      renderCell={(g, block) => <div key={g.id} role="gridcell">{`${g.name}/${block.name}`}</div>}
      printLabel="Print"
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

describe('GridEditorFrame', () => {
  it('renders the back row, toolbar count, Block header, group headers and one cell per group × block', () => {
    const h = renderFrame()
    expect(screen.getByText('Color War')).toBeTruthy()
    expect(screen.getByText('2 groups × 2 blocks — 1 / 4 filled')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Block' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Bunk 2' })).toBeTruthy()
    expect(screen.getAllByRole('gridcell')).toHaveLength(4)
    expect(screen.getByText('Bunk 2/Lunch')).toBeTruthy()
    fireEvent.click(screen.getByText('← Special Schedules'))
    expect(h.onBack).toHaveBeenCalled()
  })

  it('renders meta between the back row and the banners, and nothing when omitted', () => {
    renderFrame({ meta: <div data-testid="meta">Placed on</div>, banners: <div data-testid="banner">b</div> })
    const meta = screen.getByTestId('meta')
    expect(screen.getByText('Color War').compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(meta.compareDocumentPosition(screen.getByTestId('banner')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('without meta the frame is unchanged (EventGridEditor)', () => {
    renderFrame()
    expect(screen.queryByTestId('meta')).toBeNull()
    expect(screen.queryByText('Placed on')).toBeNull()
  })

  it('shows the empty node instead of the grid when given one', () => {
    renderFrame({ empty: <div>Nothing here</div> })
    expect(screen.getByText('Nothing here')).toBeTruthy()
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('wires block move, rename and remove to the row header', () => {
    const h = renderFrame()
    expect(screen.getAllByTitle('Move up')[0].disabled).toBe(true)
    fireEvent.click(screen.getAllByTitle('Move down')[0])
    expect(h.onMoveBlock).toHaveBeenCalledWith('b1', 1)
    fireEvent.click(screen.getAllByTitle('Remove block')[1])
    expect(h.onRemoveBlock).toHaveBeenCalledWith('b2')
    fireEvent.click(screen.getByText('Morning'))
    const input = screen.getByDisplayValue('Morning')
    fireEvent.change(input, { target: { value: 'Breakfast' } })
    fireEvent.blur(input)
    expect(h.onRenameBlock).toHaveBeenCalledWith('b1', 'Breakfast')
  })

  it('renders the footer label, Print and footer children', () => {
    const h = renderFrame({ footerLabel: 'Notes', children: <textarea aria-label="notes" /> })
    expect(screen.getByText('Notes')).toBeTruthy()
    expect(screen.getByLabelText('notes')).toBeTruthy()
    fireEvent.click(screen.getByText('Print'))
    expect(h.onPrint).toHaveBeenCalled()
  })
})
