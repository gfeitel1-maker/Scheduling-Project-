import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../localClient', () => ({
  localClient: { list: vi.fn(), write: vi.fn(), deleteEntity: vi.fn() },
}))

import { localClient } from '../../localClient'
import { copyCampTimeBlocks } from './copyCampTimeBlocks'

const CAMP = 'c1'
const SD = 'sd1'
let n
let rows
let failWhen

beforeEach(() => {
  n = 0
  failWhen = () => false
  vi.stubGlobal('localStorage', { getItem: () => 't' })
  vi.stubGlobal('crypto', { randomUUID: () => `new-${n++}` })
  rows = {
    time_blocks: [
      { id: 'b1', camp_id: CAMP, name: 'Carpool', sort_order: 0, start_time: '08:00', end_time: '08:40' },
      { id: 'b2', camp_id: CAMP, name: 'Lunch', sort_order: 1, start_time: '12:00', end_time: '12:40' },
      { id: 'b3', camp_id: CAMP, name: 'Swim', sort_order: 2, start_time: '13:00', end_time: '13:40' },
    ],
    groups: [{ id: 'g1', camp_id: CAMP, name: 'Badger 2' }, { id: 'g2', camp_id: CAMP, name: 'B' }],
    days_of_operation: [
      { id: 'mon', camp_id: CAMP, label: 'Monday', day_of_week: 1, sort_order: 0 },
      { id: 'tue', camp_id: CAMP, label: 'Tuesday', day_of_week: 2, sort_order: 1 },
    ],
    activities: [
      { id: 'a-carpool', name: 'Carpool' }, { id: 'a-lunch', name: 'Lunch' }, { id: 'a-gt', name: 'Group Time' },
      { id: 'a-swim', name: 'Swim' }, { id: 'a-x', name: 'Extra' },
    ],
    special_days: [{ id: SD, camp_id: CAMP, name: 'Color War' }],
    fixed_events: [
      { id: 'f1', camp_id: CAMP, kind: 'fixed', name: 'Carpool', day_id: null, time_block_id: 'b1', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a-carpool', span_blocks: 1 },
      { id: 'f2', camp_id: CAMP, kind: 'recurring', name: 'Group Time', day_id: 'mon', time_block_id: 'b3', is_all_groups: 0, group_ids: '["g2"]', unit_ids: '[]', activity_id: 'a-gt', span_blocks: 1 },
    ],
    special_day_placements: [],
    special_day_slots: [],
  }
  localClient.list.mockReset().mockImplementation(async (e) => rows[e] ?? [])
  localClient.write.mockReset().mockImplementation(async (_t, entity, id, field, value) => {
    if (failWhen(entity, id, field, value)) return { status: 'rejected' }
    if (entity === 'special_day_slots') {
      let row = rows.special_day_slots.find((s) => s.id === id)
      if (!row) { row = { id }; rows.special_day_slots.push(row) }
      row[field] = value
    }
    return { status: 'applied' }
  })
  localClient.deleteEntity.mockReset().mockImplementation(async (_t, entity, id) => {
    if (entity === 'special_day_slots') rows.special_day_slots = rows.special_day_slots.filter((s) => s.id !== id)
    return { status: 'applied' }
  })
})

const place = () => { rows.special_day_placements = [{ id: 'p1', week_id: 'w1', day_id: 'mon', special_day_id: SD }] }
const filled = () => rows.special_day_slots.filter((s) => s.activity_id)

describe('copyCampTimeBlocks fixed events', () => {
  it('carries every-day fixed events into the right group and block cells', async () => {
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    const cells = filled()
    expect(cells).toHaveLength(2)
    expect(cells.map((c) => c.group_id).sort()).toEqual(['g1', 'g2'])
    expect(cells.every((c) => c.activity_id === 'a-carpool' && c.time_block_id === 'new-0' && c.special_day_id === SD)).toBe(true)
    expect(r.carriedCount).toBe(2)
    expect(r.placed).toBe(false)
  })

  describe('camp-wide events stored as per-day rows (what an import writes)', () => {
    const perDay = (id, day, extra = {}) => ({ id, camp_id: CAMP, kind: 'fixed', name: 'Carpool', day_id: day, time_block_id: 'b1', is_all_groups: 1, group_ids: '[]', unit_ids: null, activity_id: 'a-carpool', span_blocks: null, ...extra })
    beforeEach(() => {
      rows.fixed_events = [perDay('p-mon', 'mon'), perDay('p-tue', 'tue'), perDay('only-mon', 'mon', { name: 'Swim', time_block_id: 'b3', activity_id: 'a-swim' })]
    })

    it('carries an event present on every operating day when the special day is unplaced', async () => {
      const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
      expect(filled().map((c) => c.group_id).sort()).toEqual(['g1', 'g2'])
      expect(filled().every((c) => c.activity_id === 'a-carpool')).toBe(true)
      expect(r.carriedCount).toBe(2)
    })

    it('carries the placed weekday rows once, and does not carry an event that is not on every day', async () => {
      place()
      const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
      expect(r.carriedCount).toBe(2)
      expect(filled().every((c) => c.activity_id === 'a-carpool')).toBe(true)
      expect(r.offer.count).toBe(1)
    })

    it('does not carry an event missing from one operating day', async () => {
      rows.fixed_events = [perDay('p-mon', 'mon')]
      const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
      expect(r.carriedCount).toBe(0)
    })
  })

  it('offers recurring events from the placed weekday, and places them on accept', async () => {
    place()
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(r.placed).toBe(true)
    expect(r.offer.count).toBe(1)
    expect(r.offer.dayLabel).toBe('Monday')
    expect(filled()).toHaveLength(2)
    const done = await r.offer.apply()
    expect(done).toEqual({ written: 1, failure: null, notice: null })
    expect(filled().filter((c) => c.activity_id === 'a-gt')).toEqual([expect.objectContaining({ group_id: 'g2', time_block_id: 'new-2' })])
  })

  it('does not offer day-specific events when the special day is not placed', async () => {
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(r.offer).toBeNull()
  })

  it('offers nothing and says why when the placements span different weekdays', async () => {
    rows.special_day_placements = [
      { id: 'p1', week_id: 'w1', day_id: 'mon', special_day_id: SD },
      { id: 'p2', week_id: 'w1', day_id: 'tue', special_day_id: SD },
    ]
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(r.offer).toBeNull()
    expect(r.notice).toBe("This special day is on Monday and Tuesday, so recurring events aren't offered. Add them by hand.")
  })

  it('fills every spanned block for a multi-block event', async () => {
    rows.fixed_events = [{ ...rows.fixed_events[0], time_block_id: 'b1', span_blocks: 2 }]
    await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect([...new Set(filled().map((c) => c.time_block_id))].sort()).toEqual(['new-0', 'new-1'])
    expect(filled()).toHaveLength(4)
  })

  it('clips a span that runs past the last block', async () => {
    rows.fixed_events = [{ ...rows.fixed_events[0], time_block_id: 'b3', span_blocks: 3 }]
    await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(filled().map((c) => c.time_block_id)).toEqual(['new-2', 'new-2'])
  })
})

describe('copyCampTimeBlocks write safety', () => {
  it('Bring after a manual placement keeps the manual cell, writes no second row, and says so', async () => {
    place()
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    rows.special_day_slots.push({ id: 'manual', special_day_id: SD, group_id: 'g2', time_block_id: 'new-2', activity_id: 'a-swim' })
    const done = await r.offer.apply()
    expect(done.written).toBe(0)
    expect(done.notice).toBe('Swim kept in B Swim (1:00–1:40 PM) — Group Time not added there')
    expect(rows.special_day_slots.filter((s) => s.group_id === 'g2' && s.time_block_id === 'new-2')).toHaveLength(1)
  })

  it('fills an existing empty row instead of adding a second one', async () => {
    place()
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    rows.special_day_slots.push({ id: 'empty', special_day_id: SD, group_id: 'g2', time_block_id: 'new-2' })
    await r.offer.apply()
    expect(rows.special_day_slots.filter((s) => s.group_id === 'g2' && s.time_block_id === 'new-2')).toEqual([
      expect.objectContaining({ id: 'empty', activity_id: 'a-gt' }),
    ])
  })

  it('two offered events on one cell write one row; the second is reported as kept out', async () => {
    place()
    rows.fixed_events.push({ id: 'f3', camp_id: CAMP, kind: 'recurring', name: 'Extra', day_id: 'mon', time_block_id: 'b3', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a-x', span_blocks: 1 })
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    const done = await r.offer.apply()
    expect(rows.special_day_slots.filter((s) => s.group_id === 'g2' && s.time_block_id === 'new-2')).toHaveLength(1)
    expect(done.notice).toContain('kept in B Swim')
  })

  it('a partial failure names only the event that failed and keeps the one that landed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    rows.fixed_events.push({ id: 'f9', camp_id: CAMP, kind: 'fixed', name: 'Lunch', day_id: null, time_block_id: 'b2', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a-lunch', span_blocks: 1 })
    failWhen = (entity, _id, field, value) => entity === 'special_day_slots' && field === 'activity_id' && value === 'a-lunch'
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(r.cellFailure).toBe("Blocks copied; couldn't add Lunch — add them by hand or try again")
    expect(r.carriedCount).toBe(2)
    expect(log).toHaveBeenCalled()
    expect(rows.special_day_slots.filter((s) => !s.activity_id)).toHaveLength(0)
    log.mockRestore()
  })

  it('apply() reports a failure with the partial count and can be retried without duplicates', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    place()
    rows.fixed_events[1] = { ...rows.fixed_events[1], is_all_groups: 1, group_ids: '[]' }
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    let calls = 0
    failWhen = (entity, _id, field) => entity === 'special_day_slots' && field === 'activity_id' && ++calls === 2
    const first = await r.offer.apply()
    expect(first.written).toBe(1)
    expect(first.failure).toBe("Added 1 cell; couldn't add Group Time — try again")
    failWhen = () => false
    const second = await r.offer.apply()
    expect(second).toEqual({ written: 1, failure: null, notice: null })
    expect(rows.special_day_slots.filter((s) => s.time_block_id === 'new-2')).toHaveLength(2)
    log.mockRestore()
  })

  it('logs a cleanup-delete failure with context', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    failWhen = (entity, _id, field) => entity === 'special_day_slots' && field === 'activity_id'
    localClient.deleteEntity.mockRejectedValue(new Error('boom'))
    await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(log.mock.calls.some((c) => String(c[0]).includes('cleanup'))).toBe(true)
    log.mockRestore()
  })

  it('apply() refuses when the special day was deleted meanwhile', async () => {
    place()
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    rows.special_days = []
    const done = await r.offer.apply()
    expect(done.failure).toBe('This special day was deleted.')
    expect(filled().filter((c) => c.activity_id === 'a-gt')).toHaveLength(0)
  })
})
