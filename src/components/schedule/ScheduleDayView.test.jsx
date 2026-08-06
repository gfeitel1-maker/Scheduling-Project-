// @vitest-environment jsdom
//
// T56. The CSS Grid failure mode is SILENT: a grid child with no explicit
// grid-column stacks in column 1 and nothing throws. This view is the one where
// that is most likely to go wrong, because ITS COLUMNS ARE GROUPS, not days —
// the fixture below therefore has two groups and asserts the GROUP index lands
// in the column line, plus a rowSpan > 1 head.
//
// What this file CANNOT verify, by construction: jsdom performs no layout, so
// scrollWidth/clientWidth and scrollHeight/clientHeight are always 0 and the
// clipping/overflow predicates must be observed against a real browser. See the
// ticket's closure note.
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import ScheduleDayView from './ScheduleDayView'
import { makeGridGeometry } from '../../screens/schedule/gridGeometry'
import { buildRowTracks } from '../../screens/schedule/gridTracks'

const groups = [
  { id: 'g1', name: 'Alpha', tier_id: 't1' },
  { id: 'g2', name: 'Bravo', tier_id: 't1' },
]
const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
  { id: 'b3', name: 'Block 3', sort_order: 3, start_time: '11:00:00', end_time: '12:00:00' },
  { id: 'b4', name: 'Block 4', sort_order: 4, start_time: '12:00:00', end_time: '13:00:00' },
]

const LONG_NAME = 'Extremely Long Waterfront Activity Name That Would Clip'

const slots = [
  // Spanning head in the SECOND group column: b1 -> b2 on Monday.
  { id: 's1', group_id: 'g2', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: false },
  { id: 's2', group_id: 'g2', day_id: 'd1', time_block_id: 'b2', activity_id: 'a1', is_anchor: false, is_span_head: false },
  // Non-merged neighbours: different activities in the two columns of block 3.
  { id: 's3', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a2', is_anchor: false },
  { id: 's4', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'a2', is_anchor: false },
  { id: 's5', group_id: 'g2', day_id: 'd1', time_block_id: 'b3', activity_id: 'a1', is_anchor: false },
]

const overlays = [
  { id: 'o1', unit_id: 't1', day_id: 'd1', from_block_order: 4, to_block_order: 4, label: 'Field trip' },
]

const actMap = new Map([
  ['a1', { id: 'a1', name: LONG_NAME }],
  ['a2', { id: 'a2', name: 'Soccer' }],
])

function renderView(extra = {}) {
  const geometry = makeGridGeometry({ slots, timeBlocks, groups, overlays, fillState: null })
  const noop = () => {}
  const { container } = render(
    <DndContext>
      <ScheduleDayView
        groups={groups}
        days={days}
        timeBlocks={timeBlocks}
        selectedDay="d1"
        onSelectDay={noop}
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
        isExpandDragActive={false}
        {...extra}
      />
    </DndContext>
  )
  return container
}

const cellAt = (container, key) => container.querySelector(`[data-cell-key="${key}"]`)

describe('ScheduleDayView — CSS Grid conversion (T56)', () => {
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
    expect(grid.getAttribute('aria-rowcount')).toBe('5') // header + 4 blocks
    expect(grid.getAttribute('aria-colcount')).toBe('3') // row header + 2 GROUPS

    expect(grid.querySelectorAll(':scope > [role="rowgroup"]').length).toBe(2)
    const rows = grid.querySelectorAll('[role="row"]')
    expect(rows.length).toBe(5)
    rows.forEach(row => expect(row.style.display).toBe('contents'))
    expect([...rows].map(r => r.getAttribute('aria-rowindex'))).toEqual(['1', '2', '3', '4', '5'])
    expect(grid.querySelectorAll('[role="columnheader"]').length).toBe(3)
    expect(grid.querySelectorAll('[role="rowheader"]').length).toBe(4)
  })

  it('places cells by GROUP index, including a rowSpan > 1 head', () => {
    const container = renderView()

    // g2 is the second group -> column line 3. Block 1 -> row line 1, span 2.
    const head = cellAt(container, 'g2|d1|b1')
    expect(head.getAttribute('role')).toBe('gridcell')
    expect(head.style.gridRow).toBe('1 / span 2')
    expect(head.style.gridColumn).toBe('3 / span 1')
    expect(head.getAttribute('aria-rowspan')).toBe('2')
    expect(head.getAttribute('aria-colindex')).toBe('3')

    // g1, same block, must NOT inherit the head's column.
    const first = cellAt(container, 'g1|d1|b1')
    expect(first.style.gridRow).toBe('1 / span 1')
    expect(first.style.gridColumn).toBe('2 / span 1')
    expect(first.getAttribute('aria-colindex')).toBe('2')

    // The tail block produces no DOM at all.
    expect(cellAt(container, 'g2|d1|b2')).toBeNull()

    // Not one cell may be missing an explicit placement.
    const placeable = container.querySelectorAll('[role="gridcell"], [role="rowheader"], [role="columnheader"]')
    placeable.forEach(el => {
      expect(el.style.gridColumn, el.getAttribute('data-cell-key') || el.textContent).not.toBe('')
      expect(el.style.gridRow).not.toBe('')
    })
  })

  it('renders the overlay and the empty cell as placed gridcells', () => {
    const container = renderView()
    const overlay = cellAt(container, 'g1|d1|b4')
    expect(overlay.getAttribute('role')).toBe('gridcell')
    expect(overlay.style.gridRow).toBe('4 / span 1')
    expect(overlay.style.gridColumn).toBe('2 / span 1')
    expect(overlay.textContent).toContain('Field trip')
  })

  it('drives row tracks from buildRowTracks and keeps the view own minWidth', () => {
    const container = renderView()
    const body = container.querySelector('.schedule-grid--body')
    expect(body.style.getPropertyValue('--grid-rows'))
      .toBe(buildRowTracks({ timeBlocks, collapsedBlockIds: new Set() }))
    expect(body.style.gridTemplateColumns).toBe('140px repeat(2, minmax(0, 1fr))')
    // 140 + groups.length * 130, unchanged from the table it replaces.
    expect(container.querySelector('.schedule-grid-frame').style.getPropertyValue('--frame-min-width'))
      .toBe('400px')
  })
})

describe('ScheduleDayView — collapse (T56 extends T55)', () => {
  const rowHeaderFor = (c, name) =>
    [...c.querySelectorAll('[role="rowheader"]')].find(h => h.textContent.includes(name))

  it('marks the collapsed row and its header, and never a cell that SPANS ACROSS it', () => {
    // Block 3 is the NON-MERGED case: two group columns holding DIFFERENT
    // activities, not the merged Lunch row every mockup used.
    const container = renderView({ collapsedBlockIds: new Set(['b3']) })
    expect(cellAt(container, 'g1|d1|b3').hasAttribute('data-collapsed')).toBe(true)
    expect(cellAt(container, 'g2|d1|b3').hasAttribute('data-collapsed')).toBe(true)
    expect(cellAt(container, 'g1|d1|b3').textContent).toContain('Soccer')
    expect(cellAt(container, 'g2|d1|b3').textContent).toContain(LONG_NAME)
    expect(rowHeaderFor(container, 'Block 3').hasAttribute('data-collapsed')).toBe(true)

    // The b1 -> b2 span head keeps normal presentation when b2 collapses.
    const spanning = renderView({ collapsedBlockIds: new Set(['b2']) })
    const head = cellAt(spanning, 'g2|d1|b1')
    expect(head.getAttribute('aria-rowspan')).toBe('2')
    expect(head.hasAttribute('data-collapsed')).toBe(false)
  })

  it('writes the collapsed track and does not change DOM membership', () => {
    const open = renderView()
    const shut = renderView({ collapsedBlockIds: new Set(['b3']) })
    const keys = c => [...c.querySelectorAll('[data-cell-key]')].map(e => e.getAttribute('data-cell-key')).sort()
    expect(keys(shut)).toEqual(keys(open))
    expect(shut.querySelector('.schedule-grid--body').style.getPropertyValue('--grid-rows'))
      .toBe('minmax(48px, auto) minmax(48px, auto) 20px minmax(48px, auto)')
  })

  it('toggles from the row header button and from anywhere in the folded strip', () => {
    const toggled = []
    const container = renderView({ onToggleBlockCollapsed: id => toggled.push(id) })
    const btn = rowHeaderFor(container, 'Block 3').querySelector('.row-header-toggle')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(btn)
    expect(toggled).toEqual(['b3'])

    const folded = []
    const shut = renderView({
      collapsedBlockIds: new Set(['b3']),
      onToggleBlockCollapsed: id => folded.push(id),
      onEditSlot: () => { throw new Error('a collapsed cell must re-expand, not open its editor') },
    })
    fireEvent.click(cellAt(shut, 'g1|d1|b3'))
    expect(folded).toEqual(['b3'])
  })

  it('derives one row-level flag dot per row, scanned across GROUPS', () => {
    const flagged = [
      ...slots.filter(s => s.id !== 's4'),
      { id: 's4', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'a2', is_anchor: false, flags: { UNFILLABLE: true } },
    ]
    const geometry = makeGridGeometry({ slots: flagged, timeBlocks, groups, overlays, fillState: null })
    const shut = renderView({ geometry, collapsedBlockIds: new Set(['b3']) })
    const shown = [...shut.querySelectorAll('.row-flag-dot[data-collapsed][data-flag]')]
    expect(shown.length).toBe(1)
    expect(shown[0].getAttribute('data-flag')).toBe('unfillable')
    expect(shown[0].getAttribute('aria-hidden')).toBe('true')
    // Mounted in every row either way, so collapsing never adds or removes DOM.
    expect(shut.querySelectorAll('.row-flag-dot').length).toBe(timeBlocks.length)
    expect(renderView({ geometry }).querySelectorAll('.row-flag-dot[data-collapsed]').length).toBe(0)
  })
})
