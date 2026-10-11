// @vitest-environment node
//
// T372 point 2 + slice 3a Red Hat minor: undo keeps (and says why) a row that a saved schedule version
// names, and keeps a special-day child whose parent day is kept, so no hollow day is left behind.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest, ingestUndo } from './ingest.js'
import { appendOp } from './operations.js'

afterAll(() => cleanupTemplatedDbs())
const deviceId = 'device-1'
const userId = 'u1'
let d, file, campId, g1

beforeEach(() => {
  const t = openTemplatedDb()
  d = t.db
  file = t.file
  campId = randomUUID()
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, campId)
  g1 = randomUUID()
  appendOp(d, { entity: 'groups', entity_id: g1, field: 'name', value: 'Red', author_user_id: userId, device_id: deviceId })
  appendOp(d, { entity: 'groups', entity_id: g1, field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
})
afterEach(() => {
  d.close()
  if (fs.existsSync(file)) fs.unlinkSync(file)
})

const day = () => ({
  name: 'Maccabiah',
  columns: [{ columnName: 'Red', groupId: g1 }],
  timeBlocks: [{ name: '9:15', sort_order: 0, start_time: '9:15', end_time: null }],
  activities: [{ name: 'Tug', activityId: null }],
  newActivityNames: ['Tug'],
  slots: [{ columnName: 'Red', blockName: '9:15', activityName: 'Tug' }],
  notes: null,
  ready: true,
  blockedBy: [],
})
const commitDay = () => commitIngest(d, { camp_id: campId, approved: {}, links: {}, specialDay: day(), author_user_id: userId, device_id: deviceId, mode: 'add', captureInverse: true })
const undo = (out) => ingestUndo(d, { invertibleOps: out.invertibleOps, createdEntityIds: out.createdEntityIds, importRunId: out.importRunId, author_user_id: userId, device_id: deviceId, client_write_id: randomUUID() })
const count = (t) => d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c

describe('undo and saved schedule versions', () => {
  it('keeps an activity a saved version names, with its own reason', () => {
    const out = commitDay()
    const tug = d.prepare("SELECT id FROM activities WHERE name = 'Tug'").get().id
    const templateId = randomUUID()
    d.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(templateId, campId, 'T')
    d.prepare('INSERT INTO schedule_snapshots (id, template_id, name, created_at, slots) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), templateId, 'v1', new Date().toISOString(), JSON.stringify([{ group_id: g1, activity_id: tug }]))
    const res = undo(out)
    expect(res.kept).toContainEqual(expect.objectContaining({ entity: 'activities', entity_id: tug, reason: 'used_in_saved_version' }))
    expect(d.prepare('SELECT id FROM activities WHERE id = ?').get(tug)).toBeTruthy()
  })
})

describe('undo of a special day the director edited', () => {
  it('keeps the periods and cells of a kept day instead of leaving it hollow', () => {
    const out = commitDay()
    const dayId = d.prepare('SELECT id FROM special_days').get().id
    appendOp(d, { entity: 'special_days', entity_id: dayId, field: 'notes', value: 'my note', author_user_id: userId, device_id: deviceId, source: 'human' })
    const res = undo(out)
    expect(res.kept).toContainEqual(expect.objectContaining({ entity: 'special_days', entity_id: dayId, reason: 'edited_since_import' }))
    expect(res.kept.filter((k) => k.reason === 'parent_kept').map((k) => k.entity).sort()).toEqual(['special_day_slots', 'special_day_time_blocks'])
    expect(count('special_days')).toBe(1)
    expect(count('special_day_time_blocks')).toBe(1)
    expect(count('special_day_slots')).toBe(1)
  })
})
