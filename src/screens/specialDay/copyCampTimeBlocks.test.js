import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../localClient', () => ({
  localClient: { list: vi.fn(), write: vi.fn(), deleteEntity: vi.fn(), copySpecialDayBlocks: vi.fn() },
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
  localClient.write.mockReset()
  localClient.deleteEntity.mockReset()
  // Mirrors electron/ops/copySpecialDayBlocks.js (tested for real there): all or nothing, an
  // occupied cell is kept and reported, an existing empty row is filled in place.
  localClient.copySpecialDayBlocks.mockReset().mockImplementation(async ({ specialDayId, blocks, cells }) => {
    if (failWhen(blocks, cells)) return { ok: false, reason: 'failed' }
    const actName = new Map(rows.activities.map((a) => [a.id, a.name]))
    let cellsWritten = 0
    const skipped = []
    for (const c of cells) {
      const row = rows.special_day_slots.find((x) => x.special_day_id === specialDayId && x.group_id === c.groupId && x.time_block_id === c.blockId)
      if (row?.activity_id) {
        if (row.activity_id !== c.activityId) skipped.push(`${actName.get(row.activity_id)} kept in ${c.groupName} ${c.blockLabel} — ${c.eventName} not added there`)
        continue
      }
      if (row) row.activity_id = c.activityId
      else rows.special_day_slots.push({ id: `slot-${rows.special_day_slots.length}`, special_day_id: specialDayId, group_id: c.groupId, time_block_id: c.blockId, activity_id: c.activityId })
      cellsWritten += 1
    }
    return { ok: true, blocksWritten: blocks.length, cellsWritten, skipped }
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

  it('a copy is ONE IPC call carrying every block and cell, and no per-field writes', async () => {
    await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    expect(localClient.copySpecialDayBlocks).toHaveBeenCalledTimes(1)
    const [{ specialDayId, blocks, cells }] = localClient.copySpecialDayBlocks.mock.calls[0]
    expect(specialDayId).toBe(SD)
    expect(blocks).toEqual([
      { id: 'new-0', name: 'Carpool', sort_order: 0, start_time: '08:00', end_time: '08:40' },
      { id: 'new-1', name: 'Lunch', sort_order: 1, start_time: '12:00', end_time: '12:40' },
      { id: 'new-2', name: 'Swim', sort_order: 2, start_time: '13:00', end_time: '13:40' },
    ])
    expect(cells.map((c) => [c.groupId, c.blockId, c.activityId])).toEqual([['g1', 'new-0', 'a-carpool'], ['g2', 'new-0', 'a-carpool']])
    expect(localClient.write).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('Bring is also ONE call, with the cells and no blocks', async () => {
    place()
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    await r.offer.apply()
    expect(localClient.copySpecialDayBlocks).toHaveBeenCalledTimes(2)
    const [{ blocks, cells }] = localClient.copySpecialDayBlocks.mock.calls[1]
    expect(blocks).toEqual([])
    expect(cells.map((c) => [c.groupId, c.blockId, c.activityId])).toEqual([['g2', 'new-2', 'a-gt']])
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('a refused copy throws with nothing copied, so the caller can say so', async () => {
    failWhen = () => true
    const err = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.seededCount).toBe(0)
    expect(err.totalCount).toBe(3)
    expect(rows.special_day_slots).toEqual([])
  })

  it('apply() reports a failure, writes nothing, and can be retried without duplicates', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    place()
    const r = await copyCampTimeBlocks({ campId: CAMP, specialDayId: SD })
    failWhen = () => true
    const first = await r.offer.apply()
    expect(first).toEqual({ written: 0, failure: "Couldn't add those events \u2014 nothing was added, try again", notice: null })
    expect(log).toHaveBeenCalled()
    failWhen = () => false
    const second = await r.offer.apply()
    expect(second).toEqual({ written: 1, failure: null, notice: null })
    expect(rows.special_day_slots.filter((s) => s.time_block_id === 'new-2')).toHaveLength(1)
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
