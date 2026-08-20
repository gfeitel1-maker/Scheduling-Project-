// @vitest-environment node
//
// T41 slice 1 — elective_sets / elective_set_activities / template_slots.
// elective_set_id (docs/work/specs/2026-08-20-group-electives-design.md).
// Projection round-trips through the real op-log path (appendOp ->
// applyProjection), mirroring electron/ops/specialDays.projections.test.js.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS } from './projections.js'
import { appendOp } from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-electives-projections-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-1', 'camp-1', 'Swim')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('grp-1', 'camp-1', 'Bunk 1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('PROJECTIONS registry', () => {
  it('registers both tables with their field allowlists', () => {
    expect(PROJECTIONS.elective_sets.fields).toEqual(['camp_id', 'name', 'sort_order'])
    expect(PROJECTIONS.elective_set_activities.fields).toEqual(['elective_set_id', 'activity_id'])
  })

  it('registers template_slots.elective_set_id as a writable field', () => {
    expect(PROJECTIONS.template_slots.fields).toContain('elective_set_id')
  })
})

describe('elective_sets — camp-scoped parent', () => {
  it('create->read round trip: name write materializes a row (ensureExists then UPDATE)', () => {
    appendOp(db, {
      entity: 'elective_sets', entity_id: 'es-1',
      field: 'name', value: 'Afternoon Chugim',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM elective_sets WHERE id = ?').get('es-1')
    expect(row).toBeTruthy()
    expect(row.camp_id).toBe('camp-1')
    expect(row.name).toBe('Afternoon Chugim')
  })

  it('sort_order write on an existing row updates it', () => {
    appendOp(db, {
      entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'elective_sets', entity_id: 'es-1', field: 'sort_order', value: 2,
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT sort_order FROM elective_sets WHERE id = ?').get('es-1').sort_order).toBe(2)
  })
})

describe('elective_set_activities — parent-scoped by elective_set_id, two NOT NULL columns', () => {
  beforeEach(() => {
    appendOp(db, {
      entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim',
      author_user_id: 'user-1', device_id: 'device-1',
    })
  })

  it('whichever field arrives second creates the row (elective_set_id then activity_id)', () => {
    appendOp(db, {
      entity: 'elective_set_activities', entity_id: 'esa-1',
      field: 'elective_set_id', value: 'es-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM elective_set_activities WHERE id = ?').get('esa-1')).toBeUndefined()

    appendOp(db, {
      entity: 'elective_set_activities', entity_id: 'esa-1',
      field: 'activity_id', value: 'act-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM elective_set_activities WHERE id = ?').get('esa-1')
    expect(row).toBeTruthy()
    expect(row.elective_set_id).toBe('es-1')
    expect(row.activity_id).toBe('act-1')
  })

  it('order-independent: activity_id then elective_set_id also creates the row', () => {
    appendOp(db, {
      entity: 'elective_set_activities', entity_id: 'esa-2',
      field: 'activity_id', value: 'act-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM elective_set_activities WHERE id = ?').get('esa-2')).toBeUndefined()

    appendOp(db, {
      entity: 'elective_set_activities', entity_id: 'esa-2',
      field: 'elective_set_id', value: 'es-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM elective_set_activities WHERE id = ?').get('esa-2')
    expect(row).toBeTruthy()
    expect(row.elective_set_id).toBe('es-1')
    expect(row.activity_id).toBe('act-1')
  })

  it('stub-seeds elective_sets defensively if the parent row does not exist yet (out-of-order replay)', () => {
    appendOp(db, {
      entity: 'elective_set_activities', entity_id: 'esa-3',
      field: 'elective_set_id', value: 'es-not-yet-created',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'elective_set_activities', entity_id: 'esa-3',
      field: 'activity_id', value: 'act-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT 1 FROM elective_sets WHERE id = ?').get('es-not-yet-created')).toBeTruthy()
    expect(db.prepare('SELECT * FROM elective_set_activities WHERE id = ?').get('esa-3').elective_set_id).toBe(
      'es-not-yet-created'
    )
  })
})

describe('template_slots.elective_set_id — extends the existing core-table projection', () => {
  it('write round trip: an activity slot can be turned into an elective cell', () => {
    appendOp(db, {
      entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'template_slots', entity_id: 'ts-1',
      field: 'template_id', value: 'tpl-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'template_slots', entity_id: 'ts-1',
      field: 'elective_set_id', value: 'es-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('ts-1')
    expect(row.elective_set_id).toBe('es-1')
  })
})
