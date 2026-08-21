// @vitest-environment jsdom
//
// T54's transitional `renderAs` prop and its <td> branch were deleted in T56,
// together with the constraint this file originally pinned (that SlotCell and
// OverlayCell must default to <td> while three views were still tables). What
// remains is the invariant that replaced it: both components are unconditional
// role="gridcell" divs, and both carry the placement their caller computed.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

  it('renders the WEEK_CLOSED marker with its reason as the title, and none when unflagged', () => {
    const withFlag = render(
      <DndContext>
        <SlotCell
          slot={{ ...slot, flags: { WEEK_CLOSED: true, WEEK_CLOSED_reason: 'Swim is marked closed this week' } }}
          activity={{ id: 'a1', name: 'Swim' }}
          actColorIdx={0}
          onEdit={() => {}}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    const marker = withFlag.container.querySelector('.flag--week-closed')
    expect(marker).not.toBeNull()
    expect(marker.getAttribute('title')).toBe('Swim is marked closed this week')
    // The activity name is preserved — the marker never replaces its identity.
    expect(withFlag.container.textContent).toContain('Swim')

    const noFlag = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Swim' }}
          actColorIdx={0}
          onEdit={() => {}}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d2|b1"
        />
      </DndContext>
    )
    expect(noFlag.container.querySelector('.flag--week-closed')).toBeNull()
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

  it('renders the merge button permanently in the idle DOM, queryable without any hover (T92)', () => {
    // T92: the merge/split button is no longer hover-gated (visibility:hidden
    // at rest) — it is always in the DOM and always hit-testable, which is
    // what makes it discoverable without being told and reachable by
    // getByRole without simulating hover.
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          hasMergeDown={true}
          isDndEnabled={true}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
        />
      </DndContext>
    )
    const button = screen.getByRole('button', { name: /run into the next period/i })
    expect(button).toBeTruthy()
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('renders the split variant with its own aria-label when the slot is merged', () => {
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isMerged={true}
          isDndEnabled={true}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
        />
      </DndContext>
    )
    const button = screen.getByRole('button', { name: /split this back into two periods/i })
    expect(button.className).toContain('cell-action--split')
  })

  it('carries the one-time onboarding pulse data attribute only when showMergeHint is set', () => {
    const withHint = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          hasMergeDown={true}
          isDndEnabled={true}
          showMergeHint={true}
        />
      </DndContext>
    )
    expect(withHint.container.querySelector('.cell-action').hasAttribute('data-merge-hint')).toBe(true)

    const withoutHint = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          hasMergeDown={true}
          isDndEnabled={true}
        />
      </DndContext>
    )
    expect(withoutHint.container.querySelector('.cell-action').hasAttribute('data-merge-hint')).toBe(false)
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

  it('clicking an unlocked, unselected activity cell activates inline write instead of opening a modal', () => {
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    fireEvent.click(screen.getByRole('gridcell'))
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('does not activate inline write on an anchor cell', () => {
    const anchorSlot = { id: 's2', groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'anchor' }
    render(
      <DndContext>
        <SlotCell slot={anchorSlot} anchor={{ name: 'Flag' }} />
      </DndContext>
    )
    fireEvent.click(screen.getByRole('gridcell'))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a click calls onCellClick (stamp mode) instead of activating inline write when onCellClick is supplied', () => {
    const onCellClick = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          onCellClick={onCellClick}
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    fireEvent.click(screen.getByRole('gridcell'))
    expect(onCellClick).toHaveBeenCalledWith(slot)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Enter on a focused, unlocked activity cell activates inline write', () => {
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'Enter' })
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('Enter on a focused, LOCKED cell releases it instead of activating inline write', () => {
    const onRelease = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          isLocked
          onRelease={onRelease}
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'Enter' })
    expect(onRelease).toHaveBeenCalledWith(slot)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Space on a focused, draggable cell does NOT activate inline write (reserved for dnd-kit keyboard-drag pickup)', () => {
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: ' ' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Enter on an anchor cell does nothing (anchors are not writable)', () => {
    const anchorSlot = { id: 's2', groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'anchor' }
    render(
      <DndContext>
        <SlotCell slot={anchorSlot} anchor={{ name: 'Flag' }} />
      </DndContext>
    )
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'Enter' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

// T105 §4 — elective cell render (design's symmetric pair: a one-off never
// leaks into the reuse surface (localClient.mock.electives.test.js), and never
// FAILS to render on the render surface — this is the flip side).
describe('SlotCell — elective render (T105)', () => {
  const electiveSlot = {
    id: 's3', groupId: 'g1', dayId: 'd1', blockId: 'b1',
    type: 'activity', activity_id: null, elective_set_id: 'set-1', flags: {},
  }

  it('renders a ONE-OFF (is_reusable=0) elective set correctly from electiveSetsAll — the render surface must never be the durable-only list', () => {
    const { container } = render(
      <DndContext>
        <SlotCell
          slot={electiveSlot}
          electiveSetsAll={[{ id: 'set-1', name: 'Afternoon Chugim', is_reusable: 0 }]}
          electiveMembersBySet={new Map([['set-1', ['act-1', 'act-2']]])}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.getByText('Afternoon Chugim (2)')).toBeTruthy()
    expect(container.querySelector('[data-elective]')).toBeTruthy()
  })

  it('a dangling elective_set_id (set deleted from another device) renders "Elective (removed)", not blank or a thrown error', () => {
    render(
      <DndContext>
        <SlotCell
          slot={electiveSlot}
          electiveSetsAll={[]}
          electiveMembersBySet={new Map()}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.getByText('Elective (removed)')).toBeTruthy()
  })

  it('a non-elective cell never carries the [data-elective] attribute', () => {
    const { container } = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(container.querySelector('[data-elective]')).toBeNull()
  })
})
