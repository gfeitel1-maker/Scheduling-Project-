// @vitest-environment jsdom
//
// T56. This view is the read-only aggregate: no SlotCell, no decideCell, no
// spanning and no drag. Its drilldown grid is therefore the simplest of the
// four — every cell is rowSpan 1 — but the silent failure is identical, so its
// placement is pinned the same way.
//
// jsdom performs no layout; the clipping and collapsed-overflow predicates were
// observed in a real browser. See the ticket's closure note.
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import ScheduleActivityView from './ScheduleActivityView'
import { buildRowTracks } from '../../screens/schedule/gridTracks'

const LONG_NAME = 'Extremely Long Waterfront Activity Name That Would Clip'

const activities = [
  { id: 'a1', name: LONG_NAME, location: 'Lake', priority: 'high', is_outdoor: true },
  { id: 'a2', name: 'Soccer' },
]
const groups = [
  { id: 'g1', name: 'Alpha Group With A Long Name' },
  { id: 'g2', name: 'Bravo' },
]
const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
  { id: 'b3', name: 'Block 3', sort_order: 3, start_time: '11:00:00', end_time: '12:00:00' },
]
const slots = [
  { id: 's1', activity_id: 'a1', group_id: 'g1', day_id: 'd2', time_block_id: 'b1' },
  // Two groups doing the same activity in one cell — the aggregate this view is for.
  { id: 's2', activity_id: 'a1', group_id: 'g1', day_id: 'd1', time_block_id: 'b3' },
  { id: 's3', activity_id: 'a1', group_id: 'g2', day_id: 'd1', time_block_id: 'b3' },
  { id: 's4', activity_id: 'a2', group_id: 'g2', day_id: 'd1', time_block_id: 'b1' },
]

function renderView(extra = {}) {
  const noop = () => {}
  const { container } = render(
    <ScheduleActivityView
      activities={activities}
      groups={groups}
      days={days}
      timeBlocks={timeBlocks}
      slots={slots}
      selectedActivity="a1"
      onSelectActivity={noop}
      {...extra}
    />
  )
  return container
}

const cellAt = (container, key) => container.querySelector(`[data-cell-key="${key}"]`)

describe('ScheduleActivityView — CSS Grid conversion (T56)', () => {
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
    expect(grid.querySelectorAll('[role="columnheader"]').length).toBe(3)
    expect(grid.querySelectorAll('[role="rowheader"]').length).toBe(3)
  })

  it('places every cell explicitly by DAY index, with no spanning anywhere', () => {
    const container = renderView()

    // Block 3 / Monday: the cell that aggregates two groups.
    const both = cellAt(container, 'a1|d1|b3')
    expect(both.getAttribute('role')).toBe('gridcell')
    expect(both.style.gridRow).toBe('3 / span 1')
    expect(both.style.gridColumn).toBe('2 / span 1')
    expect(both.getAttribute('aria-colindex')).toBe('2')
    expect(both.querySelectorAll('.cell-name').length).toBe(2)

    // Tuesday of block 1 must not inherit column 2.
    const tue = cellAt(container, 'a1|d2|b1')
    expect(tue.style.gridColumn).toBe('3 / span 1')
    expect(tue.getAttribute('aria-colindex')).toBe('3')
    expect(tue.textContent).toContain('Alpha Group With A Long Name')

    // Nothing in this view ever spans.
    expect(container.querySelectorAll('[aria-rowspan]').length).toBe(0)

    const placeable = container.querySelectorAll('[role="gridcell"], [role="rowheader"], [role="columnheader"]')
    placeable.forEach(el => {
      expect(el.style.gridColumn, el.getAttribute('data-cell-key') || el.textContent).not.toBe('')
      expect(el.style.gridRow).not.toBe('')
    })
  })

  it('leaves unassigned cells empty and untinted', () => {
    const container = renderView()
    const none = cellAt(container, 'a1|d1|b2')
    expect(none.querySelectorAll('.cell-name').length).toBe(0)
    expect(none.style.borderLeft).toContain('transparent')
  })

  it('drives row tracks from buildRowTracks via --grid-rows', () => {
    const container = renderView()
    const body = container.querySelector('.schedule-grid--body')
    expect(body.style.getPropertyValue('--grid-rows'))
      .toBe(buildRowTracks({ timeBlocks, collapsedBlockIds: new Set() }))
    expect(body.style.gridTemplateColumns).toBe('140px repeat(2, minmax(0, 1fr))')
  })

  it('still renders the card grid when no activity is selected', () => {
    const container = renderView({ selectedActivity: null })
    expect(container.querySelector('[role="grid"]')).toBeNull()
    expect(container.textContent).toContain(LONG_NAME)
    expect(container.textContent).toContain('2 groups')
  })
})

// A1 (round-2 fix). M3b stopped populating activities.location for anything
// bound through the picker, so this view — which pre-M3b read only that
// free-text column — went blank for a picker-bound activity even though the
// Activities screen showed its place correctly.
describe('ScheduleActivityView — place resolution via location_id (round-2 A1)', () => {
  const withLocations = [
    { id: 'a1', name: 'Swim', location_id: 'loc-1' },
    { id: 'a2', name: 'Soccer', location_id: null, location: 'Old Field' },
    { id: 'a3', name: 'Archery', location_id: 'loc-missing' },
    { id: 'a4', name: 'Crafts', location_id: null, location: null },
  ]
  const locations = [{ id: 'loc-1', name: 'Pool' }]

  const cardFor = (container, name) =>
    [...container.querySelectorAll('.activity-card')].find(c => c.textContent.includes(name))

  it('card grid resolves location_id to the location name', () => {
    const container = renderView({ activities: withLocations, selectedActivity: null, locations })
    expect(container.textContent).toContain('Pool')
    // Name div + place div + badges wrap + stats div = 4 direct children.
    expect(cardFor(container, 'Swim').querySelectorAll(':scope > div').length).toBe(4)
  })

  // M4 §D7: the legacy free-text fallback is REMOVED. A location that is
  // later deleted clears location_id to null but never touches the frozen
  // `location` string, so keeping the fallback would show a deleted place's
  // stale name as if still assigned — a correctness fix, not just cleanup.
  it('card grid shows no place line when location_id is null, even with a legacy location string', () => {
    const container = renderView({ activities: withLocations, selectedActivity: null, locations })
    expect(container.textContent).not.toContain('Old Field')
    // No place div rendered: name + badges wrap + stats = 3 direct children.
    expect(cardFor(container, 'Soccer').querySelectorAll(':scope > div').length).toBe(3)
  })

  it('card grid renders no place line for a dangling location_id (unconstrained, not a stale id leak)', () => {
    const container = renderView({ activities: withLocations, selectedActivity: null, locations })
    const archeryCard = cardFor(container, 'Archery')
    expect(archeryCard.textContent).not.toContain('loc-missing')
    // No place div rendered: name + badges wrap + stats = 3 direct children.
    expect(archeryCard.querySelectorAll(':scope > div').length).toBe(3)
  })

  it('card grid shows no place line at all when neither location_id nor legacy location is set', () => {
    const container = renderView({ activities: withLocations, selectedActivity: null, locations })
    expect(cardFor(container, 'Crafts').querySelectorAll(':scope > div').length).toBe(3)
  })

  it('drilldown header resolves location_id to the location name', () => {
    const container = renderView({ activities: withLocations, selectedActivity: 'a1', locations })
    expect(container.textContent).toContain('Pool')
  })

  // M4 §D7: same fallback removal, drilldown header this time.
  it('drilldown header shows no place when location_id is null, even with a legacy location string', () => {
    const container = renderView({ activities: withLocations, selectedActivity: 'a2', locations })
    expect(container.textContent).not.toContain('Old Field')
  })
})

describe('ScheduleActivityView — collapse (T56 extends T55)', () => {
  const rowHeaderFor = (c, name) =>
    [...c.querySelectorAll('[role="rowheader"]')].find(h => h.textContent.includes(name))

  it('marks the collapsed row, its cells and its header', () => {
    const container = renderView({ collapsedBlockIds: new Set(['b3']) })
    expect(cellAt(container, 'a1|d1|b3').hasAttribute('data-collapsed')).toBe(true)
    expect(cellAt(container, 'a1|d2|b3').hasAttribute('data-collapsed')).toBe(true)
    expect(rowHeaderFor(container, 'Block 3').hasAttribute('data-collapsed')).toBe(true)
    expect(cellAt(container, 'a1|d1|b1').hasAttribute('data-collapsed')).toBe(false)
    expect(container.querySelector('.schedule-grid--body').style.getPropertyValue('--grid-rows'))
      .toBe('minmax(48px, auto) minmax(48px, auto) 20px')
  })

  it('toggles from the row header button and does not change DOM membership', () => {
    const toggled = []
    const container = renderView({ onToggleBlockCollapsed: id => toggled.push(id) })
    const btn = rowHeaderFor(container, 'Block 3').querySelector('.row-header-toggle')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(btn)
    expect(toggled).toEqual(['b3'])

    const keys = c => [...c.querySelectorAll('[data-cell-key]')].map(e => e.getAttribute('data-cell-key')).sort()
    expect(keys(renderView({ collapsedBlockIds: new Set(['b3']) }))).toEqual(keys(renderView()))
  })
})
