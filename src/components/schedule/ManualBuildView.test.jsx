// @vitest-environment jsdom
//
// T56. Manual build's spanning comes from getAnchorRowSpan, not decideCell, so
// its placement is asserted separately: a rowSpan > 1 ANCHOR head, the cell to
// its right, and the skipped anchor tail.
//
// jsdom performs no layout, so the clipping and collapsed-overflow predicates
// are not verifiable here — they were observed in a real browser. See the
// ticket's closure note.
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import ManualBuildView from './ManualBuildView'
import { makeGridGeometry } from '../../screens/schedule/gridGeometry'
import { buildRowTracks } from '../../screens/schedule/gridTracks'

const groups = [{ id: 'g1', name: 'Alpha', tier_id: 't1' }]
const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
  { id: 'b3', name: 'Block 3', sort_order: 3, start_time: '11:00:00', end_time: '12:00:00' },
]

const LONG_NAME = 'Extremely Long Waterfront Activity Name That Would Clip'

const slots = [
  // A two-block ANCHOR on Monday — manual build's only spanning source.
  { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', is_anchor: true, anchor_id: 'an1' },
  { id: 's2', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', is_anchor: true, anchor_id: 'an1' },
  // The cell to the anchor head's right.
  { id: 's3', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', is_anchor: false },
  // Block 3 is the NON-MERGED collapse case: different activities per column.
  { id: 's4', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'a1', is_anchor: false },
  { id: 's5', group_id: 'g1', day_id: 'd2', time_block_id: 'b3', activity_id: 'a2', is_anchor: false },
]

const actMap = new Map([
  ['a1', { id: 'a1', name: LONG_NAME }],
  ['a2', { id: 'a2', name: 'Soccer' }],
])
const anchorMap = new Map([['an1', { id: 'an1', name: 'Lunch' }]])

function renderView(extra = {}) {
  const geometry = makeGridGeometry({ slots, timeBlocks, groups })
  const noop = () => {}
  const { container } = render(
    <DndContext>
      <ManualBuildView
        groups={groups}
        days={days}
        timeBlocks={timeBlocks}
        selectedGroup="g1"
        onSelectGroup={noop}
        actMap={actMap}
        anchorMap={anchorMap}
        geometry={geometry}
        eligibleActivitiesFor={() => []}
        onPlace={noop}
        onCreateNew={noop}
        onExpandSlot={noop}
        onSplitSlot={noop}
        selectedSlotKeys={new Set()}
        pasteMode={false}
        onCellSelect={noop}
        {...extra}
      />
    </DndContext>
  )
  return container
}

const cellAt = (container, key) => container.querySelector(`[data-cell-key="${key}"]`)

describe('ManualBuildView — CSS Grid conversion (T56)', () => {
  it('renders no table markup and no rowSpan attribute', () => {
    const container = renderView()
    for (const tag of ['table', 'thead', 'tbody', 'tr', 'td', 'th']) {
      expect(container.querySelectorAll(tag).length, tag).toBe(0)
    }
    expect(container.querySelectorAll('[rowspan]').length).toBe(0)
  })

  it('renders a grid -> row -> gridcell structure with display: contents row wrappers', () => {
    const container = renderView()
    const grid = container.querySelector('[role="grid"]')
    expect(grid.getAttribute('aria-rowcount')).toBe('4')
    expect(grid.getAttribute('aria-colcount')).toBe('3')
    expect(grid.querySelectorAll(':scope > [role="rowgroup"]').length).toBe(2)
    const rows = grid.querySelectorAll('[role="row"]')
    expect(rows.length).toBe(4)
    rows.forEach(row => expect(row.style.display).toBe('contents'))
    expect([...rows].map(r => r.getAttribute('aria-rowindex'))).toEqual(['1', '2', '3', '4'])
    expect(grid.querySelectorAll('[role="rowheader"]').length).toBe(3)
  })

  it('places the anchor span head, the cell to its right and skips the anchor tail', () => {
    const container = renderView()

    const head = cellAt(container, 'g1|d1|b1')
    expect(head.getAttribute('role')).toBe('gridcell')
    expect(head.style.gridRow).toBe('1 / span 2')
    expect(head.style.gridColumn).toBe('2 / span 1')
    expect(head.getAttribute('aria-rowspan')).toBe('2')
    expect(head.textContent).toContain('Lunch')

    const right = cellAt(container, 'g1|d2|b1')
    expect(right.style.gridRow).toBe('1 / span 1')
    expect(right.style.gridColumn).toBe('3 / span 1')
    expect(right.getAttribute('aria-rowspan')).toBeNull()

    // The anchor tail produces no DOM at all.
    expect(cellAt(container, 'g1|d1|b2')).toBeNull()

    const placeable = container.querySelectorAll('[role="gridcell"], [role="rowheader"], [role="columnheader"]')
    placeable.forEach(el => {
      expect(el.style.gridColumn, el.getAttribute('data-cell-key') || el.textContent).not.toBe('')
      expect(el.style.gridRow).not.toBe('')
    })
  })

  it('renders unfilled cells as droppable placeholders, not nothing', () => {
    const container = renderView()
    const empty = cellAt(container, 'g1|d2|b2')
    expect(empty.hasAttribute('data-empty')).toBe(true)
    expect(empty.querySelector('.cell-empty')).not.toBeNull()
    expect(empty.style.gridColumn).toBe('3 / span 1')
  })

  it('T112 — a single plain click on an empty cell does NOT open the inline editor (WS5 double-click-to-edit)', () => {
    const container = renderView()
    const empty = cellAt(container, 'g1|d2|b2')
    fireEvent.click(empty)
    expect(empty.querySelector('.cell-inline-editor-input')).toBeNull()
  })

  it('T112 — double-click on an empty cell opens the inline editor', () => {
    const container = renderView()
    const empty = cellAt(container, 'g1|d2|b2')
    expect(empty.querySelector('.cell-inline-editor-input')).toBeNull()
    fireEvent.doubleClick(empty)
    expect(empty.querySelector('.cell-inline-editor-input')).not.toBeNull()
  })

  it('T112 — commit calls onPlace with the empty cell identity', () => {
    const placed = []
    const container = renderView({
      eligibleActivitiesFor: () => [{ id: 'a9', name: 'Soccer' }],
      onPlace: (slot, activityId) => placed.push([slot, activityId]),
    })
    const empty = cellAt(container, 'g1|d2|b2')
    fireEvent.doubleClick(empty)
    const input = empty.querySelector('.cell-inline-editor-input')
    fireEvent.change(input, { target: { value: 'Soccer' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(placed).toEqual([[{ groupId: 'g1', dayId: 'd2', blockId: 'b2' }, 'a9']])
  })

  it('T112 — filled-cell left-click still selects (unchanged)', () => {
    const selected = []
    const container = renderView({ onCellSelect: (slot) => selected.push(slot) })
    fireEvent.click(cellAt(container, 'g1|d2|b1'))
    expect(selected.length).toBe(1)
    expect(cellAt(container, 'g1|d2|b1').querySelector('.cell-inline-editor-input')).toBeNull()
  })

  it('T112 — filled-cell double-click opens the inline editor even though onCellSelect is wired (WS5 double-click-to-edit)', () => {
    const container = renderView({ onCellSelect: () => {} })
    fireEvent.doubleClick(cellAt(container, 'g1|d2|b1'))
    expect(cellAt(container, 'g1|d2|b1').querySelector('.cell-inline-editor-input')).not.toBeNull()
  })

  it('drives row tracks from buildRowTracks via --grid-rows', () => {
    const container = renderView()
    const body = container.querySelector('.schedule-grid--body')
    expect(body.style.getPropertyValue('--grid-rows'))
      .toBe(buildRowTracks({ timeBlocks, collapsedBlockIds: new Set() }))
    expect(body.style.gridTemplateColumns).toBe('140px repeat(2, minmax(0, 1fr))')
  })
})

describe('ManualBuildView — collapse (T56 extends T55)', () => {
  const rowHeaderFor = (c, name) =>
    [...c.querySelectorAll('[role="rowheader"]')].find(h => h.textContent.includes(name))

  it('marks the non-merged collapsed row and its header, never a cell spanning across', () => {
    const container = renderView({ collapsedBlockIds: new Set(['b3']) })
    expect(cellAt(container, 'g1|d1|b3').hasAttribute('data-collapsed')).toBe(true)
    expect(cellAt(container, 'g1|d2|b3').hasAttribute('data-collapsed')).toBe(true)
    expect(cellAt(container, 'g1|d1|b3').textContent).toContain(LONG_NAME)
    expect(cellAt(container, 'g1|d2|b3').textContent).toContain('Soccer')
    expect(rowHeaderFor(container, 'Block 3').hasAttribute('data-collapsed')).toBe(true)

    // The anchor head covering b2 keeps normal presentation when b2 collapses.
    const spanning = renderView({ collapsedBlockIds: new Set(['b2']) })
    const head = cellAt(spanning, 'g1|d1|b1')
    expect(head.getAttribute('aria-rowspan')).toBe('2')
    expect(head.hasAttribute('data-collapsed')).toBe(false)
  })

  it('does not change DOM membership when a row folds', () => {
    const open = renderView()
    const shut = renderView({ collapsedBlockIds: new Set(['b3']) })
    const keys = c => [...c.querySelectorAll('[data-cell-key]')].map(e => e.getAttribute('data-cell-key')).sort()
    expect(keys(shut)).toEqual(keys(open))
    expect(shut.querySelector('.schedule-grid--body').style.getPropertyValue('--grid-rows'))
      .toBe('minmax(48px, auto) minmax(48px, auto) 20px')
  })

  it('toggles from the header button and from anywhere in the folded strip', () => {
    const toggled = []
    const container = renderView({ onToggleBlockCollapsed: id => toggled.push(id) })
    const btn = rowHeaderFor(container, 'Block 3').querySelector('.row-header-toggle')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(btn)
    expect(toggled).toEqual(['b3'])

    const folded = []
    const shut = renderView({
      collapsedBlockIds: new Set(['b3']),
      onToggleBlockCollapsed: id => folded.push(id),
      onPlace: () => { throw new Error('a collapsed cell must re-expand, not activate inline write') },
    })
    fireEvent.click(cellAt(shut, 'g1|d1|b3'))
    expect(folded).toEqual(['b3'])
  })

  it('renders a merged activity span head once, spanning N rows, and skips its tail (T99)', () => {
    const merged = [
      ...slots.filter(s => s.id !== 's3'),
      { id: 's3', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', is_anchor: false, is_span_head: true, flags: { expanded: true } },
      { id: 's3b', group_id: 'g1', day_id: 'd2', time_block_id: 'b2', activity_id: 'a1', is_anchor: false, is_span_head: false },
    ]
    const geometry = makeGridGeometry({ slots: merged, timeBlocks, groups })
    const container = renderView({ geometry })

    const head = cellAt(container, 'g1|d2|b1')
    expect(head.getAttribute('role')).toBe('gridcell')
    expect(head.style.gridRow).toBe('1 / span 2')
    expect(head.getAttribute('aria-rowspan')).toBe('2')
    expect(head.textContent).toContain(LONG_NAME)

    // The tail is covered by the head's row span — no independent SlotCell/droppable.
    expect(cellAt(container, 'g1|d2|b2')).toBeNull()
  })

  it('derives one row-level flag dot, mounted in every row', () => {
    const flagged = [
      ...slots.filter(s => s.id !== 's5'),
      { id: 's5', group_id: 'g1', day_id: 'd2', time_block_id: 'b3', activity_id: 'a2', is_anchor: false, flags: { OVERLAP: true } },
    ]
    const geometry = makeGridGeometry({ slots: flagged, timeBlocks, groups })
    const shut = renderView({ geometry, collapsedBlockIds: new Set(['b3']) })
    const shown = [...shut.querySelectorAll('.row-flag-dot[data-collapsed][data-flag]')]
    expect(shown.length).toBe(1)
    expect(shown[0].getAttribute('data-flag')).toBe('advisory')
    expect(shut.querySelectorAll('.row-flag-dot').length).toBe(timeBlocks.length)
    expect(renderView({ geometry }).querySelectorAll('.row-flag-dot[data-collapsed]').length).toBe(0)
  })
})
