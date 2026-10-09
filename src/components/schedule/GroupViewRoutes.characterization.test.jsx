// @vitest-environment jsdom
//
// Design F4. Characterization of the two group views (Generated =
// ScheduleGroupView, Manual = ManualBuildView), written BEFORE they were moved
// onto one shared frame and required to pass unchanged after. It pins the three
// behaviours the refactor must not move: drop targets (what the drag FSM's
// resolveHit reads off the DOM: data-cell-key + data-drop-disabled), keyboard
// navigation (roving tabindex), and click handlers. Per-route differences are
// pinned too, so a refactor that "unifies" them away fails here.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import ScheduleGroupView from './ScheduleGroupView'
import ManualBuildView from './ManualBuildView'
import { makeGridGeometry } from '../../screens/schedule/gridGeometry'

const groups = [{ id: 'g1', name: 'Alpha', tier_id: 't1' }, { id: 'g2', name: 'Bravo', tier_id: 't1' }]
const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Block 2', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
  { id: 'b3', name: 'Block 3', sort_order: 3, start_time: '11:00:00', end_time: '12:00:00' },
]
const slots = [
  { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', is_fixed_event: true, fixed_event_id: 'f1' },
  { id: 's2', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', is_fixed_event: true, fixed_event_id: 'f1' },
  { id: 's3', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', is_fixed_event: false },
  { id: 's4', group_id: 'g1', day_id: 'd2', time_block_id: 'b3', activity_id: 'a2', is_fixed_event: false },
]
const actMap = new Map([['a1', { id: 'a1', name: 'Swim' }], ['a2', { id: 'a2', name: 'Soccer' }]])
const fixedEventMap = new Map([['f1', { id: 'f1', name: 'Lunch' }]])

const ROUTES = {
  generated: (props) => <ScheduleGroupView weatherMode={false} releaseCell={() => {}} {...props} />,
  manual: (props) => <ManualBuildView {...props} />,
}

function renderRoute(route, { slots: fixtureSlots = slots, actMap: fixtureActMap = actMap, ...extra } = {}) {
  const handlers = {
    onSelectGroup: vi.fn(), onCellSelect: vi.fn(), onToggleBlockCollapsed: vi.fn(),
    onPlace: vi.fn(), onCreateNew: vi.fn(),
  }
  const geometry = makeGridGeometry({ slots: fixtureSlots, timeBlocks, groups })
  const View = ROUTES[route]
  const { container, getByText, getByRole } = render(
    <DndContext>
      {View({
        groups, days, timeBlocks, selectedGroup: 'g1', actMap: fixtureActMap, fixedEventMap, geometry,
        eligibleActivitiesFor: () => [], ...handlers, ...extra,
      })}
    </DndContext>,
  )
  return { container, getByText, getByRole, handlers }
}

const cellByKey = (c, key) => c.querySelector(`[data-cell-key="${key}"]`)
const tabStop = c => [...c.querySelectorAll('[role="grid"] [tabindex="0"]')]

describe.each(['generated', 'manual'])('%s group view', route => {
  it('exposes the same drop targets to the drag FSM', () => {
    const { container } = renderRoute(route)
    const targets = [...container.querySelectorAll('[data-cell-key]')].map(el => [
      el.getAttribute('data-cell-key'),
      el.hasAttribute('data-empty') ? 'empty' : 'filled',
      el.hasAttribute('data-drop-disabled') ? 'no-drop' : 'drop',
    ])
    expect(targets).toEqual([
      ['g1|d1|b1', 'filled', 'no-drop'],
      ['g1|d2|b1', 'filled', 'drop'],
      ['g1|d2|b2', 'empty', 'drop'],
      ['g1|d1|b3', 'empty', 'drop'],
      ['g1|d2|b3', 'filled', 'drop'],
    ])
    expect(cellByKey(container, 'g1|d1|b1').getAttribute('aria-rowspan')).toBe('2')
  })

  it('keeps one roving tab stop and moves it with the arrow keys', () => {
    const { container } = renderRoute(route)
    expect(tabStop(container)).toHaveLength(1)
    const swim = cellByKey(container, 'g1|d2|b1')
    fireEvent.focus(swim)
    fireEvent.keyDown(swim, { key: 'ArrowDown' })
    expect(tabStop(container)).toEqual([cellByKey(container, 'g1|d2|b2')])
    fireEvent.keyDown(cellByKey(container, 'g1|d2|b2'), { key: 'ArrowLeft' })
    expect(tabStop(container)).toEqual([cellByKey(container, 'g1|d1|b1')])
    fireEvent.keyDown(cellByKey(container, 'g1|d1|b1'), { key: 'ArrowDown' })
    expect(tabStop(container)).toEqual([cellByKey(container, 'g1|d1|b3')])
  })

  it('routes pill, row-header, cell and double-click handlers', () => {
    const { container, getByText, handlers } = renderRoute(route)
    fireEvent.click(getByText('Bravo'))
    expect(handlers.onSelectGroup).toHaveBeenCalledWith('g2')

    fireEvent.click(container.querySelectorAll('.row-header-toggle')[1])
    expect(handlers.onToggleBlockCollapsed).toHaveBeenCalledWith('b2')

    fireEvent.click(cellByKey(container, 'g1|d2|b1'))
    expect(handlers.onCellSelect).toHaveBeenCalledTimes(1)
    expect(handlers.onCellSelect.mock.calls[0][0]).toMatchObject({ groupId: 'g1', dayId: 'd2', blockId: 'b1' })

    fireEvent.doubleClick(cellByKey(container, 'g1|d2|b2'))
    expect(cellByKey(container, 'g1|d2|b2').querySelector('input')).not.toBeNull()
  })

  it('a click on a collapsed row re-expands it instead of reaching the cell', () => {
    const { container, handlers } = renderRoute(route, { collapsedBlockIds: new Set(['b1']) })
    fireEvent.click(cellByKey(container, 'g1|d2|b1'))
    expect(handlers.onToggleBlockCollapsed).toHaveBeenCalledWith('b1')
    expect(handlers.onCellSelect).not.toHaveBeenCalled()
  })

  it('renders the same frame chrome on both routes', () => {
    const { container } = renderRoute(route)
    const pills = [...container.querySelectorAll('button')].filter(b => ['Alpha', 'Bravo'].includes(b.textContent))
    expect(pills.map(p => p.className)).toEqual(['press-98', 'press-98'])
    expect(pills[0].parentElement.style.marginBottom).toBe('16px')
    expect(container.firstChild.className).toBe('schedule-view-enter')
    expect([...container.querySelectorAll('[role="columnheader"]')].map(h => h.textContent)).toEqual(['Block', 'Mon', 'Tue'])
  })
})

describe('per-route differences that must survive the shared frame', () => {
  it('an empty cell in paste mode selects on the generated route only', () => {
    const gen = renderRoute('generated', { pasteMode: true })
    fireEvent.click(cellByKey(gen.container, 'g1|d2|b2'))
    expect(gen.handlers.onCellSelect).toHaveBeenCalledTimes(1)
    gen.container.remove()

    const man = renderRoute('manual', { pasteMode: true })
    fireEvent.click(cellByKey(man.container, 'g1|d2|b2'))
    expect(man.handlers.onCellSelect).not.toHaveBeenCalled()
  })

  it('UNFILLABLE renders on the generated route only', () => {
    const unfillable = { id: 'u1', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', is_fixed_event: false, flags: { UNFILLABLE: true } }
    const withSlot = [...slots, unfillable]
    for (const route of ['generated', 'manual']) {
      const geometry = makeGridGeometry({ slots: withSlot, timeBlocks, groups })
      const { container, unmount } = render(
        <DndContext>
          {ROUTES[route]({
            groups, days, timeBlocks, selectedGroup: 'g1', actMap, fixedEventMap, geometry,
            eligibleActivitiesFor: () => [], onSelectGroup: () => {},
          })}
        </DndContext>,
      )
      const cell = cellByKey(container, 'g1|d1|b3')
      expect(cell.hasAttribute('data-empty')).toBe(route === 'manual')
      unmount()
    }
  })
})

// Red Hat gap-closure on #793: each block below was plant-tested (the line it
// guards was broken, the test went red, the line was restored).
const swimSpan = [
  ...slots.filter(s => s.id !== 's4'),
  { id: 's5', group_id: 'g1', day_id: 'd2', time_block_id: 'b2', activity_id: 'a1', is_fixed_event: false, is_span_head: false },
]

describe.each(['generated', 'manual'])('%s group view — gap closure', route => {
  it('a merged multi-block activity renders once, with no duplicate tail cell', () => {
    const { container } = renderRoute(route, { slots: swimSpan })
    expect(container.querySelectorAll('[data-cell-key="g1|d2|b2"]')).toHaveLength(0)
    expect(cellByKey(container, 'g1|d2|b1').getAttribute('aria-rowspan')).toBe('2')
    expect([...container.querySelectorAll('[data-cell-key]')].filter(c => c.textContent.includes('Swim'))).toHaveLength(1)
  })

  it('a collapsed row writes data-collapsed, a 20px track and an armed row-flag dot', () => {
    const flagged = [...slots, { id: 'o1', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'a1', is_fixed_event: false, flags: { OVERLAP: true } }]
    const { container } = renderRoute(route, { slots: flagged, collapsedBlockIds: new Set(['b2', 'b3']) })
    expect(cellByKey(container, 'g1|d2|b3').hasAttribute('data-collapsed')).toBe(true)
    expect(cellByKey(container, 'g1|d2|b2').hasAttribute('data-collapsed')).toBe(true)
    expect(cellByKey(container, 'g1|d2|b1').hasAttribute('data-collapsed')).toBe(false)
    expect(container.querySelector('.schedule-grid--body').style.getPropertyValue('--grid-rows')).toBe('minmax(48px, auto) 20px 20px')
    const dots = container.querySelectorAll('.row-flag-dot')
    expect(dots[2].hasAttribute('data-collapsed')).toBe(true)
    expect(dots[2].getAttribute('data-flag')).toBe('advisory')
    expect(dots[0].hasAttribute('data-flag')).toBe(false)
  })

  it('OVERLAP renders its marker on this route (it derives on both since T159)', () => {
    const flagged = slots.map(s => s.id === 's3' ? { ...s, flags: { OVERLAP: true, OVERLAP_reason: 'Pool full' } } : s)
    const { container } = renderRoute(route, { slots: flagged })
    expect(cellByKey(container, 'g1|d2|b1').querySelector('.flag--overlap').getAttribute('title')).toBe('Pool full')
  })

  it('paste mode on a filled cell: double-click selects instead of opening the editor', () => {
    const { container, handlers } = renderRoute(route, { pasteMode: true })
    fireEvent.doubleClick(cellByKey(container, 'g1|d2|b1'))
    expect(handlers.onCellSelect).toHaveBeenCalledTimes(1)
    expect(cellByKey(container, 'g1|d2|b1').querySelector('input')).toBeNull()
  })
})

describe('per-route differences — gap closure', () => {
  const lockedActs = new Map([['a1', { id: 'a1', name: 'Swim', is_locked: true }], ['a2', { id: 'a2', name: 'Soccer' }]])

  it('a locked activity is not a drag/drop target on generated (click releases it); manual ignores the lock', () => {
    const releaseCell = vi.fn()
    const gen = renderRoute('generated', { actMap: lockedActs, releaseCell })
    const genCell = cellByKey(gen.container, 'g1|d2|b1')
    expect(genCell.hasAttribute('data-drop-disabled')).toBe(true)
    fireEvent.click(genCell)
    expect(releaseCell).toHaveBeenCalledWith('s3')
    expect(gen.handlers.onCellSelect).not.toHaveBeenCalled()
    gen.container.remove()

    const man = renderRoute('manual', { actMap: lockedActs })
    const manCell = cellByKey(man.container, 'g1|d2|b1')
    expect(manCell.hasAttribute('data-drop-disabled')).toBe(false)
    fireEvent.click(manCell)
    expect(man.handlers.onCellSelect).toHaveBeenCalledTimes(1)
  })

  it('the UNFILLABLE glyph and title render on generated', () => {
    const withSlot = [...slots, { id: 'u1', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', is_fixed_event: false, flags: { UNFILLABLE: true } }]
    const { container } = renderRoute('generated', { slots: withSlot })
    const flag = cellByKey(container, 'g1|d1|b3').querySelector('.flag--unfillable')
    expect(flag.getAttribute('title')).toBe('Unfillable')
    expect(flag.querySelector('svg')).not.toBeNull()
  })

  it('highlightMap lights a cell with its reason on generated; manual takes no highlight', () => {
    const highlightMap = new Map([['s3', 'Moved by Bravo']])
    const gen = renderRoute('generated', { highlightMap })
    expect(cellByKey(gen.container, 'g1|d2|b1').querySelector('.cell-reason').textContent).toBe('Moved by Bravo')
    expect(cellByKey(gen.container, 'g1|d2|b3').querySelector('.cell-reason')).toBeNull()
    gen.container.remove()

    const man = renderRoute('manual', { highlightMap })
    expect(man.container.querySelector('.cell-reason')).toBeNull()
  })
})
