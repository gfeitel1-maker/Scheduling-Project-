// @vitest-environment jsdom
//
// T54. These assertions exist because the CSS Grid failure mode is SILENT: a
// grid child with no explicit grid-column stacks in column 1 and nothing
// throws, and a dropped role="row" wrapper degrades the accessibility tree
// without any visible symptom. Both are asserted here on a fixture that
// carries a rowSpan > 1 head, the cell immediately to its right, a skipped
// tail, an empty cell and an overlay.
//
// What this file CANNOT verify, by construction: jsdom performs no layout, so
// scrollWidth/clientWidth are always 0 and the "zero clipped cells" predicate
// must be observed against the running app. Likewise the real Chromium
// accessibility tree. See the ticket's closure note.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import ScheduleGroupView from './ScheduleGroupView'
import { makeGridGeometry } from '../../screens/schedule/gridGeometry'
import { buildRowTracks } from '../../screens/schedule/gridTracks'

const groups = [{ id: 'g1', name: 'Alpha', tier_id: 't1' }]
const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
  { id: 'b3', name: 'Block 3', sort_order: 3, start_time: '11:00:00', end_time: '12:00:00' },
]

// A long name on purpose: this is the cell the no-clipping predicate is about.
const LONG_NAME = 'Extremely Long Waterfront Activity Name That Would Clip'

const slots = [
  // Spanning head: b1 -> b2 on Monday.
  { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_anchor: false },
  { id: 's2', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'a1', is_anchor: false, is_span_head: false },
  // The cell immediately to the head's right.
  { id: 's3', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a2', is_anchor: false },
]

const overlays = [
  { id: 'o1', unit_id: 't1', day_id: 'd2', from_block_order: 3, to_block_order: 3, label: 'Field trip' },
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
        onExpandSlot={noop}
        onSplitSlot={noop}
        isExpandDragActive={false}
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

describe('ScheduleGroupView — CSS Grid conversion (T54)', () => {
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
    expect(grid).not.toBeNull()
    expect(grid.getAttribute('aria-rowcount')).toBe('4') // header + 3 blocks
    expect(grid.getAttribute('aria-colcount')).toBe('3') // row header + 2 days

    const rowgroups = grid.querySelectorAll(':scope > [role="rowgroup"]')
    expect(rowgroups.length).toBe(2)

    const rows = grid.querySelectorAll('[role="row"]')
    expect(rows.length).toBe(4)
    rows.forEach(row => {
      // The one explicitly unverified ADR assumption. `display: contents` must
      // be present or the cells are not direct grid items and placement is
      // silently wrong.
      expect(row.style.display).toBe('contents')
      expect(row.getAttribute('aria-rowindex')).not.toBeNull()
    })
    expect([...rows].map(r => r.getAttribute('aria-rowindex'))).toEqual(['1', '2', '3', '4'])

    // Every non-header cell is a gridcell; the header row uses columnheader
    // and each body row leads with a rowheader.
    expect(grid.querySelectorAll('[role="columnheader"]').length).toBe(3)
    expect(grid.querySelectorAll('[role="rowheader"]').length).toBe(3)
    expect(grid.querySelectorAll('[role="gridcell"]').length).toBeGreaterThan(0)
  })

  it('places every cell with an explicit grid-column, including a span head and the cell to its right', () => {
    const container = renderView()

    // Spanning head: block index 0, day index 0, rowSpan 2.
    const head = cellAt(container, 'g1|d1|b1')
    // A DRAGGABLE cell: dnd-kit's attributes carry role="button" and must not
    // be allowed to displace role="gridcell". Observed doing exactly that.
    expect(head.getAttribute('role')).toBe('gridcell')
    expect(head.getAttribute('aria-roledescription')).toBe('draggable')
    expect(head.style.gridRow).toBe('1 / span 2')
    expect(head.style.gridColumn).toBe('2 / span 1')
    expect(head.getAttribute('aria-rowspan')).toBe('2')
    expect(head.getAttribute('aria-colindex')).toBe('2')

    // The cell immediately to its right must NOT inherit column 2.
    const right = cellAt(container, 'g1|d2|b1')
    expect(right.style.gridRow).toBe('1 / span 1')
    expect(right.style.gridColumn).toBe('3 / span 1')
    expect(right.getAttribute('aria-rowspan')).toBeNull()
    expect(right.getAttribute('aria-colindex')).toBe('3')

    // Not one cell in the grid may be missing an explicit placement.
    const placeable = container.querySelectorAll('[role="gridcell"], [role="rowheader"], [role="columnheader"]')
    expect(placeable.length).toBeGreaterThan(0)
    placeable.forEach(el => {
      expect(el.style.gridColumn, el.getAttribute('data-cell-key') || el.textContent).not.toBe('')
      expect(el.style.gridRow).not.toBe('')
    })
  })

  it('renders one element for a spanned activity and none for the block it covers', () => {
    const container = renderView()
    expect(cellAt(container, 'g1|d1|b1')).not.toBeNull()
    // The tail (decideCell -> { kind: 'skip' }) must produce no DOM at all.
    expect(cellAt(container, 'g1|d1|b2')).toBeNull()
    expect(container.querySelectorAll(`[data-cell-key="g1|d1|b1"]`).length).toBe(1)
  })

  it('renders the overlay as one placed gridcell', () => {
    const container = renderView()
    const overlay = cellAt(container, 'g1|d2|b3')
    expect(overlay.getAttribute('role')).toBe('gridcell')
    expect(overlay.style.gridRow).toBe('3 / span 1')
    expect(overlay.style.gridColumn).toBe('3 / span 1')
    expect(overlay.textContent).toContain('Field trip')
  })

  it('renders empty cells as visible placeholders, not nothing', () => {
    const container = renderView()
    const empty = cellAt(container, 'g1|d1|b3')
    expect(empty.hasAttribute('data-empty')).toBe(true)
    expect(empty.querySelector('.cell-empty')).not.toBeNull()
    expect(empty.textContent.trim()).not.toBe('')
  })

  it('drives row track geometry from buildRowTracks via --grid-rows', () => {
    const container = renderView()
    const body = container.querySelector('.schedule-grid--body')
    expect(body.style.getPropertyValue('--grid-rows'))
      .toBe(buildRowTracks({ timeBlocks, collapsedBlockIds: new Set() }))
    expect(body.style.gridTemplateColumns).toBe('140px repeat(2, minmax(0, 1fr))')
  })

  it('carries the class vocabulary the stylesheet targets', () => {
    const container = renderView()
    for (const cls of ['.schedule-grid', '.cell', '.cell-name', '.row-header', '.block-name', '.block-time', '.identity-dot', '.expand-handle']) {
      expect(container.querySelectorAll(cls).length, cls).toBeGreaterThan(0)
    }
  })

  it('does not attach cell hover handlers in the gridcell branch', () => {
    // The §6 payoff: hover is a CSS selector, so the long activity name is
    // rendered with no ellipsis clamp and no pointer-enter state to re-render.
    const container = renderView()
    const head = cellAt(container, 'g1|d1|b1')
    const name = head.querySelector('.cell-name')
    expect(name.textContent).toContain(LONG_NAME)
    expect(name.style.whiteSpace).toBe('')
    expect(name.style.textOverflow).toBe('')
  })
})

// T55 — collapse. Collapse is two concerns: the TRACK (--grid-rows on the
// container) and the CONTENT PRESENTATION (data-collapsed on the row's cells).
// What jsdom CAN verify is exactly that contract's wiring — which attribute and
// which custom property are written, and that DOM membership does not move.
// What it CANNOT verify is the visual result: jsdom performs no layout, so
// scrollHeight/clientHeight are always 0 and the "zero overflowing cells"
// predicate — including the Block 2 non-merged fixture — was observed in a real
// browser instead. See the ticket's closure note.
describe('ScheduleGroupView — collapse (T55)', () => {
  const keys = c => [...c.querySelectorAll('[data-cell-key]')].map(e => e.getAttribute('data-cell-key')).sort()
  const rowHeaderFor = (c, name) =>
    [...c.querySelectorAll('[role="rowheader"]')].find(h => h.textContent.includes(name))

  it('writes the collapsed track to --grid-rows and nothing else about the geometry', () => {
    const container = renderView({ collapsedBlockIds: new Set(['b2']) })
    const body = container.querySelector('.schedule-grid--body')
    const tracks = body.style.getPropertyValue('--grid-rows')
    expect(tracks).toBe(buildRowTracks({ timeBlocks, collapsedBlockIds: new Set(['b2']) }))
    // Never `auto` for a collapsed track: content would re-expand the row and
    // defeat the collapse. The middle track is the literal COLLAPSED_TRACK.
    expect(tracks).toBe('minmax(48px, auto) 20px minmax(48px, auto)')
  })

  it('marks only the collapsed row, and never a cell that merely SPANS ACROSS it', () => {
    const container = renderView({ collapsedBlockIds: new Set(['b2']) })

    // d2|b2 is an empty cell whose head block IS b2 -> collapsed presentation.
    expect(cellAt(container, 'g1|d2|b2').hasAttribute('data-collapsed')).toBe(true)
    // The row header collapses in step — the table mockup left it out and it
    // read as misaligned.
    expect(rowHeaderFor(container, 'Block 2').hasAttribute('data-collapsed')).toBe(true)

    // g1|d1|b1 is the head of a span COVERING b2. It gets shorter (grid sums
    // the tracks) but keeps normal presentation.
    const spanning = cellAt(container, 'g1|d1|b1')
    expect(spanning.getAttribute('aria-rowspan')).toBe('2')
    expect(spanning.hasAttribute('data-collapsed')).toBe(false)
    // ...and rows 1 and 3 are untouched.
    expect(cellAt(container, 'g1|d2|b1').hasAttribute('data-collapsed')).toBe(false)
    expect(cellAt(container, 'g1|d2|b3').hasAttribute('data-collapsed')).toBe(false)
    expect(rowHeaderFor(container, 'Block 1').hasAttribute('data-collapsed')).toBe(false)
  })

  it('does not change DOM membership, focusability or accessible names', () => {
    const open = renderView()
    const shut = renderView({ collapsedBlockIds: new Set(['b2']) })

    expect(keys(shut)).toEqual(keys(open))
    expect(shut.querySelectorAll('[role="gridcell"]').length)
      .toBe(open.querySelectorAll('[role="gridcell"]').length)
    // A collapsed row is visually condensed, never hidden.
    expect(shut.querySelectorAll('[aria-hidden="true"][role]').length).toBe(0)
    expect(shut.querySelectorAll('[role="gridcell"][aria-hidden]').length).toBe(0)
    // Accessible name and drag affordance survive.
    const head = cellAt(shut, 'g1|d1|b1')
    expect(head.getAttribute('title')).toBe(LONG_NAME)
    expect(head.getAttribute('aria-roledescription')).toBe('draggable')
    expect(head.getAttribute('role')).toBe('gridcell')
    // The expand handle is still mounted (display:none is a style, not an unmount).
    expect(shut.querySelectorAll('.expand-handle').length)
      .toBe(open.querySelectorAll('.expand-handle').length)
  })

  it('exposes the toggle as a button with aria-expanded — the WCAG 2.5.8 equivalent mechanism', () => {
    const toggled = []
    const container = renderView({ onToggleBlockCollapsed: id => toggled.push(id) })
    const btn = rowHeaderFor(container, 'Block 2').querySelector('.row-header-toggle')

    // A real <button>: Enter and Space are the platform's, not ours to reimplement.
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(btn.textContent).toContain('Block 2')

    fireEvent.click(btn)
    expect(toggled).toEqual(['b2'])
  })

  it('reports aria-expanded=false and makes the whole strip the re-expand target', () => {
    const toggled = []
    const container = renderView({
      collapsedBlockIds: new Set(['b2']),
      onToggleBlockCollapsed: id => toggled.push(id),
      onEditSlot: () => { throw new Error('a collapsed cell must re-expand, not open its editor') },
    })
    expect(rowHeaderFor(container, 'Block 2').querySelector('.row-header-toggle')
      .getAttribute('aria-expanded')).toBe('false')

    // Clicking anywhere in the folded row re-expands it: the strip is ~1000x20,
    // so the accepted target-size shortfall is height-only.
    fireEvent.click(cellAt(container, 'g1|d2|b2'))
    expect(toggled).toEqual(['b2'])
  })

  it('derives one row-level flag dot, in the right token colour, and only when collapsed', () => {
    const flagged = [
      ...slots,
      { id: 's4', group_id: 'g1', day_id: 'd2', time_block_id: 'b2', activity_id: 'a2', is_anchor: false, flags: { OVERLAP: true } },
    ]
    const geometry = makeGridGeometry({ slots: flagged, timeBlocks, groups, overlays, fillState: null })

    const shut = renderView({ geometry, collapsedBlockIds: new Set(['b2']) })
    const shown = [...shut.querySelectorAll('.row-flag-dot[data-collapsed][data-flag]')]
    expect(shown.length).toBe(1)
    expect(shown[0].getAttribute('data-flag')).toBe('advisory') // -> var(--accent)
    expect(shown[0].getAttribute('aria-hidden')).toBe('true')

    // UNFILLABLE outranks OVERLAP: one dot, danger.
    const unfillable = [
      ...slots,
      { id: 's4', group_id: 'g1', day_id: 'd2', time_block_id: 'b2', is_anchor: false, flags: { UNFILLABLE: true } },
    ]
    const shut2 = renderView({
      geometry: makeGridGeometry({ slots: unfillable, timeBlocks, groups, overlays, fillState: null }),
      collapsedBlockIds: new Set(['b2']),
    })
    const shown2 = [...shut2.querySelectorAll('.row-flag-dot[data-collapsed][data-flag]')]
    expect(shown2.length).toBe(1)
    expect(shown2[0].getAttribute('data-flag')).toBe('unfillable')

    // A collapsed row with no flagged cell carries no dot to show...
    expect(shut.querySelector('.row-flag-dot[data-collapsed][data-flag="unfillable"]')).toBeNull()
    // ...and the dot element is mounted in EVERY row either way, so toggling
    // collapse never adds or removes DOM.
    expect(shut.querySelectorAll('.row-flag-dot').length).toBe(timeBlocks.length)
    expect(renderView({ geometry }).querySelectorAll('.row-flag-dot[data-collapsed]').length).toBe(0)
  })

  it('dims the collapsed label with the token, never with opacity', () => {
    // Measured, not stylistic: --text-secondary #5C6670 on --bg #F4F3EF is
    // 2.51:1 at the mockup's 0.62 opacity — under even the 3:1 large-text
    // floor, at the smallest type in the app. Only opacity 1 (5.27:1) passes.
    const css = readFileSync(resolve('src/components/schedule/scheduleGrid.css'), 'utf8')
    const collapsedRules = css
      .split('}')
      .filter(rule => /\[data-collapsed\][^{]*\{/.test(rule) && /cell-name|block-name/.test(rule.split('{')[0]))
    expect(collapsedRules.length).toBeGreaterThan(0)
    for (const rule of collapsedRules) {
      expect(rule, rule).not.toMatch(/(^|[^-])opacity\s*:/)
    }
    // And no animation: collapse is an instant track-height change.
    for (const rule of css.split('}').filter(r => /\[data-collapsed\]/.test(r))) {
      expect(rule, rule).not.toMatch(/transition\s*:|animation\s*:/)
    }
  })
})
