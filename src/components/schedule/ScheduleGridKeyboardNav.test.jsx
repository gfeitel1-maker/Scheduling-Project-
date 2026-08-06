// @vitest-environment jsdom
//
// T59. Roving tabindex, accessible names, and the T55 collapsed-row focus
// contract, asserted against a real rendered view rather than the pure modules.
//
// What this file CANNOT verify, by construction: jsdom builds no accessibility
// tree, so a computed accessible NAME here is really "the aria-label attribute
// we wrote". The names were also read off Chromium's real AX tree over CDP —
// see the ticket's closure note. jsdom is doing the tabindex bookkeeping and
// the DOM-structure half only.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import ScheduleGroupView from './ScheduleGroupView'
import ScheduleDayView from './ScheduleDayView'
import { makeGridGeometry } from '../../screens/schedule/gridGeometry'

const groups = [{ id: 'g1', name: 'Alpha', tier_id: 't1' }, { id: 'g2', name: 'Bravo', tier_id: 't1' }]
const days = [{ id: 'd1', label: 'Monday' }, { id: 'd2', label: 'Tuesday' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
  { id: 'b3', name: 'Block 3', sort_order: 3, start_time: '11:00:00', end_time: '12:00:00' },
]

// Tuesday b1->b2 is a spanning cell (rowSpan 2). Monday b1 is its left
// neighbour at the span's first row; Monday b2 is its left neighbour at the
// span's second row — that is the pair the "enter from the side" rule needs.
const slots = [
  { id: 's1', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', is_anchor: false },
  { id: 's2', group_id: 'g1', day_id: 'd2', time_block_id: 'b2', activity_id: 'a1', is_anchor: false, is_span_head: false },
  { id: 's3', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a2', is_anchor: false },
  { id: 's4', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'a2', is_anchor: false },
]

const actMap = new Map([
  ['a1', { id: 'a1', name: 'Swimming' }],
  ['a2', { id: 'a2', name: 'Soccer' }],
])

const noop = () => {}

function renderGroupView(extra = {}) {
  const geometry = makeGridGeometry({ slots, timeBlocks, groups, overlays: [], fillState: null })
  const { container } = render(
    <DndContext>
      <ScheduleGroupView
        groups={groups}
        days={days}
        timeBlocks={timeBlocks}
        selectedGroup="g1"
        onSelectGroup={noop}
        weatherMode={false}
        stampMode={false}
        actMap={actMap}
        anchorMap={new Map()}
        releaseCell={noop}
        geometry={geometry}
        handleFillEnter={noop}
        startFill={noop}
        removeOverlay={noop}
        handleStampClick={noop}
        onEditSlot={noop}
        fillState={null}
        {...extra}
      />
    </DndContext>,
  )
  return container
}

const frameOf = c => c.querySelector('[role="grid"]')
const allCells = c => [...frameOf(c).querySelectorAll('[role="gridcell"], [role="columnheader"], [role="rowheader"]')]
// The row header's focus target is its toggle button, not the cell box.
const targetOf = el => el.querySelector('.row-header-toggle') ?? el
const tabStops = c => allCells(c).map(targetOf).filter(el => el.tabIndex === 0)

function cellAt(container, row, col) {
  const rowEl = [...frameOf(container).querySelectorAll('[role="row"]')]
    .find(r => Number(r.getAttribute('aria-rowindex')) === row)
  return [...rowEl.querySelectorAll('[role="gridcell"], [role="columnheader"], [role="rowheader"]')]
    .find(el => Number(el.getAttribute('aria-colindex')) === col)
}

function press(container, key, opts = {}) {
  const active = tabStops(container)[0]
  fireEvent.keyDown(active, { key, ...opts })
}

// The element the roving 0 currently sits on, resolved back to its cell box.
function focusedCell(container) {
  const stop = tabStops(container)[0]
  return stop.closest('[role="gridcell"], [role="columnheader"], [role="rowheader"]')
}

describe('T59 — the grid is one tab stop', () => {
  let container
  beforeEach(() => { container = renderGroupView() })

  it('has exactly one cell with tabindex 0 and puts -1 on all the rest', () => {
    const stops = tabStops(container)
    expect(stops).toHaveLength(1)
    const others = allCells(container).map(targetOf).filter(el => el !== stops[0])
    expect(others.length).toBeGreaterThan(0)
    expect(others.every(el => el.tabIndex === -1)).toBe(true)
  })

  it('starts at the grid origin', () => {
    expect(focusedCell(container)).toBe(cellAt(container, 1, 1))
  })

  it('leaves exactly one tab stop after every arrow keypress', () => {
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      press(container, key)
      expect(tabStops(container)).toHaveLength(1)
    }
  })

  it('gives no draggable cell a tab stop of its own', () => {
    // dnd-kit hands every draggable tabIndex 0; SlotCell drops it, or the grid
    // would be ~one tab stop per filled cell instead of one in total.
    expect(tabStops(container)).toHaveLength(1)
  })
})

describe('T59 — arrow keys move focus', () => {
  let container
  beforeEach(() => { container = renderGroupView() })

  it('moves one cell down, right, up and left', () => {
    press(container, 'ArrowDown')
    expect(focusedCell(container)).toBe(cellAt(container, 2, 1))
    press(container, 'ArrowRight')
    expect(focusedCell(container)).toBe(cellAt(container, 2, 2))
    press(container, 'ArrowUp')
    expect(focusedCell(container)).toBe(cellAt(container, 1, 2))
    press(container, 'ArrowLeft')
    expect(focusedCell(container)).toBe(cellAt(container, 1, 1))
  })

  it('does not move past the grid edge', () => {
    press(container, 'ArrowUp')
    expect(focusedCell(container)).toBe(cellAt(container, 1, 1))
    press(container, 'ArrowLeft')
    expect(focusedCell(container)).toBe(cellAt(container, 1, 1))
  })

  it('moves to the ends of a row with Home and End', () => {
    press(container, 'ArrowDown')
    press(container, 'End')
    expect(focusedCell(container)).toBe(cellAt(container, 2, 3))
    press(container, 'Home')
    expect(focusedCell(container)).toBe(cellAt(container, 2, 1))
  })

  it('moves focus onto the row header toggle, not the row header box', () => {
    press(container, 'ArrowDown')
    const stop = tabStops(container)[0]
    expect(stop.className).toContain('row-header-toggle')
    expect(stop.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('T59 — the spanning-cell rule, in a rendered view', () => {
  let container
  // Tuesday (col 3) block 1 is the head of a rowSpan 2 cell covering rows 2-3.
  beforeEach(() => { container = renderGroupView() })

  it('renders the span the rule is about', () => {
    expect(cellAt(container, 2, 3).getAttribute('aria-rowspan')).toBe('2')
  })

  it('leaves a spanning cell downward into the row AFTER its whole extent', () => {
    press(container, 'ArrowDown')      // row 2, col 1
    press(container, 'End')            // row 2, col 3 — the spanning head
    expect(focusedCell(container)).toBe(cellAt(container, 2, 3))
    press(container, 'ArrowDown')      // must be row 4, never row 3
    expect(focusedCell(container)).toBe(cellAt(container, 4, 3))
  })

  it('leaves a spanning cell upward into the row BEFORE its head', () => {
    press(container, 'ArrowDown')
    press(container, 'End')
    press(container, 'ArrowUp')
    expect(focusedCell(container)).toBe(cellAt(container, 1, 3))
  })

  it('entered from the side at its second row, exits sideways to the SAME row', () => {
    // Down to row 3, col 1 (the row header of block 2), right to col 2, then
    // right into the spanning cell at logical row 3.
    press(container, 'ArrowDown')
    press(container, 'ArrowDown')       // row 3, col 1
    press(container, 'ArrowRight')      // row 3, col 2
    expect(focusedCell(container)).toBe(cellAt(container, 3, 2))
    press(container, 'ArrowRight')      // into the span, at logical row 3
    expect(focusedCell(container)).toBe(cellAt(container, 2, 3))
    press(container, 'ArrowLeft')       // back out — row 3, not row 2
    expect(focusedCell(container)).toBe(cellAt(container, 3, 2))
  })
})

describe('T59 — accessible names', () => {
  let container
  beforeEach(() => { container = renderGroupView() })

  it('names a spanning cell with its activity, its whole extent, and its day', () => {
    expect(cellAt(container, 2, 3).getAttribute('aria-label'))
      .toBe('Swimming, Block 1 to Block 2, Tuesday')
  })

  it('names a single-block cell with one block', () => {
    expect(cellAt(container, 2, 2).getAttribute('aria-label'))
      .toBe('Soccer, Block 1, Monday')
  })

  it('announces an empty cell as empty, not as a blank cell', () => {
    expect(cellAt(container, 4, 2).getAttribute('aria-label'))
      .toBe('Empty, Block 3, Monday')
  })

  it('names day-view cells by their GROUP, because that view\'s columns are groups', () => {
    const geometry = makeGridGeometry({ slots, timeBlocks, groups, overlays: [], fillState: null })
    const { container: c } = render(
      <DndContext>
        <ScheduleDayView
          groups={groups} days={days} timeBlocks={timeBlocks}
          selectedDay="d2" onSelectDay={noop}
          weatherMode={false} stampMode={false}
          actMap={actMap} anchorMap={new Map()}
          releaseCell={noop} geometry={geometry}
          handleFillEnter={noop} startFill={noop} removeOverlay={noop}
          handleStampClick={noop} onEditSlot={noop} fillState={null}
        />
      </DndContext>,
    )
    expect(cellAt(c, 2, 2).getAttribute('aria-label'))
      .toBe('Swimming, Block 1 to Block 2, Alpha')
    expect(cellAt(c, 2, 3).getAttribute('aria-label'))
      .toBe('Empty, Block 1, Bravo')
  })

  it('gives every cell in the grid a non-empty accessible name', () => {
    const body = allCells(container).filter(el => el.getAttribute('role') === 'gridcell')
    expect(body.length).toBeGreaterThan(0)
    expect(body.every(el => (el.getAttribute('aria-label') || '').length > 0)).toBe(true)
  })
})

describe('T59 — the T55 collapsed-row contract survives', () => {
  let container
  beforeEach(() => { container = renderGroupView({ collapsedBlockIds: new Set(['b3']) }) })

  it('keeps a collapsed row\'s cells focusable and out of aria-hidden', () => {
    const cell = cellAt(container, 4, 2)
    expect(cell.getAttribute('data-collapsed')).toBe('')
    expect(cell.getAttribute('aria-hidden')).toBe(null)
    expect(cell.tabIndex).toBe(-1) // focusable, just not the roving stop
  })

  it('keeps a collapsed row\'s cells named', () => {
    expect(cellAt(container, 4, 2).getAttribute('aria-label'))
      .toBe('Empty, Block 3, Monday')
  })

  it('reaches a collapsed row by arrow key and makes it the tab stop', () => {
    press(container, 'ArrowDown')
    press(container, 'ArrowRight')
    press(container, 'ArrowDown')
    press(container, 'ArrowDown')
    expect(focusedCell(container)).toBe(cellAt(container, 4, 2))
    expect(tabStops(container)).toHaveLength(1)
  })

  it('keeps aria-expanded on the row-header toggle reflecting collapse state', () => {
    const collapsed = targetOf(cellAt(container, 4, 1))
    const expanded = targetOf(cellAt(container, 2, 1))
    expect(collapsed.getAttribute('aria-expanded')).toBe('false')
    expect(expanded.getAttribute('aria-expanded')).toBe('true')
  })
})
