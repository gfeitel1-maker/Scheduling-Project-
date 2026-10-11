// @vitest-environment node
//
// The special-day copy as ONE main-process write: every block and every fixed-event cell lands in a
// single runAtomic (one SQLite transaction, one deferred Automerge flush), or none do.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { copySpecialDayBlocks } from './copySpecialDayBlocks.js'

afterAll(() => cleanupTemplatedDbs())

const actor = { author_user_id: 'user-1', device_id: 'device-1' }
let db
let file

beforeEach(() => {
  ;({ db, file } = openTemplatedDb())
  db.prepare("INSERT INTO camps (id, name) VALUES ('camp-1', 'Camp')").run()
  db.prepare("INSERT INTO devices (id, name) VALUES ('device-1', 'D')").run()
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('user-1', 'camp-1', 'A', 'h', 's', 'staff')").run()
  db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd-1', 'camp-1', 'Color War')").run()
  for (const g of ['g1', 'g2', 'g3']) db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(g, 'camp-1', `Group ${g}`)
  for (const a of ['a-carpool', 'a-swim']) db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(a, 'camp-1', a === 'a-swim' ? 'Swim' : 'Carpool')
})

afterEach(() => {
  db.close()
  if (file && fs.existsSync(file)) fs.unlinkSync(file)
})

const blocks = [
  { id: 'nb1', name: 'Carpool', sort_order: 0, start_time: '08:00', end_time: '08:40' },
  { id: 'nb2', name: 'Swim', sort_order: 1, start_time: null, end_time: null },
]
const cell = (groupId, blockId, extra = {}) => ({ groupId, blockId, activityId: 'a-carpool', groupName: `Group ${groupId}`, blockLabel: 'Carpool', eventName: 'Carpool', ...extra })
const run = (args) => copySpecialDayBlocks(db, { specialDayId: 'sd-1', blocks, cells: [], ...args }, actor)
const dayBlocks = () => db.prepare("SELECT id, name, sort_order, start_time, end_time FROM special_day_time_blocks WHERE special_day_id = 'sd-1' ORDER BY sort_order").all()
const daySlots = () => db.prepare("SELECT group_id, time_block_id, activity_id, location_id FROM special_day_slots WHERE special_day_id = 'sd-1' ORDER BY group_id, time_block_id").all()
const opsFor = (entity) => db.prepare('SELECT entity_id, field, source FROM operations WHERE entity = ? ORDER BY seq').all(entity)

describe('copySpecialDayBlocks', () => {
  it('writes the blocks and the cells and reports the counts', () => {
    const r = run({ cells: [cell('g1', 'nb1'), cell('g2', 'nb1'), cell('g1', 'nb2', { activityId: 'a-swim' })] })
    expect(r).toMatchObject({ ok: true, blocksWritten: 2, cellsWritten: 3, skipped: [] })
    expect(dayBlocks()).toEqual([
      { id: 'nb1', name: 'Carpool', sort_order: 0, start_time: '08:00', end_time: '08:40' },
      { id: 'nb2', name: 'Swim', sort_order: 1, start_time: null, end_time: null },
    ])
    expect(daySlots()).toEqual([
      { group_id: 'g1', time_block_id: 'nb1', activity_id: 'a-carpool', location_id: null },
      { group_id: 'g1', time_block_id: 'nb2', activity_id: 'a-swim', location_id: null },
      { group_id: 'g2', time_block_id: 'nb1', activity_id: 'a-carpool', location_id: null },
    ])
  })

  it('a failure mid-batch leaves no block and no cell for the day, and no op-log rows', () => {
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON special_day_slots WHEN NEW.group_id = 'g3' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    expect(() => run({ cells: [cell('g1', 'nb1'), cell('g2', 'nb1'), cell('g3', 'nb1')] })).toThrow('boom')
    expect(dayBlocks()).toEqual([])
    expect(daySlots()).toEqual([])
    expect(opsFor('special_day_slots')).toEqual([])
    expect(opsFor('special_day_time_blocks')).toEqual([])
  })

  it('skips a cell that already holds an activity and says which one was kept', () => {
    run({ blocks: [blocks[0]], cells: [cell('g1', 'nb1', { activityId: 'a-swim' })] })
    const r = run({ blocks: [], cells: [cell('g1', 'nb1'), cell('g2', 'nb1')] })
    expect(r).toMatchObject({ ok: true, blocksWritten: 0, cellsWritten: 1 })
    expect(r.skipped).toEqual(['Swim kept in Group g1 Carpool — Carpool not added there'])
    expect(daySlots().find((s) => s.group_id === 'g1').activity_id).toBe('a-swim')
  })

  it('skips silently when the cell already holds the same activity', () => {
    run({ blocks: [blocks[0]], cells: [cell('g1', 'nb1')] })
    const r = run({ blocks: [], cells: [cell('g1', 'nb1')] })
    expect(r).toMatchObject({ ok: true, cellsWritten: 0, skipped: [] })
  })

  it('fills an existing empty row in place rather than adding a second', () => {
    run({ blocks: [blocks[0]], cells: [] })
    db.prepare("INSERT INTO special_day_slots (id, special_day_id, group_id, time_block_id) VALUES ('empty', 'sd-1', 'g1', 'nb1')").run()
    const r = run({ blocks: [], cells: [cell('g1', 'nb1', { locationId: null })] })
    expect(r.cellsWritten).toBe(1)
    expect(db.prepare("SELECT id, activity_id FROM special_day_slots WHERE group_id = 'g1'").all()).toEqual([{ id: 'empty', activity_id: 'a-carpool' }])
  })

  it('two cells for one position in the same batch write one row and report the second', () => {
    const r = run({ cells: [cell('g1', 'nb1'), cell('g1', 'nb1', { activityId: 'a-swim', eventName: 'Swim' })] })
    expect(r.cellsWritten).toBe(1)
    expect(r.skipped).toEqual(['Carpool kept in Group g1 Carpool — Swim not added there'])
    expect(daySlots()).toHaveLength(1)
  })

  it('records every created row in the op log like an ordinary write', () => {
    run({ cells: [cell('g1', 'nb1'), cell('g2', 'nb1')] })
    const blockOps = opsFor('special_day_time_blocks')
    expect(new Set(blockOps.map((o) => o.entity_id))).toEqual(new Set(['nb1', 'nb2']))
    expect(blockOps.filter((o) => o.entity_id === 'nb1').map((o) => o.field)).toEqual(['special_day_id', 'name', 'sort_order', 'start_time', 'end_time'])
    const slotOps = opsFor('special_day_slots')
    expect(new Set(slotOps.map((o) => o.entity_id)).size).toBe(2)
    expect(slotOps.filter((o) => o.field === 'activity_id')).toHaveLength(2)
    expect(slotOps.every((o) => o.source === 'human')).toBe(true)
  })

  it('refuses an unknown special day, an unknown block, and an already existing block id, writing nothing', () => {
    expect(run({ specialDayId: 'nope' })).toEqual({ ok: false, reason: 'unknown-special-day' })
    expect(run({ blocks: [], cells: [cell('g1', 'missing')] })).toEqual({ ok: false, reason: 'unknown-block' })
    run({ blocks: [blocks[0]] })
    expect(run({ blocks: [blocks[0]] })).toEqual({ ok: false, reason: 'block-exists' })
    expect(dayBlocks()).toHaveLength(1)
  })
})
