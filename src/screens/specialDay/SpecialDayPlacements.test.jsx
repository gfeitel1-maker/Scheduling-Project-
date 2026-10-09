// @vitest-environment jsdom
// T350 slice 5 (docs/work/specs/T350-slice5-binding-ui.md §11).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

vi.mock('../../localClient', () => ({
  localClient: {
    list: vi.fn(),
    listPendingConflicts: vi.fn(),
    bindSpecialDay: vi.fn(),
    unbindSpecialDay: vi.fn(),
    onOpApplied: vi.fn(),
  },
}))

import SpecialDayPlacements from './SpecialDayPlacements'
import { localClient } from '../../localClient'

const CAMP = 'camp-1'
const SD = 'sd-1'
let db
let opListener

beforeEach(() => {
  db = {
    special_day_placements: [
      { id: 'p1', week_id: 'w2', day_id: 'tue', special_day_id: SD },
      { id: 'p2', week_id: 'w1', day_id: 'tue', special_day_id: 'sd-2' },
    ],
    schedule_weeks: [
      { id: 'w1', camp_id: CAMP, name: 'Week 1', sort_order: 0, is_archived: 0 },
      { id: 'w2', camp_id: CAMP, name: 'Week 2', sort_order: 1, is_archived: 0 },
    ],
    days_of_operation: [
      { id: 'mon', camp_id: CAMP, label: 'Monday', sort_order: 0 },
      { id: 'tue', camp_id: CAMP, label: 'Tuesday', sort_order: 1 },
    ],
    special_days: [
      { id: SD, camp_id: CAMP, name: 'Color War' },
      { id: 'sd-2', camp_id: CAMP, name: 'Visiting Day' },
    ],
  }
  localClient.list.mockReset().mockImplementation((e) => Promise.resolve(db[e] ? [...db[e]] : []))
  localClient.listPendingConflicts.mockReset().mockResolvedValue([])
  localClient.bindSpecialDay.mockReset().mockImplementation(async ({ weekId, dayId, specialDayId }) => {
    db.special_day_placements = [...db.special_day_placements.filter(p => !(p.week_id === weekId && p.day_id === dayId)),
      { id: `${weekId}${dayId}`, week_id: weekId, day_id: dayId, special_day_id: specialDayId }]
    return { ok: true }
  })
  localClient.unbindSpecialDay.mockReset().mockImplementation(async ({ weekId, dayId }) => {
    db.special_day_placements = db.special_day_placements.filter(p => !(p.week_id === weekId && p.day_id === dayId))
    return { ok: true }
  })
  localClient.onOpApplied.mockReset().mockImplementation((cb) => { opListener = cb; return () => {} })
})

async function mountOpen({ onDeletedElsewhere = () => {} } = {}) {
  render(<SpecialDayPlacements campId={CAMP} specialDayId={SD} specialDayName="Color War" onDeletedElsewhere={onDeletedElsewhere} />)
  await screen.findByText('Week 2 · Tue')
  fireEvent.click(screen.getByRole('button', { name: '+ Place on a day' }))
  return screen.getByRole('grid', { name: 'Days for Color War' })
}

const cell = (name) => screen.getByRole('button', { name })
const FREE_W1_MON = 'Week 1, Monday, free. Place Color War here.'
const MINE_W2_TUE = 'Week 2, Tuesday, Color War is here. Remove.'
const TAKEN_W1_TUE = 'Week 1, Tuesday, Visiting Day. Replace with Color War.'

describe('SpecialDayPlacements — strip', () => {
  it('placed nowhere shows only the dashed place button', async () => {
    db.special_day_placements = []
    render(<SpecialDayPlacements campId={CAMP} specialDayId={SD} specialDayName="Color War" />)
    const btn = await screen.findByRole('button', { name: '+ Place on a day' })
    expect(btn.style.border).toContain('dashed')
    expect(screen.queryByRole('button', { name: /^Remove from/ })).toBeNull()
  })

  it('chip x unbinds and the chip leaves after a re-read', async () => {
    render(<SpecialDayPlacements campId={CAMP} specialDayId={SD} specialDayName="Color War" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from Week 2 Tuesday' }))
    await waitFor(() => expect(screen.queryByText('Week 2 · Tue')).toBeNull())
    expect(localClient.unbindSpecialDay).toHaveBeenCalledWith({ weekId: 'w2', dayId: 'tue' })
  })

  it('chip x failure shows an alert under the strip and keeps the chip', async () => {
    localClient.unbindSpecialDay.mockResolvedValue({ ok: false, reason: 'boom' })
    render(<SpecialDayPlacements campId={CAMP} specialDayId={SD} specialDayName="Color War" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from Week 2 Tuesday' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not remove Color War from Week 2 Tuesday.')
    expect(screen.getByText('Week 2 · Tue')).toBeTruthy()
  })

  it('a bronze dot marks a chip whose placement has an unresolved conflict', async () => {
    localClient.listPendingConflicts.mockResolvedValue([
      { entity: 'special_day_placements', entity_id: 'p1', existingOp: { value: SD }, incomingOp: { value: 'sd-2' } },
    ])
    render(<SpecialDayPlacements campId={CAMP} specialDayId={SD} specialDayName="Color War" />)
    expect(await screen.findByTitle('Color War or Visiting Day')).toBeTruthy()
  })
})

describe('SpecialDayPlacements — the day grid', () => {
  it('free cell binds with replace:false and shows the new chip', async () => {
    await mountOpen()
    fireEvent.click(cell(FREE_W1_MON))
    await screen.findByText('Week 1 · Mon')
    expect(localClient.bindSpecialDay).toHaveBeenCalledWith({ weekId: 'w1', dayId: 'mon', specialDayId: SD, replace: false })
  })

  it('mine cell unbinds without confirmation', async () => {
    await mountOpen()
    fireEvent.click(cell(MINE_W2_TUE))
    await waitFor(() => expect(localClient.unbindSpecialDay).toHaveBeenCalledWith({ weekId: 'w2', dayId: 'tue' }))
  })

  it('taken cell asks once, naming the undo, and binds only on confirm', async () => {
    await mountOpen()
    fireEvent.click(cell(TAKEN_W1_TUE))
    const group = screen.getByRole('group', { name: 'Confirm replace' })
    expect(group.textContent).toContain('Week 1 Tuesday already uses Visiting Day. Use Color War instead?')
    expect(group.textContent).toContain('(Visiting Day stays saved; bind it again to undo.)')
    expect(localClient.bindSpecialDay).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: 'Use Color War' })
    expect(document.activeElement).toBe(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(localClient.bindSpecialDay).toHaveBeenCalledWith({ weekId: 'w1', dayId: 'tue', specialDayId: SD, replace: true }))
  })

  it('Cancel and Escape dismiss the prompt and call nothing', async () => {
    await mountOpen()
    fireEvent.click(cell(TAKEN_W1_TUE))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Confirm replace' })).toBeNull()
    fireEvent.click(cell(TAKEN_W1_TUE))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Use Color War' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Confirm replace' })).toBeNull()
    expect(localClient.bindSpecialDay).not.toHaveBeenCalled()
  })

  it('an occupied refusal on a free-looking cell opens the same prompt naming the occupant', async () => {
    localClient.bindSpecialDay.mockResolvedValueOnce({ ok: false, reason: 'occupied', currentSpecialDayId: 'sd-2' })
    await mountOpen()
    fireEvent.click(cell(FREE_W1_MON))
    const group = await screen.findByRole('group', { name: 'Confirm replace' })
    expect(group.textContent).toContain('Week 1 Monday already uses Visiting Day.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a double click on a free cell issues one call', async () => {
    let resolve
    localClient.bindSpecialDay.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    await mountOpen()
    fireEvent.click(cell(FREE_W1_MON))
    fireEvent.click(cell(FREE_W1_MON))
    expect(localClient.bindSpecialDay).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ ok: true }))
  })
})

describe('SpecialDayPlacements — failures', () => {
  it.each([
    ['unknown-week', 'That week no longer exists.'],
    ['unknown-day', "That day is no longer in this camp's schedule."],
    ['weird', 'Could not place Color War on Week 1 Monday.'],
  ])('{ok:false, reason:%s} renders the line under the grid, adds no chip, re-reads first', async (reason, msg) => {
    localClient.bindSpecialDay.mockResolvedValue({ ok: false, reason })
    await mountOpen()
    const listsBefore = localClient.list.mock.calls.length
    fireEvent.click(cell(FREE_W1_MON))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(msg)
    expect(localClient.list.mock.calls.length).toBeGreaterThan(listsBefore)
    expect(screen.queryByText('Week 1 · Mon')).toBeNull()
  })

  it('a thrown error shows the line, and Try again re-runs the same call', async () => {
    localClient.bindSpecialDay.mockRejectedValueOnce(new Error('kaboom'))
    await mountOpen()
    fireEvent.click(cell(FREE_W1_MON))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not place Color War on Week 1 Monday.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Week 1 · Mon')
    expect(localClient.bindSpecialDay).toHaveBeenCalledTimes(2)
    expect(localClient.bindSpecialDay.mock.calls[1][0]).toEqual({ weekId: 'w1', dayId: 'mon', specialDayId: SD, replace: false })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('unknown-special-day routes to onDeletedElsewhere, not an inline line', async () => {
    localClient.bindSpecialDay.mockResolvedValue({ ok: false, reason: 'unknown-special-day' })
    const onDeletedElsewhere = vi.fn()
    await mountOpen({ onDeletedElsewhere })
    fireEvent.click(cell(FREE_W1_MON))
    await waitFor(() => expect(onDeletedElsewhere).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('SpecialDayPlacements — live and accessibility', () => {
  it('a placement op from another device updates the grid and clears a stale pending replace', async () => {
    await mountOpen()
    fireEvent.click(cell(TAKEN_W1_TUE))
    db.special_day_placements = db.special_day_placements.filter(p => p.id !== 'p2')
    await act(async () => { opListener({ entity: 'special_day_placements', entity_id: 'p2' }) })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Confirm replace' })).toBeNull())
    expect(cell('Week 1, Tuesday, free. Place Color War here.')).toBeTruthy()
  })

  it('one tab stop, arrow keys rove, Escape closes and returns focus', async () => {
    const grid = await mountOpen()
    const buttons = [...grid.querySelectorAll('button')]
    expect(buttons.filter(b => b.tabIndex === 0)).toHaveLength(1)
    buttons[0].focus()
    fireEvent.keyDown(buttons[0], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[1])
    fireEvent.keyDown(buttons[1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons[3])
    fireEvent.keyDown(buttons[3], { key: 'Home' })
    expect(document.activeElement).toBe(buttons[2])
    fireEvent.keyDown(buttons[2], { key: 'Escape' })
    expect(screen.queryByRole('grid')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+ Place on a day' }))
  })

  it('the open panel turns the place button into Done with aria-expanded', async () => {
    await mountOpen()
    const done = screen.getByRole('button', { name: 'Done' })
    expect(done.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(done)
    expect(screen.queryByRole('grid')).toBeNull()
  })
})
