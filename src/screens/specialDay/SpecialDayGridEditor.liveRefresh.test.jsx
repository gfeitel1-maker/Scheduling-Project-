// @vitest-environment jsdom
//
// Packaged audit of #911 (2026-10-11): the copy wrote all 78 cells, but the editor opened
// mid-copy showed "9 / 168 filled" and never caught up: it loaded its slots once and did not
// refresh as later writes landed. The "Lunch waves differ" note was transient state set only
// at the end of a copy, so it never showed on a schedule opened afterwards.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

const listeners = { op: new Set(), local: new Set() }

vi.mock('../../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    onOpApplied: vi.fn((cb) => { listeners.op.add(cb); return () => listeners.op.delete(cb) }),
    onLocalWrite: vi.fn((cb) => { listeners.local.add(cb); return () => listeners.local.delete(cb) }),
  },
}))

import SpecialDayGridEditor from './SpecialDayGridEditor'
import { localClient } from '../../localClient'

const CAMP_ID = 'camp-1'
const SD_ID = 'sd-1'
const DAYS = [1, 2].map((n) => ({ id: `d${n}`, camp_id: CAMP_ID, day_of_week: n, label: n === 1 ? 'Monday' : 'Tuesday' }))

let state
beforeEach(() => {
  listeners.op.clear()
  listeners.local.clear()
  vi.stubGlobal('localStorage', { getItem: () => 'token-abc', setItem: () => {}, removeItem: () => {} })
  state = {
    slots: [{ id: 's1', special_day_id: SD_ID, group_id: 'g1', time_block_id: 'tb1', activity_id: 'carpool' }],
    placements: [],
    fixedEvents: [],
  }
  localClient.list.mockReset().mockImplementation((entity) => {
    const rows = {
      special_days: [{ id: SD_ID, camp_id: CAMP_ID, name: 'Color War', notes: '' }],
      special_day_time_blocks: [{ id: 'tb1', special_day_id: SD_ID, name: '08:40-09:00', start_time: '08:40', end_time: '09:00', sort_order: 0 }],
      special_day_slots: state.slots,
      special_day_placements: state.placements,
      groups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk A' }, { id: 'g2', camp_id: CAMP_ID, name: 'Bunk B' }],
      activities: [{ id: 'carpool', camp_id: CAMP_ID, name: 'Carpool' }, { id: 'lunch2', camp_id: CAMP_ID, name: 'Lunch 2' }],
      locations: [],
      fixed_events: state.fixedEvents,
      days_of_operation: DAYS,
      time_blocks: [{ id: 'ctb1', camp_id: CAMP_ID, name: '08:40-09:00', sort_order: 0 }],
    }[entity]
    return Promise.resolve(rows ?? [])
  })
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
})

const renderEditor = () => render(
  <SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />
)

describe('special schedule editor keeps up with a copy still writing', () => {
  it('refreshes its cells when special_day_slots writes land after it opened (remote op)', async () => {
    renderEditor()
    await waitFor(() => expect(screen.getByText(/1 \/ 2 filled/)).toBeTruthy())
    state.slots = [...state.slots, { id: 's2', special_day_id: SD_ID, group_id: 'g2', time_block_id: 'tb1', activity_id: 'carpool' }]
    act(() => { for (const cb of listeners.op) cb({ entity: 'special_day_slots', entity_id: 's2', field: 'activity_id' }) })
    await waitFor(() => expect(screen.getByText(/2 \/ 2 filled/)).toBeTruthy())
  })

  it('refreshes its cells after a local write announcement (this device copying)', async () => {
    renderEditor()
    await waitFor(() => expect(screen.getByText(/1 \/ 2 filled/)).toBeTruthy())
    state.slots = [...state.slots, { id: 's2', special_day_id: SD_ID, group_id: 'g2', time_block_id: 'tb1', activity_id: 'carpool' }]
    act(() => { for (const cb of listeners.local) cb() })
    await waitFor(() => expect(screen.getByText(/2 \/ 2 filled/)).toBeTruthy())
  })

  it('a refresh never wipes notes the director is typing', async () => {
    renderEditor()
    await waitFor(() => expect(screen.getByText(/1 \/ 2 filled/)).toBeTruthy())
    const notes = screen.getByPlaceholderText(/notes/i)
    fireEvent.change(notes, { target: { value: 'Bring flags' } })
    act(() => { for (const cb of listeners.local) cb() })
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.getByPlaceholderText(/notes/i).value).toBe('Bring flags')
  })
})

describe('the weekday note is derived from data, not left over from a copy', () => {
  it('an unplaced special day whose camp has weekday-varying events shows the note on open', async () => {
    state.fixedEvents = [
      { id: 'fe1', camp_id: CAMP_ID, kind: 'fixed', name: 'Lunch 2', activity_id: 'lunch2', time_block_id: 'ctb1', day_id: 'd1', is_all_groups: 1, group_ids: '[]', schedule_week_id: null },
    ]
    renderEditor()
    expect(await screen.findByText(/Lunch waves differ by weekday/)).toBeTruthy()
  })

  it('no note once the day is placed', async () => {
    state.fixedEvents = [
      { id: 'fe1', camp_id: CAMP_ID, kind: 'fixed', name: 'Lunch 2', activity_id: 'lunch2', time_block_id: 'ctb1', day_id: 'd1', is_all_groups: 1, group_ids: '[]', schedule_week_id: null },
    ]
    state.placements = [{ id: 'p1', special_day_id: SD_ID, schedule_week_id: 'w1', day_id: 'd1' }]
    renderEditor()
    await waitFor(() => expect(screen.getByText(/1 \/ 2 filled/)).toBeTruthy())
    expect(screen.queryByText(/Lunch waves differ by weekday/)).toBeNull()
  })

  it('no note when every camp event is every-day', async () => {
    state.fixedEvents = DAYS.map((d) => ({ id: `fe-${d.id}`, camp_id: CAMP_ID, kind: 'fixed', name: 'Carpool', activity_id: 'carpool', time_block_id: 'ctb1', day_id: d.id, is_all_groups: 1, group_ids: '[]', schedule_week_id: null }))
    renderEditor()
    await waitFor(() => expect(screen.getByText(/1 \/ 2 filled/)).toBeTruthy())
    expect(screen.queryByText(/Lunch waves differ by weekday/)).toBeNull()
  })
})
