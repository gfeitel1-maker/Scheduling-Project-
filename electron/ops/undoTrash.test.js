// Undo import is the director's deliberate reversal of an import, not a deletion: the records it
// removes must not appear in Trash as individual "deleted by" rows. A manual delete still does.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { commitPlan, ingestUndo } from './ingest.js'
import { listDeleted } from './trash.js'

afterAll(() => { cleanupTemplatedDbs() })
let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Dana Director', 'h', 's', 'admin')").run('u1', campId)
})
afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const createActivityItem = (name) => ({
  op: 'create', entity: 'activities', entity_id: null,
  fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: name, source: 'import' } },
  evidence: { tier: 'new' }, _name: name, _humanFields: [],
})
const plan = (items) => ({
  plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
  sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [], unresolved: [], items,
})

describe('Trash after Undo import', () => {
  it('lists none of the records the undone import created, but still lists a manual delete', () => {
    const res = commitPlan(db, plan([createActivityItem('Kayaking'), createActivityItem('Archery')]),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    expect(res.createdEntityIds.length).toBe(2)

    const manualId = randomUUID()
    appendOp(db, { entity: 'activities', entity_id: manualId, field: 'camp_id', value: campId, author_user_id: 'u1', device_id: deviceId, source: 'human' })
    appendOp(db, { entity: 'activities', entity_id: manualId, field: 'name', value: 'Swim', author_user_id: 'u1', device_id: deviceId, source: 'human' })
    appendOp(db, { entity: 'activities', entity_id: manualId, field: DELETE_FIELD, value: 1, author_user_id: 'u1', device_id: deviceId, source: 'human' })

    const undo = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(undo.deleted.length).toBe(2)

    const trash = listDeleted(db)
    expect(trash.map((r) => r.entity_id)).toEqual([manualId])
  })
})
