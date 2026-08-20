// @vitest-environment node
//
// T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md):
// "Deleting an elective_sets row cascades its elective_set_activities."
// Mirrors electron/ops/deleteSpecialDay.test.js's shape for the cascade this
// function provides.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { deleteElectiveSet } from './deleteElectiveSet.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-delete-elective-set-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-1', 'camp-1', 'Swim')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('es-1', 'camp-1', 'Afternoon Chugim')
  db.prepare(
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)'
  ).run('esa-1', 'es-1', 'act-1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('deleteElectiveSet', () => {
  it('removes the elective set and every scoped row, leaving no orphans', () => {
    const result = deleteElectiveSet(db, { electiveSetId: 'es-1' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets WHERE id = ?').get('es-1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities WHERE elective_set_id = ?').get('es-1').c).toBe(0)
  })

  it('deletes every row through the op-log — one DELETE_FIELD op per row, in child-before-parent order', () => {
    const result = deleteElectiveSet(db, { electiveSetId: 'es-1' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ops.map((o) => o.entity)).toEqual([
      'elective_set_activities', 'elective_sets',
    ])
    for (const op of result.ops) {
      expect(op.field).toBe('__deleted__')
    }
    const loggedDeletes = db
      .prepare("SELECT entity, entity_id FROM operations WHERE field = '__deleted__' ORDER BY seq")
      .all()
    expect(loggedDeletes).toEqual([
      { entity: 'elective_set_activities', entity_id: 'esa-1' },
      { entity: 'elective_sets', entity_id: 'es-1' },
    ])
  })

  it('the deletes replicate — replaying the same ops against a second db reaches the same empty state', () => {
    const result = deleteElectiveSet(db, { electiveSetId: 'es-1' }, { author_user_id: 'user-1', device_id: 'device-1' })

    const tmpFile2 = path.join(os.tmpdir(), `shoresh-delete-elective-set-replica-${Date.now()}-${Math.random()}.sqlite`)
    const replica = openLocalDb(tmpFile2)
    try {
      replica.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
      replica.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
      replica.prepare(
        'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
      replica.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-1', 'camp-1', 'Swim')
      replica.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('es-1', 'camp-1', 'Afternoon Chugim')
      replica.prepare(
        'INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)'
      ).run('esa-1', 'es-1', 'act-1')

      for (const op of result.ops) {
        replica
          .prepare('DELETE FROM ' + op.entity + ' WHERE id = ?')
          .run(op.entity_id)
      }
      expect(replica.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(0)
      expect(replica.prepare('SELECT COUNT(*) c FROM elective_set_activities').get().c).toBe(0)
    } finally {
      replica.close()
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(tmpFile2 + suffix)) fs.unlinkSync(tmpFile2 + suffix)
      }
    }
  })

  it('returns { error: "not-found" } for a non-existent elective set', () => {
    const result = deleteElectiveSet(db, { electiveSetId: 'no-such-set' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result).toEqual({ error: 'not-found' })
  })

  it('returns { error: "not-found" } for a missing/empty electiveSetId', () => {
    expect(deleteElectiveSet(db, {}, { author_user_id: 'user-1', device_id: 'device-1' })).toEqual({ error: 'not-found' })
  })

  it('deleting an elective set with no member activities removes just the parent row', () => {
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('es-empty', 'camp-1', 'Empty Set')
    const result = deleteElectiveSet(db, { electiveSetId: 'es-empty' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ok).toBe(true)
    expect(result.ops).toHaveLength(1)
    expect(result.ops[0].entity).toBe('elective_sets')
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets WHERE id = ?').get('es-empty').c).toBe(0)
  })
})
