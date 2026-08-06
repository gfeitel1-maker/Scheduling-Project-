// @vitest-environment jsdom
//
// T54's transitional `renderAs` prop and its <td> branch were deleted in T56,
// together with the constraint this file originally pinned (that SlotCell and
// OverlayCell must default to <td> while three views were still tables). What
// remains is the invariant that replaced it: both components are unconditional
// role="gridcell" divs, and both carry the placement their caller computed.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import SlotCell from './SlotCell'
import OverlayCell from './OverlayCell'

const slot = {
  id: 's1', groupId: 'g1', dayId: 'd1', blockId: 'b1',
  type: 'activity', activity_id: 'a1', flags: {},
}

describe('shared cell components render placed gridcells (T56)', () => {
  it('SlotCell renders a placed gridcell and no table markup', () => {
    const { container } = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          rowSpan={2}
          onEdit={() => {}}
          gridRow="4 / span 2"
          gridColumn="3 / span 1"
          ariaColIndex={3}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    const cell = container.querySelector('[role="gridcell"]')
    expect(cell.tagName).toBe('DIV')
    expect(cell.style.gridRow).toBe('4 / span 2')
    expect(cell.style.gridColumn).toBe('3 / span 1')
    expect(cell.getAttribute('aria-rowspan')).toBe('2')
    expect(cell.getAttribute('data-cell-key')).toBe('g1|d1|b1')
    expect(container.querySelectorAll('td, th, tr, table').length).toBe(0)
    expect(container.querySelectorAll('[rowspan]').length).toBe(0)
  })

  it('OverlayCell renders a placed gridcell and no table markup', () => {
    const { container } = render(
      <OverlayCell
        label="Field trip"
        rowSpan={3}
        onRemove={() => {}}
        gridRow="1 / span 3"
        gridColumn="2 / span 1"
        ariaColIndex={2}
        cellKey="g1|d1|b1"
      />
    )
    const cell = container.querySelector('[role="gridcell"]')
    expect(cell.tagName).toBe('DIV')
    expect(cell.style.gridRow).toBe('1 / span 3')
    expect(cell.style.gridColumn).toBe('2 / span 1')
    expect(cell.getAttribute('aria-rowspan')).toBe('3')
    expect(container.querySelectorAll('td, th, tr, table').length).toBe(0)
  })

  it('keeps every hover affordance out of React state', () => {
    // The §6 payoff, banked: hovering a cell must re-render nothing. The merge
    // button, the split button and the expand handle are all mounted up front
    // and gated by :hover in scheduleGrid.css, so they are in the DOM without
    // any pointer event having fired.
    const { container } = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          onEdit={() => {}}
          hasMergeDown={true}
          isDndEnabled={true}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
        />
      </DndContext>
    )
    expect(container.querySelector('.cell-action')).not.toBeNull()
    expect(container.querySelector('.expand-handle')).not.toBeNull()
    // Both glyphs are mounted; the stylesheet picks one. A pseudo-state cannot
    // swap a text node, which is why there are two.
    expect(container.querySelectorAll('.expand-glyph').length).toBe(2)
  })

  it('never lets dnd-kit displace role="gridcell" with role="button"', () => {
    const { container } = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          onEdit={() => {}}
          isDndEnabled={true}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    const cell = container.querySelector('[data-cell-key="g1|d1|b1"]')
    expect(cell.getAttribute('role')).toBe('gridcell')
    expect(cell.getAttribute('aria-roledescription')).toBe('draggable')
  })
})
