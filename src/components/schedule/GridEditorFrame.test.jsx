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

  it('gives each group column a readable floor and wraps headers at word boundaries only', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `g${i}`, name: `Badger ${i}` }))
    renderFrame({ groups: many })
    const frame = document.querySelector('.schedule-grid-frame')
    expect(frame.style.getPropertyValue('--frame-min-width')).toBe(`${140 + 14 * 88}px`)
    const header = screen.getByRole('columnheader', { name: 'Badger 3' })
    expect(header.style.overflowWrap).not.toBe('anywhere')
    expect(header.getAttribute('title')).toBe('Badger 3')
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

  it('shows a block named after its own times once, as the friendly range', () => {
    renderFrame({ timeBlocks: [{ id: 'b1', name: '08:40-09:00', start_time: '08:40', end_time: '09:00' }] })
    expect(screen.queryByText('08:40-09:00')).toBeNull()
    expect(screen.getAllByText('8:40–9:00 AM')).toHaveLength(1)
  })

  it('shows a real block name plus the friendly time', () => {
    renderFrame({ timeBlocks: [{ id: 'b1', name: 'Lunch Period', start_time: '12:00', end_time: '12:40' }] })
    expect(screen.getByText('Lunch Period')).toBeTruthy()
    expect(screen.getByText('12:00–12:40 PM')).toBeTruthy()
  })

  it('keeps similar group headers readable: full name in the title, wrapping instead of truncating', () => {
    renderFrame({ groups: [{ id: 'g1', name: 'Badger 2' }, { id: 'g2', name: 'Badger 3' }, { id: 'g3', name: 'Porcupine 2' }] })
    const heads = screen.getAllByRole('columnheader').filter((h) => h.textContent !== 'Block')
    expect(heads.map((h) => h.getAttribute('title'))).toEqual(['Badger 2', 'Badger 3', 'Porcupine 2'])
    for (const h of heads) expect(h.style.whiteSpace).toBe('normal')
  })
})
