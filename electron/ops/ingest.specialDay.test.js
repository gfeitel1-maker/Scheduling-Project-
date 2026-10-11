// @vitest-environment node
//
// F3/F4 slice 3a (docs/adr/2026-10-11-import-special-days-and-field-trips.md): the one-day-file commit
// lives in commitPlan, so it is one transaction with derived ids, an import_run_id, and an Undo. Rows are
// read back from the real tables, not inferred from the call.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest, ingestUndo } from './ingest.js'
import { appendOp } from './operations.js'

afterAll(() => cleanupTemplatedDbs())
const deviceId = 'device-1'
const userId = 'u1'

let d, file, campId, g1, g2, relayId
beforeEach(() => {
  const t = openTemplatedDb()
  d = t.db
  file = t.file
  campId = randomUUID()
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, campId)
  g1 = randomUUID()
  g2 = randomUUID()
  relayId = randomUUID()
  for (const [entity, id, name] of [['groups', g1, 'Red'], ['groups', g2, 'Blue'], ['activities', relayId, 'Relay']]) {
    appendOp(d, { entity, entity_id: id, field: 'name', value: name, author_user_id: userId, device_id: deviceId })
    appendOp(d, { entity, entity_id: id, field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
  }
})
afterEach(() => {
  d.close()
  if (fs.existsSync(file)) fs.unlinkSync(file)
})

const plan = (over = {}) => ({
  name: 'Maccabiah',
  columns: [{ columnName: 'Red', groupId: g1 }, { columnName: 'Blue', groupId: g2 }],
  timeBlocks: [
    { name: '9:15-9:45', sort_order: 0, start_time: '9:15', end_time: '9:45' },
    { name: '10:15', sort_order: 1, start_time: '10:15', end_time: null },
  ],
  activities: [{ name: 'Relay', activityId: relayId }, { name: 'Tug', activityId: null }],
  newActivityNames: ['Tug'],
  slots: [
    { columnName: 'Red', blockName: '9:15-9:45', activityName: 'Relay' },
    { columnName: 'Blue', blockName: '10:15', activityName: 'Tug' },
  ],
  notes: 'From the imported file - cells that named a person:\nRed 10:15: Pool - Unit Heads',
  ready: true,
  blockedBy: [],
  ...over,
})

const commit = (specialDay, extra = {}) => commitIngest(d, {
  camp_id: campId, approved: {}, links: {}, specialDay, author_user_id: userId, device_id: deviceId, mode: 'add', ...extra,
})
const ids = (table) => d.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((r) => r.id)
const counts = () => Object.fromEntries(['special_days', 'special_day_time_blocks', 'special_day_slots'].map((t) => [t, ids(t).length]))

describe('special-day commit lives in commitPlan', () => {
  it('writes the day, its periods and its cells', () => {
    commit(plan())
    expect(counts()).toEqual({ special_days: 1, special_day_time_blocks: 2, special_day_slots: 2 })
    const day = d.prepare('SELECT * FROM special_days').get()
    expect(day).toMatchObject({ name: 'Maccabiah', camp_id: campId })
    expect(d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()).toHaveLength(1)
  })

  it('importing the same file twice leaves identical row counts and ids', () => {
    commit(plan())
    const first = { days: ids('special_days'), blocks: ids('special_day_time_blocks'), slots: ids('special_day_slots'), acts: ids('activities') }
    const again = commit(plan({ activities: [{ name: 'Relay', activityId: relayId }, { name: 'Tug', activityId: first.acts.find((a) => a !== relayId) }] }))
    expect({ days: ids('special_days'), blocks: ids('special_day_time_blocks'), slots: ids('special_day_slots'), acts: ids('activities') }).toEqual(first)
    expect(again.specialDay).toMatchObject({ created: false })
  })

  it('stamps the import run id on the day', () => {
    const out = commit(plan())
    const ev = d.prepare("SELECT import_run_id FROM import_evidence WHERE entity_type = 'special_days'").all()
    expect(ev.map((e) => e.import_run_id)).toEqual([out.importRunId])
  })

  it('a failure mid-commit leaves nothing', () => {
    const bad = plan({ slots: [...plan().slots, { columnName: 'Red', blockName: '10:15', activityName: 'Relay' }], columns: [{ columnName: 'Red', groupId: g1 }, { columnName: 'Blue', groupId: 'no-such-group' }] })
    expect(() => commit(bad)).toThrow()
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0 })
    expect(d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()).toHaveLength(0)
  })

  it('refuses a plan that is not ready, writing nothing', () => {
    expect(() => commit(plan({ ready: false, blockedBy: ['unmatched_columns'] }))).toThrow(/not ready/i)
    expect(counts().special_days).toBe(0)
  })

  it('Undo import removes the day, its children and the activities it minted', () => {
    const out = commit(plan(), { captureInverse: true })
    expect(counts().special_days).toBe(1)
    const res = ingestUndo(d, { invertibleOps: out.invertibleOps, createdEntityIds: out.createdEntityIds, importRunId: out.importRunId, author_user_id: userId, device_id: deviceId, client_write_id: randomUUID() })
    expect(res.kept).toEqual([])
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0 })
    expect(d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()).toHaveLength(0)
    expect(d.prepare("SELECT id FROM activities WHERE id = ?").all(relayId)).toHaveLength(1)
    expect(d.prepare("SELECT id FROM import_evidence WHERE entity_type = 'special_days'").all()).toHaveLength(0)
  })

  it('a minted activity gets an id derived from camp and name, so two devices converge', async () => {
    commit(plan())
    const { deriveSpecialDayActivityId } = await import('./electiveDerivedIds.js')
    const tug = d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()
    expect(tug.map((r) => r.id)).toEqual([deriveSpecialDayActivityId(campId, 'Tug')])
  })
})
