// @vitest-environment node
//
// T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md):
// "Deleting a special_days row (throwaway semantics) must tombstone its time
// blocks and slots ... no orphaned children remain." Mirrors
// electron/ops/deleteWeek.test.js's shape for the cascade this function
// provides.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { deleteSpecialDay } from './deleteSpecialDay.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-delete-special-day-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('grp-1', 'camp-1', 'Bunk 1')
  db.prepare('INSERT INTO special_days (id, camp_id, name) VALUES (?, ?, ?)').run('sd-1', 'camp-1', 'Among Us')
  db.prepare(
    'INSERT INTO special_day_time_blocks (id, special_day_id, name, sort_order) VALUES (?, ?, ?, ?)'
  ).run('tb-1', 'sd-1', 'Opening', 0)
  db.prepare(
    'INSERT INTO special_day_slots (id, special_day_id, group_id, time_block_id) VALUES (?, ?, ?, ?)'
  ).run('sl-1', 'sd-1', 'grp-1', 'tb-1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('deleteSpecialDay', () => {
  it('removes the special day and every scoped row, leaving no orphans', () => {
    const result = deleteSpecialDay(db, { specialDayId: 'sd-1' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM special_days WHERE id = ?').get('sd-1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM special_day_time_blocks WHERE special_day_id = ?').get('sd-1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM special_day_slots WHERE special_day_id = ?').get('sd-1').c).toBe(0)
  })

  it('deletes every row through the op-log — one DELETE_FIELD op per row, in child-before-parent order', () => {
    const result = deleteSpecialDay(db, { specialDayId: 'sd-1' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ops.map((o) => o.entity)).toEqual([
      'special_day_slots', 'special_day_time_blocks', 'special_days',
    ])
    for (const op of result.ops) {
      expect(op.field).toBe('__deleted__')
    }
    const loggedDeletes = db
      .prepare("SELECT entity, entity_id FROM operations WHERE field = '__deleted__' ORDER BY seq")
      .all()
    expect(loggedDeletes).toEqual([
      { entity: 'special_day_slots', entity_id: 'sl-1' },
      { entity: 'special_day_time_blocks', entity_id: 'tb-1' },
      { entity: 'special_days', entity_id: 'sd-1' },
    ])
  })

  it('the deletes replicate — replaying the same ops against a second db reaches the same empty state', () => {
    const result = deleteSpecialDay(db, { specialDayId: 'sd-1' }, { author_user_id: 'user-1', device_id: 'device-1' })

    const tmpFile2 = path.join(os.tmpdir(), `shoresh-delete-special-day-replica-${Date.now()}-${Math.random()}.sqlite`)
    const replica = openLocalDb(tmpFile2)
    try {
      replica.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
      replica.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
      replica.prepare(
        'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
      replica.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('grp-1', 'camp-1', 'Bunk 1')
      replica.prepare('INSERT INTO special_days (id, camp_id, name) VALUES (?, ?, ?)').run('sd-1', 'camp-1', 'Among Us')
      replica.prepare(
        'INSERT INTO special_day_time_blocks (id, special_day_id, name, sort_order) VALUES (?, ?, ?, ?)'
      ).run('tb-1', 'sd-1', 'Opening', 0)
      replica.prepare(
        'INSERT INTO special_day_slots (id, special_day_id, group_id, time_block_id) VALUES (?, ?, ?, ?)'
      ).run('sl-1', 'sd-1', 'grp-1', 'tb-1')

      for (const op of result.ops) {
        replica
          .prepare('DELETE FROM ' + op.entity + ' WHERE id = ?')
          .run(op.entity_id)
      }
      expect(replica.prepare('SELECT COUNT(*) c FROM special_days').get().c).toBe(0)
      expect(replica.prepare('SELECT COUNT(*) c FROM special_day_time_blocks').get().c).toBe(0)
      expect(replica.prepare('SELECT COUNT(*) c FROM special_day_slots').get().c).toBe(0)
    } finally {
      replica.close()
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(tmpFile2 + suffix)) fs.unlinkSync(tmpFile2 + suffix)
      }
    }
  })

  it('returns { error: "not-found" } for a non-existent special day', () => {
    const result = deleteSpecialDay(db, { specialDayId: 'no-such-day' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result).toEqual({ error: 'not-found' })
  })

  it('returns { error: "not-found" } for a missing/empty specialDayId', () => {
    expect(deleteSpecialDay(db, {}, { author_user_id: 'user-1', device_id: 'device-1' })).toEqual({ error: 'not-found' })
  })

  it('deleting a special day with no time blocks or slots removes just the parent row', () => {
    db.prepare('INSERT INTO special_days (id, camp_id, name) VALUES (?, ?, ?)').run('sd-empty', 'camp-1', 'Empty Day')
    const result = deleteSpecialDay(db, { specialDayId: 'sd-empty' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ok).toBe(true)
    expect(result.ops).toHaveLength(1)
    expect(result.ops[0].entity).toBe('special_days')
    expect(db.prepare('SELECT COUNT(*) c FROM special_days WHERE id = ?').get('sd-empty').c).toBe(0)
  })
})
