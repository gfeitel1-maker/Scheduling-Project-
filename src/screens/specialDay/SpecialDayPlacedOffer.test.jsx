// @vitest-environment jsdom
// Placing a special day on a weekday opens that weekday's "Also bring" offer on its own,
// every event ticked; Bring places only the ticked ones; Skip dismisses.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../localClient', () => ({
  localClient: {
    list: vi.fn(), write: vi.fn(), deleteEntity: vi.fn(), copySpecialDayBlocks: vi.fn(), listPendingConflicts: vi.fn(),
    bindSpecialDay: vi.fn(), unbindSpecialDay: vi.fn(), onOpApplied: vi.fn(() => () => {}),
  },
}))

import SpecialDayGridEditor from './SpecialDayGridEditor'
import { localClient } from '../../localClient'

const CAMP = 'camp-1'
const SD = 'sd-1'
let db

const lunch = (id, name, groupId, blockId, day = 'mon') => ({
  id, camp_id: CAMP, kind: 'recurring', name, day_id: day, time_block_id: blockId,
  is_all_groups: 0, group_ids: `["${groupId}"]`, unit_ids: '[]', activity_id: `a-${id}`, span_blocks: 1,
})

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 't' })
  db = {
    special_days: [{ id: SD, camp_id: CAMP, name: 'Color War' }],
    special_day_time_blocks: [
      { id: 'sb1', special_day_id: SD, name: 'Lunch A', sort_order: 0 },
      { id: 'sb2', special_day_id: SD, name: 'Lunch B', sort_order: 1 },
    ],
    time_blocks: [
      { id: 'cb1', camp_id: CAMP, name: 'Lunch A', sort_order: 0 },
      { id: 'cb2', camp_id: CAMP, name: 'Lunch B', sort_order: 1 },
    ],
    groups: [{ id: 'g1', camp_id: CAMP, name: 'Badger 1' }, { id: 'g2', camp_id: CAMP, name: 'Weasel 1' }],
    activities: [{ id: 'a-f2', name: 'Lunch 2' }, { id: 'a-f3', name: 'Lunch 3' }],
    days_of_operation: [
      { id: 'mon', camp_id: CAMP, label: 'Monday', sort_order: 0 },
      { id: 'tue', camp_id: CAMP, label: 'Tuesday', sort_order: 1 },
    ],
    schedule_weeks: [{ id: 'w1', camp_id: CAMP, name: 'Week 1', sort_order: 0, is_archived: 0 }],
    fixed_events: [lunch('f2', 'Lunch 2', 'g1', 'cb1'), lunch('f3', 'Lunch 3', 'g2', 'cb2')],
    special_day_placements: [],
    special_day_slots: [],
    locations: [],
  }
  let n = 0
  vi.stubGlobal('crypto', { randomUUID: () => `new-${n++}` })
  localClient.list.mockReset().mockImplementation((e) => Promise.resolve(db[e] ? [...db[e]] : []))
  localClient.listPendingConflicts.mockReset().mockResolvedValue([])
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.copySpecialDayBlocks.mockReset().mockImplementation(async ({ specialDayId, cells }) => {
    for (const c of cells) {
      db.special_day_slots.push({ id: `s${db.special_day_slots.length}`, special_day_id: specialDayId, group_id: c.groupId, time_block_id: c.blockId, activity_id: c.activityId })
    }
    return { ok: true, blocksWritten: 0, cellsWritten: cells.length, skipped: [] }
  })
  localClient.bindSpecialDay.mockReset().mockImplementation(async ({ weekId, dayId, specialDayId }) => {
    db.special_day_placements = [{ id: 'p1', week_id: weekId, day_id: dayId, special_day_id: specialDayId }]
    return { ok: true }
  })
})

async function placeOnMonday() {
  render(<SpecialDayGridEditor campId={CAMP} specialDayId={SD} onBack={() => {}} onDeletedElsewhere={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '+ Place on a day' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Week 1, Monday, free. Place Color War here.' }))
  await screen.findByText('Also bring 2 recurring events from Monday?')
}

const placed = () => db.special_day_slots.filter((s) => s.activity_id).map((s) => s.activity_id).sort()

describe('placing a special day opens the weekday offer', () => {
  it('auto-opens with every event ticked, and Bring places them into their own groups', async () => {
    await placeOnMonday()
    expect(screen.getByRole('checkbox', { name: 'Lunch 2' }).checked).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Lunch 3' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Bring' }))
    await waitFor(() => expect(placed()).toEqual(['a-f2', 'a-f3']))
    const byGroup = Object.fromEntries(db.special_day_slots.map((s) => [s.activity_id, s.group_id]))
    expect(byGroup).toEqual({ 'a-f2': 'g1', 'a-f3': 'g2' })
    await waitFor(() => expect(screen.queryByText(/Also bring/)).toBeNull())
  })

  it('leaves an unticked event out', async () => {
    await placeOnMonday()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lunch 3' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bring' }))
    await waitFor(() => expect(placed()).toEqual(['a-f2']))
  })

  it('Skip dismisses without writing', async () => {
    await placeOnMonday()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(screen.queryByText(/Also bring/)).toBeNull())
    expect(placed()).toEqual([])
  })
})
