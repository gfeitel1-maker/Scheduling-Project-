import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../localClient', () => ({
  localClient: { list: vi.fn(), write: vi.fn() },
}))

import { localClient } from '../../localClient'
import { copyCampTimeBlocks } from './copyCampTimeBlocks'

const CAMP = 'c1'
const SD = 'sd1'
let n
let rows

beforeEach(() => {
  n = 0
  vi.stubGlobal('localStorage', { getItem: () => 't' })
  vi.stubGlobal('crypto', { randomUUID: () => `new-${n++}` })
  rows = {
    time_blocks: [
      { id: 'b1', camp_id: CAMP, name: 'Carpool', sort_order: 0, start_time: '08:00', end_time: '08:40' },
      { id: 'b2', camp_id: CAMP, name: 'Lunch', sort_order: 1, start_time: '12:00', end_time: '12:40' },
      { id: 'b3', camp_id: CAMP, name: 'Swim', sort_order: 2, start_time: '13:00', end_time: '13:40' },
    ],
    groups: [{ id: 'g1', camp_id: CAMP, name: 'A' }, { id: 'g2', camp_id: CAMP, name: 'B' }],
    days_of_operation: [{ id: 'mon', camp_id: CAMP, label: 'Monday', day_of_week: 1, sort_order: 0 }],
    fixed_events: [
      { id: 'f1', camp_id: CAMP, kind: 'fixed', name: 'Carpool', day_id: null, time_block_id: 'b1', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a-carpool', span_blocks: 1 },
      { id: 'f2', camp_id: CAMP, kind: 'recurring', name: 'Group Time', day_id: 'mon', time_block_id: 'b3', is_all_groups: 0, group_ids: '["g2"]', unit_ids: '[]', activity_id: 'a-gt', span_blocks: 1 },
    ],
    special_day_placements: [],
  }
  localClient.list.mockReset().mockImplementation(async (e) => rows[e] ?? [])
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
})

const slotRows = () => {
  const by = {}
  for (const c of localClient.write.mock.calls) {
    if (c[1] === 'special_day_slots') (by[c[2]] ||= {})[c[3]] = c[4]
  }
  return Object.values(by)
}

describe('copyCampTimeBlocks fixed events', () => {
  it('carries every-day fixed events into the right group and block cells', async () => {
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    const cells = slotRows()
    expect(cells).toHaveLength(2)
    expect(cells.map((c) => c.group_id).sort()).toEqual(['g1', 'g2'])
    expect(cells.every((c) => c.activity_id === 'a-carpool' && c.time_block_id === 'new-0' && c.special_day_id === SD)).toBe(true)
    expect(r.carriedCount).toBe(2)
    expect(r.placed).toBe(false)
  })

  it('carries nothing when the director picks Empty', async () => {
    await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD, withFixedEvents: false })
    expect(slotRows()).toHaveLength(0)
  })

  it('offers recurring events from the placed weekday, and places them on accept', async () => {
    rows.special_day_placements = [{ id: 'p1', week_id: 'w1', day_id: 'mon', special_day_id: SD }]
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(r.placed).toBe(true)
    expect(r.offer.count).toBe(1)
    expect(r.offer.dayLabel).toBe('Monday')
    expect(slotRows()).toHaveLength(2)
    await r.offer.apply()
    const added = slotRows().filter((c) => c.activity_id === 'a-gt')
    expect(added).toEqual([expect.objectContaining({ group_id: 'g2', time_block_id: 'new-2' })])
  })

  it('does not offer day-specific events when the special day is not placed', async () => {
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(r.offer).toBeNull()
  })
})
