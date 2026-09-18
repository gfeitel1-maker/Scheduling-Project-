// @vitest-environment jsdom
//
// T54's transitional `renderAs` prop and its <td> branch were deleted in T56,
// together with the constraint this file originally pinned (that SlotCell must
// default to <td> while three views were still tables). What remains is the
// invariant that replaced it: SlotCell is an unconditional role="gridcell" div
// carrying the placement its caller computed.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import SlotCell from './SlotCell'

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

  it('renders the drag-to-extend bar in the idle DOM, hover-revealed but always present (T92, revised 2026-09-12)', () => {
    // T92 originally pinned the MERGE BUTTON here: always in the DOM, never
    // hover-gated, so it was discoverable without being told. The owner
    // removed that button on 2026-09-12 — it and the drag bar did overlapping
    // jobs, and a permanent affordance on every mergeable cell of a dense grid
    // is noise.
    //
    // What survives is the invariant, re-pointed at the bar: the control is
    // always in the DOM and hit-testable without simulating hover. Its
    // VISIBILITY is now CSS (`.cell:hover .span-extend-handle`), which jsdom
    // does not evaluate — so this asserts presence, and the reveal itself is
    // verified in the running app, not here.
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          hasMergeDown={true}
          onExtendGrab={vi.fn()}
          isDndEnabled={true}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
        />
      </DndContext>
    )
    const bar = screen.getByRole('button', { name: /drag to make this activity run longer/i })
    expect(bar).toBeTruthy()
    expect(bar.className).toContain('span-extend-handle')
    // and the control it replaced is really gone
    expect(screen.queryByLabelText('Let this activity run into the next period')).toBeNull()
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

  it('an interior split band stops pointerdown from bubbling to the cell drag activator (Red Hat 2026-08-21)', () => {
    // Without the guard, a tap-with-drift on a split band reaches the cell's
    // dnd-kit pointerdown listener and starts a whole-span drag instead of a
    // split. A spy on a parent wrapper stands in for that ancestor listener:
    // if stopPropagation is working, the pointerdown never reaches it.
    const parentPointerDown = vi.fn()
    const onSplitAt = vi.fn()
    const { container } = render(
      <DndContext>
        <div onPointerDown={parentPointerDown}>
          <SlotCell
            slot={slot}
            activity={{ id: 'a1', name: 'Soccer' }}
            actColorIdx={0}
            isMerged={true}
            isDndEnabled={true}
            rowSpan={2}
            spanTailBlockIds={['b2']}
            onSplitAt={onSplitAt}
            gridRow="1 / span 2"
            gridColumn="2 / span 1"
          />
        </div>
      </DndContext>
    )
    const band = container.querySelector('.span-band')
    expect(band).toBeTruthy()
    fireEvent.pointerDown(band)
    expect(parentPointerDown).not.toHaveBeenCalled() // guard held
    fireEvent.click(band)
    expect(onSplitAt).toHaveBeenCalledWith('b2')
  })

  it('carries the one-time onboarding pulse data attribute only when showExtendHint is set', () => {
    const withHint = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          hasMergeDown={true}
          onExtendGrab={vi.fn()}
          isDndEnabled={true}
          showExtendHint={true}
        />
      </DndContext>
    )
    expect(withHint.container.querySelector('.span-extend-handle').hasAttribute('data-span-extend-hint')).toBe(true)

    const withoutHint = render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          hasMergeDown={true}
          onExtendGrab={vi.fn()}
          isDndEnabled={true}
        />
      </DndContext>
    )
    expect(withoutHint.container.querySelector('.span-extend-handle').hasAttribute('data-span-extend-hint')).toBe(false)
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

  // WS5 follow-up "double-click to edit" (owner directive 2026-08-29):
  // Excel-style — a single plain click no longer opens the inline editor, so
  // that click is free for the cell's selection/merge/swap affordances.
  it('a single plain click on an unlocked, unselected activity cell does NOT activate inline write', () => {
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
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('double-clicking an unlocked, unselected activity cell activates inline write instead of opening a modal', () => {
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
    fireEvent.doubleClick(screen.getByRole('gridcell'))
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('a single plain click still fires onSelect when supplied (selection is not eaten by the double-click change)', () => {
    const onSelect = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          onSelect={onSelect}
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    fireEvent.click(screen.getByRole('gridcell'))
    expect(onSelect).toHaveBeenCalledWith(slot, expect.anything())
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('double-click still activates inline write even when onSelect is supplied (selection never blocks the editor)', () => {
    const onSelect = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          onSelect={onSelect}
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    fireEvent.doubleClick(screen.getByRole('gridcell'))
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

  it('a double-click also calls onCellClick (stamp mode) instead of activating inline write when onCellClick is supplied', () => {
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
    fireEvent.doubleClick(screen.getByRole('gridcell'))
    expect(onCellClick).toHaveBeenCalledWith(slot)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('in paste mode, a double-click on a filled cell pastes (onSelect) and does NOT open the editor', () => {
    // stamp > paste > edit precedence, matching EmptyCell.activate(): a
    // double-click mid-paste must behave as a paste target, not pop the editor.
    const onSelect = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          pasteMode
          onSelect={onSelect}
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    fireEvent.doubleClick(screen.getByRole('gridcell'))
    expect(onSelect).toHaveBeenCalledWith(slot, expect.anything())
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a real double-click sequence (click, click, dblclick) in paste mode never opens the editor', () => {
    // jsdom fireEvent.doubleClick only dispatches `dblclick`; a real browser
    // fires the two constituent `click`s first. Simulate the full sequence to
    // prove the prefix clicks (handleClick → onSelect paste) don't leave the
    // editor open and the dblclick honors paste mode rather than editing.
    const onSelect = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          actColorIdx={0}
          isDndEnabled
          pasteMode
          onSelect={onSelect}
          eligibleActivities={[{ id: 'a1', name: 'Soccer' }]}
          onPlace={vi.fn()}
          onCreateNew={vi.fn()}
        />
      </DndContext>
    )
    const cell = screen.getByRole('gridcell')
    fireEvent.click(cell)
    fireEvent.click(cell)
    fireEvent.doubleClick(cell)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onSelect).toHaveBeenCalled()
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

// Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
// placement.md §3/§5) — opaque render + dangling-reference fallback, mirrors
// the elective-cell block above exactly.
describe('SlotCell — events overlay opaque render', () => {
  const eventSlot = {
    id: 's4', groupId: 'g1', dayId: 'd1', blockId: 'b1',
    type: 'activity', activity_id: null, event_id: 'ev-1', flags: {},
  }

  it('renders the event name and carries the [data-event] attribute', () => {
    const { container } = render(
      <DndContext>
        <SlotCell
          slot={eventSlot}
          eventsAll={[{ id: 'ev-1', name: 'Color War' }]}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.getByText('Color War')).toBeTruthy()
    expect(container.querySelector('[data-event]')).toBeTruthy()
  })

  it('a dangling event_id (event deleted from another device) renders "Event (removed)", not blank or a thrown error', () => {
    render(
      <DndContext>
        <SlotCell
          slot={eventSlot}
          eventsAll={[]}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.getByText('Event (removed)')).toBeTruthy()
  })

  it('a non-event cell never carries the [data-event] attribute', () => {
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
    expect(container.querySelector('[data-event]')).toBeNull()
  })
})

// Slice 2 (docs/work/specs/2026-08-22-electives-nested-schedule-slices.md) —
// the campwide-cell-to-Electives-screen drill-in button.
describe('SlotCell — elective drill-in button (Slice 2)', () => {
  const electiveSlot = {
    id: 's3', groupId: 'g1', dayId: 'd1', blockId: 'b1',
    type: 'activity', activity_id: null, elective_set_id: 'set-1', flags: {},
  }

  it('renders an "open in Electives" button on a resolved elective cell, and clicking it calls onOpenElective with the set id without opening the inline editor', () => {
    const onOpenElective = vi.fn()
    const onSelect = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={electiveSlot}
          electiveSetsAll={[{ id: 'set-1', name: 'Afternoon Chugim', is_reusable: 0 }]}
          electiveMembersBySet={new Map([['set-1', ['act-1']]])}
          onOpenElective={onOpenElective}
          onSelect={onSelect}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    const button = screen.getByRole('button', { name: 'Open Afternoon Chugim in Electives' })
    fireEvent.click(button)
    expect(onOpenElective).toHaveBeenCalledWith('set-1')
    // stopPropagation on the button's own click keeps the cell's click
    // handler (here onSelect, the same precedence path handleClick uses)
    // from also firing — the drill-in must not double as cell selection.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders no drill-in button when the reference is dangling (no resolved set to open)', () => {
    render(
      <DndContext>
        <SlotCell
          slot={electiveSlot}
          electiveSetsAll={[]}
          electiveMembersBySet={new Map()}
          onOpenElective={vi.fn()}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.queryByRole('button', { name: /Open .* in Electives/ })).toBeNull()
  })

  it('renders no drill-in button on a non-elective cell', () => {
    render(
      <DndContext>
        <SlotCell
          slot={slot}
          activity={{ id: 'a1', name: 'Soccer' }}
          onOpenElective={vi.fn()}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.queryByRole('button', { name: /Open .* in Electives/ })).toBeNull()
  })

  it('renders no drill-in button when onOpenElective is not supplied (schedule views that never wire it stay unaffected)', () => {
    render(
      <DndContext>
        <SlotCell
          slot={electiveSlot}
          electiveSetsAll={[{ id: 'set-1', name: 'Afternoon Chugim', is_reusable: 0 }]}
          electiveMembersBySet={new Map()}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.queryByRole('button', { name: /Open .* in Electives/ })).toBeNull()
  })
})

// Events overlay placement Slice 1 — drill-in button, mirrors the elective
// drill-in block above exactly.
describe('SlotCell — event drill-in button (Slice 1)', () => {
  const eventSlot = {
    id: 's4', groupId: 'g1', dayId: 'd1', blockId: 'b1',
    type: 'activity', activity_id: null, event_id: 'ev-1', flags: {},
  }

  it('renders an "open in Events" button on a resolved event cell, and clicking it calls onOpenEvent with the event id without opening the inline editor', () => {
    const onOpenEvent = vi.fn()
    const onSelect = vi.fn()
    render(
      <DndContext>
        <SlotCell
          slot={eventSlot}
          eventsAll={[{ id: 'ev-1', name: 'Color War' }]}
          onOpenEvent={onOpenEvent}
          onSelect={onSelect}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    const button = screen.getByRole('button', { name: 'Open Color War in Events' })
    fireEvent.click(button)
    expect(onOpenEvent).toHaveBeenCalledWith('ev-1')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders no drill-in button when the reference is dangling (no resolved event to open)', () => {
    render(
      <DndContext>
        <SlotCell
          slot={eventSlot}
          eventsAll={[]}
          onOpenEvent={vi.fn()}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )
    expect(screen.queryByRole('button', { name: /Open .* in Events/ })).toBeNull()
  })
})

// Real-user-path coverage (Tester finding, review round): every prior events
// test builds a fixture row with event_id already set. This test instead
// drives the ACTUAL path a director uses — create an event, place it on a
// cell via the real placement write (useSlotMutations' placeEventOnCell),
// then render the resulting slot through SlotCell and confirm it shows the
// event NAME (not the dangling-reference fallback), and that the drill-in
// affordance calls onOpenEvent. This is the coverage that would have caught
// Step 4's read/render wiring gap (before this fix, a placed event rendered
// as "Event (removed)" because ScheduleScreen never threaded eventsAll into
// SlotCell at all).
describe('Events overlay Slice 1 — real placement path (create -> place -> render -> drill-in)', () => {
  it('placing a real event via placeEventOnCell, then rendering the resulting slot through SlotCell, shows the event name and wires the drill-in', async () => {
    const { renderHook, act } = await import('@testing-library/react')
    const { useSlotMutations } = await import('../../screens/schedule/useSlotMutations')
    const { getSlot } = await import('../../screens/schedule/gridGeometry')

    // "Create an event" — the director's real EventScreen action, modeled
    // here as the same write the setupCrudRepository createRecord path
    // makes: a fresh events row, held in the setup-lists render surface
    // (eventsAll) exactly as useScheduleData would expose it after reload.
    const createdEvent = { id: 'ev-color-war', camp_id: 'camp-1', name: 'Color War', sort_order: null, notes: null }

    const targetSlot = { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, elective_set_id: null, event_id: null, flags: {} }
    const repo = {
      writeSlotFields: async () => ({ status: 'applied' }),
      writeActivityFields: async () => ({ status: 'applied' }),
      deleteEntity: async () => ({ status: 'applied' }),
      writeElectiveSetFields: async () => ({ status: 'applied' }),
      writeElectiveSetActivityFields: async () => ({ status: 'applied' }),
      readElectiveSetIsReusable: async () => 0,
      getElectiveSet: async () => null,
      deleteElectiveSet: async () => ({ ok: true }),
      writeDayOverrideFields: async () => ({ status: 'applied' }),
    }
    const routeState = {
      route: 'manual',
      existingTemplates: { generated: true, manual: true },
      templateId: 'tid-manual',
      setSlots: () => {},
    }

    const hook = renderHook(
      (p) => useSlotMutations(p),
      {
        initialProps: {
          routeState, repo, pushUndo: vi.fn(), setActionError: vi.fn(),
          recalcStats: vi.fn(), recalcFindings: vi.fn(), getSlot, setActivities: vi.fn(),
          slots: [targetSlot], groups: [], activities: [], days: [], timeBlocks: [], campId: 'camp-1',
          eventsAll: [createdEvent],
        },
      }
    )

    // "Place it on a cell" — the real write path a click-to-write commit in
    // CellInlineEditor triggers (handleCellPlaceEvent in ScheduleScreen.jsx).
    await act(async () => {
      await hook.result.current.placeEventOnCell('ev-color-war', { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, targetSlot)
    })

    // The resulting row, as it would come back from a real reload — this is
    // what SlotCell actually renders on screen.
    const placedRow = {
      id: 'row-target', groupId: 'g1', dayId: 'd1', blockId: 'b1',
      type: 'activity', activity_id: null, elective_set_id: null, event_id: 'ev-color-war', flags: {},
    }
    const onOpenEvent = vi.fn()

    render(
      <DndContext>
        <SlotCell
          slot={placedRow}
          eventsAll={[createdEvent]}
          onOpenEvent={onOpenEvent}
          gridRow="1 / span 1"
          gridColumn="2 / span 1"
          ariaColIndex={2}
          cellKey="g1|d1|b1"
        />
      </DndContext>
    )

    // Renders the real name, never the dangling-reference fallback.
    expect(screen.getByText('Color War')).toBeTruthy()
    expect(screen.queryByText('Event (removed)')).toBeNull()

    // The drill-in affordance calls onOpenEvent with the placed event's id.
    fireEvent.click(screen.getByRole('button', { name: 'Open Color War in Events' }))
    expect(onOpenEvent).toHaveBeenCalledWith('ev-color-war')
  })
})

// Owner, 2026-09-12: the always-visible merge chevron is gone; the drag bar is
// hidden until the cell is hovered or focused, and the keyboard path is
// Shift+Down / Shift+Up. That makes these shortcuts the ONLY keyboard way to
// merge or unmerge, so they are pinned here.
describe('Shift+Arrow merges and unmerges a cell', () => {
  const baseSlot = { id: 's1', type: 'activity', groupId: 'g1', dayId: 'd1', blockId: 'b1', flags: {} }
  const renderCell = (props) => render(
    <DndContext>
      <SlotCell slot={baseSlot} activity={{ id: 'a1', name: 'Soccer' }} {...props} />
    </DndContext>
  )

  it('Shift+Down merges when there is something below to merge into', () => {
    const onMergeDown = vi.fn()
    renderCell({ hasMergeDown: true, onMergeDown })
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'ArrowDown', shiftKey: true })
    expect(onMergeDown).toHaveBeenCalledTimes(1)
  })

  it('Shift+Down still fires on an ALREADY-merged cell — merging is repeatable', () => {
    // The regression this guards: gating on `!isMerged` allows exactly one
    // merge and then goes dead. hasMergeDown is computed from the END of the
    // current span (gridGeometry.js) precisely so a span can keep growing.
    const onMergeDown = vi.fn()
    renderCell({ hasMergeDown: true, isMerged: true, onMergeDown })
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'ArrowDown', shiftKey: true })
    expect(onMergeDown).toHaveBeenCalledTimes(1)
  })

  it('Shift+Down does nothing when there is nothing below', () => {
    const onMergeDown = vi.fn()
    renderCell({ hasMergeDown: false, onMergeDown })
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'ArrowDown', shiftKey: true })
    expect(onMergeDown).not.toHaveBeenCalled()
  })

  it('Shift+Up unmerges a merged cell', () => {
    const onSplitSlot = vi.fn()
    renderCell({ isMerged: true, onSplitSlot })
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'ArrowUp', shiftKey: true })
    expect(onSplitSlot).toHaveBeenCalledTimes(1)
  })

  it('Shift+Up does nothing on a cell that is not merged', () => {
    const onSplitSlot = vi.fn()
    renderCell({ isMerged: false, onSplitSlot })
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'ArrowUp', shiftKey: true })
    expect(onSplitSlot).not.toHaveBeenCalled()
  })

  it('a bare arrow key, with no Shift, does not merge', () => {
    const onMergeDown = vi.fn()
    renderCell({ hasMergeDown: true, onMergeDown })
    const cell = screen.getByRole('gridcell')
    cell.focus()
    fireEvent.keyDown(cell, { key: 'ArrowDown' })
    expect(onMergeDown).not.toHaveBeenCalled()
  })

  it('the merge chevron button is gone from the cell entirely', () => {
    renderCell({ hasMergeDown: true, onMergeDown: vi.fn() })
    expect(screen.queryByLabelText('Let this activity run into the next period')).toBeNull()
  })
})

// The press-scale timer. `triggerPress` sets `pressed` and schedules a 110ms
// reset. Two things were wrong with scheduling that timer and forgetting it.
//
// 1. It was re-triggerable. A second press started its own timer while the
//    first was still pending, so the FIRST timer's reset landed mid-second-press
//    and the animation visibly truncated. That is the user-facing half.
// 2. It was never cancelled on unmount, so it kept a callback pointing at a
//    setState on a component that no longer exists. In the app React 18 drops
//    that write silently, which is why it survived; under Vitest the callback
//    can outlive the jsdom environment itself and throw `window is not defined`
//    as an uncaught exception, failing a run whose tests all passed.
describe('press-scale timer lifecycle', () => {
  const renderCell = (props) => render(
    <DndContext>
      <SlotCell slot={slot} activity={{ id: 'a1', name: 'Soccer' }} {...props} />
    </DndContext>
  )
  const pressed = () =>
    document.querySelector('.cell-inner').style.transform.includes('scale(0.97)')

  it('a second press restarts the window instead of being cut short by the first', () => {
    vi.useFakeTimers()
    try {
      renderCell({})
      const cell = screen.getByRole('gridcell')

      act(() => { fireEvent.click(cell) })
      expect(pressed()).toBe(true)

      // 60ms in: still pressed, first timer still pending (fires at 110ms).
      act(() => { vi.advanceTimersByTime(60) })
      expect(pressed()).toBe(true)

      // Press again. The first timer must not be allowed to end THIS press.
      act(() => { fireEvent.click(cell) })
      expect(pressed()).toBe(true)

      // 60ms later = 120ms from press one (its timer would have fired at 110),
      // but only 60ms into press two, which should run to 170ms.
      act(() => { vi.advanceTimersByTime(60) })
      expect(pressed()).toBe(true)

      // And it does still end, on the second press's own schedule.
      act(() => { vi.advanceTimersByTime(60) })
      expect(pressed()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not run the reset after the cell has unmounted', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { unmount } = renderCell({})
      act(() => { fireEvent.click(screen.getByRole('gridcell')) })

      // Assert the timer is gone BEFORE advancing. Checking the count after
      // advancing proves nothing: running a pending timer also empties the
      // queue, so that assertion passes whether or not unmount cleaned up.
      unmount()
      expect(vi.getTimerCount()).toBe(0)

      // And nothing fires into the unmounted tree when the clock moves on.
      act(() => { vi.advanceTimersByTime(500) })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})
