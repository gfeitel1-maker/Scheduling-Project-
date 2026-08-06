// @vitest-environment jsdom
//
// T54's blocking constraint, pinned. SlotCell and OverlayCell are shared with
// ScheduleDayView, ScheduleActivityView and ManualBuildView, which are still
// <table>s until T56. If either component's default flips to a <div>, those
// views get a <div> inside a <tr>, browsers hoist it out of the table, and the
// app breaks visibly with nothing throwing. Delete this file in T56, together
// with the renderAs prop and its 'td' branch.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import SlotCell from './SlotCell'
import OverlayCell from './OverlayCell'

const slot = {
  id: 's1', groupId: 'g1', dayId: 'd1', blockId: 'b1',
  type: 'activity', activity_id: 'a1', flags: {},
}

function renderInRow(node) {
  const { container } = render(
    <DndContext><table><tbody><tr>{node}</tr></tbody></table></DndContext>
  )
  return container.querySelector('tr')
}

describe('shared cell components default to <td> (T54 transitional constraint)', () => {
  it('SlotCell renders a td when renderAs is omitted', () => {
    const row = renderInRow(
      <SlotCell slot={slot} activity={{ id: 'a1', name: 'Soccer' }} actColorIdx={0} rowSpan={2} onEdit={() => {}} />
    )
    const cell = row.firstElementChild
    expect(cell.tagName).toBe('TD')
    expect(cell.getAttribute('rowspan')).toBe('2')
    expect(cell.getAttribute('role')).toBeNull()
  })

  it('OverlayCell renders a td when renderAs is omitted', () => {
    const row = renderInRow(<OverlayCell label="Field trip" rowSpan={3} onRemove={() => {}} />)
    const cell = row.firstElementChild
    expect(cell.tagName).toBe('TD')
    expect(cell.getAttribute('rowspan')).toBe('3')
  })

  it('SlotCell renders a placed gridcell when renderAs="gridcell"', () => {
    const { container } = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          rowSpan={2}
          onEdit={() => {}}
          renderAs="gridcell"
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
  })
})
