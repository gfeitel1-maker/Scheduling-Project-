// @vitest-environment jsdom
//
// T350 slice 4 (docs/work/specs/T350-slice4-replaced-day-render.md): a day
// bound to a special day renders as the special day's read-only lane, the same
// on both routes and in all three views.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import ScheduleGroupView from './ScheduleGroupView'
import ManualBuildView from './ManualBuildView'
import ScheduleDayView from './ScheduleDayView'
import ScheduleActivityView from './ScheduleActivityView'
import { makeGridGeometry } from '../../screens/schedule/gridGeometry'
import { columnTracks } from '../../screens/schedule/gridTracks'

const groups = [{ id: 'g1', name: 'Alpha', tier_id: 't1' }, { id: 'g2', name: 'Bravo', tier_id: 't1' }]
const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
]
// d2 still holds normal-day rows: they stay in storage, hidden.
const slots = [
  { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', is_fixed_event: false },
  { id: 's2', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a2', is_fixed_event: false },
]
const actMap = new Map([['a1', { id: 'a1', name: 'Swim' }], ['a2', { id: 'a2', name: 'Soccer' }], ['a3', { id: 'a3', name: 'Relay' }]])
const activities = [...actMap.values()]

const colorWar = {
  dayId: 'd2', specialDayId: 'sd1', name: 'Color War Championship Finals', notes: 'White shirts', conflictTitle: null,
  blocks: [
    { id: 'x1', name: 'Opening', start_time: '08:30:00', end_time: '09:00:00' },
    { id: 'x2', name: 'Games', start_time: '09:00:00', end_time: '11:30:00' },
    { id: 'x3', name: 'Rally', start_time: '11:30:00', end_time: '12:00:00' },
  ],
  slots: [{ group_id: 'g1', time_block_id: 'x2', activity_id: 'a3' }, { group_id: 'g2', time_block_id: 'x1', activity_id: null, label: 'Cheer' }],
}
const replacementsOf = (...rs) => new Map(rs.map(r => [r.dayId, r]))

function renderView(route, view, { replacements = replacementsOf(colorWar), selectedDay = 'd2', ...extra } = {}) {
  const onOpenSpecialDay = vi.fn()
  const geometry = makeGridGeometry({ slots, timeBlocks, groups })
  const common = { groups, days, timeBlocks, actMap, fixedEventMap: new Map(), geometry, replacements, onOpenSpecialDay, eligibleActivitiesFor: () => [], ...extra }
  let el
  if (view === 'group') {
    el = route === 'manual'
      ? <ManualBuildView {...common} selectedGroup="g1" onSelectGroup={() => {}} />
      : <ScheduleGroupView {...common} selectedGroup="g1" onSelectGroup={() => {}} weatherMode={false} releaseCell={() => {}} />
  } else if (view === 'day') {
    el = <ScheduleDayView {...common} selectedDay={selectedDay} onSelectDay={() => {}} weatherMode={false} releaseCell={() => {}} />
  } else {
    el = <ScheduleActivityView {...common} activities={activities} slots={slots} selectedActivity="a1" onSelectActivity={() => {}} />
  }
  const utils = render(<DndContext>{el}</DndContext>)
  return { ...utils, onOpenSpecialDay }
}

const lane = c => c.querySelector('.replaced-lane')
const laneRows = c => [...c.querySelectorAll('.replaced-lane-row')].map(r => r.textContent)

describe.each(['generated', 'manual'])('%s route', route => {
  it('group view: the replaced day is one read-only lane of the special day, normal cells hidden', () => {
    const { container, onOpenSpecialDay } = renderView(route, 'group')
    const l = lane(container)
    expect(l.getAttribute('role')).toBe('gridcell')
    expect(l.getAttribute('aria-rowspan')).toBe('2')
    expect(l.style.getPropertyValue('--lane-rows')).toBe('3')
    expect(laneRows(container)).toEqual(['08:30-09:00', '09:00-11:30Relay', '11:30-12:00'])
    expect(container.querySelector('.replaced-lane-notes').textContent).toBe('White shirts')
    expect(container.querySelector('[data-cell-key="g1|d2|b1"]')).toBeNull()
    expect(container.textContent).not.toContain('Soccer')
    expect(container.querySelector('[data-cell-key="g1|d1|b1"]')).not.toBeNull()

    const header = container.querySelector('[role="columnheader"][data-replaced]')
    expect(header.textContent).toContain('Tue')
    const name = header.querySelector('button.lane-open')
    expect(name.textContent).toBe(colorWar.name)
    expect(name.getAttribute('title')).toBe(colorWar.name)
    fireEvent.click(name)
    expect(onOpenSpecialDay).toHaveBeenCalledWith('sd1')
  })

  it('drop is disabled on the replaced day: three-segment key, data-drop-disabled', () => {
    const { container } = renderView(route, 'group')
    const l = lane(container)
    expect(l.getAttribute('data-cell-key')).toBe('g1|d2|replaced')
    expect(l.hasAttribute('data-drop-disabled')).toBe(true)
    expect(l.hasAttribute('data-paste-target')).toBe(false)
    expect(l.querySelector('[data-cell-key]')).toBeNull()
  })

  // The spec's identity dot is not drawn: the owner took the activity colour
  // dot off the grid (2026-09-12). An activity is a .cell-name; free text is not.
  it('an activity cell is a cell name; a free-text cell is plain text', () => {
    const { container } = renderView(route, 'day')
    const relay = [...container.querySelectorAll('.replaced-cell')].find(c => c.textContent === 'Relay')
    const cheer = [...container.querySelectorAll('.replaced-cell')].find(c => c.textContent === 'Cheer')
    expect(relay.querySelector('.cell-name')).not.toBeNull()
    expect(cheer.querySelector('.cell-name')).toBeNull()
    expect(container.querySelector('.identity-dot')).toBeNull()
  })
})

describe('day view on a replaced day', () => {
  it('rows are the special blocks, no collapse toggles, name in the corner, notes as the last row', () => {
    const { container } = renderView('generated', 'day')
    const frame = container.querySelector('[role="grid"]')
    expect(frame.hasAttribute('data-replaced')).toBe(true)
    const rowHeaders = [...container.querySelectorAll('[role="rowheader"]')].map(h => h.textContent)
    expect(rowHeaders).toEqual(['Opening08:30–09:00', 'Games09:00–11:30', 'Rally11:30–12:00', 'Notes'])
    expect(container.querySelector('.row-header-toggle')).toBeNull()
    expect(container.querySelector('[role="columnheader"] button.lane-open').textContent).toBe(colorWar.name)
    expect(container.querySelectorAll('[data-drop-disabled][data-cell-key$="|replaced"]').length).toBe(groups.length * 3)
    expect(container.textContent).not.toContain('Soccer')
  })

  it('the replaced day pill carries the special day name; a normal pill does not', () => {
    const { container } = renderView('generated', 'day', { selectedDay: 'd1' })
    const pills = [...container.querySelectorAll('.day-pill')]
    expect(pills[0].hasAttribute('data-replaced')).toBe(false)
    expect(pills[0].querySelector('.day-pill-name')).toBeNull()
    expect(pills[1].hasAttribute('data-replaced')).toBe(true)
    expect(pills[1].querySelector('.day-pill-name').textContent).toBe(colorWar.name)
    // a normal selected day keeps its normal grid
    expect(container.querySelector('.replaced-lane-row, [data-cell-key$="|replaced"]')).toBeNull()
  })
})

describe('activity view on a replaced day', () => {
  it('the replaced column is a lane with the name only and no cells', () => {
    const { container } = renderView('generated', 'activity')
    const l = lane(container)
    expect(l.getAttribute('data-cell-key')).toBe('a1|d2|replaced')
    expect(l.textContent).toBe('')
    expect(container.querySelector('[data-cell-key="a1|d2|b1"]')).toBeNull()
    expect(container.querySelector('[role="columnheader"][data-replaced] button.lane-open').textContent).toBe(colorWar.name)
  })
})

describe('empty lane (special day has no blocks)', () => {
  it.each(['group', 'activity'])('%s view: one dashed box labelled with the name, which opens it', view => {
    const empty = { ...colorWar, blocks: [], slots: [], notes: '' }
    const { container, onOpenSpecialDay } = renderView('generated', view, { replacements: replacementsOf(empty) })
    const l = lane(container)
    expect(l.hasAttribute('data-empty-lane')).toBe(true)
    const box = l.querySelector('.cell-empty')
    expect(box.textContent).toBe(colorWar.name)
    fireEvent.click(box)
    expect(onOpenSpecialDay).toHaveBeenCalledWith('sd1')
  })

  it('day view: the body is the same dashed box, no row header', () => {
    const empty = { ...colorWar, blocks: [], slots: [], notes: '' }
    const { container } = renderView('generated', 'day', { replacements: replacementsOf(empty) })
    expect(container.querySelector('[role="rowheader"]')).toBeNull()
    expect(container.querySelector('[data-empty-lane] .cell-empty').textContent).toBe(colorWar.name)
  })
})

describe('every day replaced', () => {
  const both = () => replacementsOf({ ...colorWar, dayId: 'd1', specialDayId: 'sd0', name: 'Visiting Day' }, colorWar)

  it.each(['generated', 'manual'])('%s group view drops the row-header column; every column is a lane', route => {
    const { container } = renderView(route, 'group', { replacements: both() })
    expect(container.querySelector('[role="grid"]').hasAttribute('data-all-replaced')).toBe(true)
    expect(container.querySelector('.row-header')).toBeNull()
    expect(container.querySelectorAll('.replaced-lane').length).toBe(2)
    expect(container.querySelector('.schedule-grid--body').style.gridTemplateColumns).toBe(columnTracks(2, { rowHeader: false }))
  })

  it('activity view too', () => {
    const { container } = renderView('generated', 'activity', { replacements: both() })
    expect(container.querySelector('[role="grid"]').hasAttribute('data-all-replaced')).toBe(true)
    expect(container.querySelectorAll('.replaced-lane').length).toBe(2)
  })
})

describe('binding conflict', () => {
  it('a bronze dot on the header and the pill, titled with both names', () => {
    const conflicted = { ...colorWar, conflictTitle: 'Color War or Visiting Day' }
    const g = renderView('generated', 'group', { replacements: replacementsOf(conflicted) })
    const header = g.container.querySelector('[role="columnheader"][data-replaced]')
    expect(header.hasAttribute('data-placement-conflict')).toBe(true)
    expect(header.querySelector('.flag--placement-conflict').getAttribute('title')).toBe('Color War or Visiting Day')
    g.unmount()
    const d = renderView('generated', 'day', { replacements: replacementsOf(conflicted) })
    const pill = d.container.querySelectorAll('.day-pill')[1]
    expect(pill.hasAttribute('data-placement-conflict')).toBe(true)
    expect(pill.querySelector('.flag--placement-conflict')).not.toBeNull()
  })
})
