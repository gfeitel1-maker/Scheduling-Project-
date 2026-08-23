// @vitest-environment node
//
// Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-internal-
// subschedule.md §3): deleting an events row must tombstone its
// event_time_blocks/event_groups/event_slots — no orphaned children remain.
// Mirrors deleteSpecialDay.test.js's shape, extended to three children.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { deleteEvent } from './deleteEvent.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-delete-event-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
  db.prepare('INSERT INTO events (id, camp_id, name) VALUES (?, ?, ?)').run('evt-1', 'camp-1', 'Color War')
  db.prepare(
    'INSERT INTO event_time_blocks (id, event_id, name, sort_order) VALUES (?, ?, ?, ?)'
  ).run('tb-1', 'evt-1', 'Station 1', 0)
  db.prepare(
    'INSERT INTO event_groups (id, event_id, name, sort_order) VALUES (?, ?, ?, ?)'
  ).run('eg-1', 'evt-1', 'Blue Team', 0)
  db.prepare(
    'INSERT INTO event_slots (id, event_id, event_group_id, time_block_id) VALUES (?, ?, ?, ?)'
  ).run('sl-1', 'evt-1', 'eg-1', 'tb-1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('deleteEvent', () => {
  it('removes the event and every scoped row, leaving no orphans', () => {
    const result = deleteEvent(db, { eventId: 'evt-1' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM events WHERE id = ?').get('evt-1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM event_time_blocks WHERE event_id = ?').get('evt-1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM event_groups WHERE event_id = ?').get('evt-1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM event_slots WHERE event_id = ?').get('evt-1').c).toBe(0)
  })

  it('deletes every row through the op-log — one DELETE_FIELD op per row, event_slots before either axis table', () => {
    const result = deleteEvent(db, { eventId: 'evt-1' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ops.map((o) => o.entity)).toEqual([
      'event_slots', 'event_time_blocks', 'event_groups', 'events',
    ])
    for (const op of result.ops) {
      expect(op.field).toBe('__deleted__')
    }
    const loggedDeletes = db
      .prepare("SELECT entity, entity_id FROM operations WHERE field = '__deleted__' ORDER BY seq")
      .all()
    expect(loggedDeletes).toEqual([
      { entity: 'event_slots', entity_id: 'sl-1' },
      { entity: 'event_time_blocks', entity_id: 'tb-1' },
      { entity: 'event_groups', entity_id: 'eg-1' },
      { entity: 'events', entity_id: 'evt-1' },
    ])
  })

  it('returns { error: "not-found" } for a non-existent event', () => {
    const result = deleteEvent(db, { eventId: 'no-such-event' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result).toEqual({ error: 'not-found' })
  })

  it('returns { error: "not-found" } for a missing/empty eventId', () => {
    expect(deleteEvent(db, {}, { author_user_id: 'user-1', device_id: 'device-1' })).toEqual({ error: 'not-found' })
  })

  it('deleting an event with no time blocks, groups, or slots removes just the parent row', () => {
    db.prepare('INSERT INTO events (id, camp_id, name) VALUES (?, ?, ?)').run('evt-empty', 'camp-1', 'Empty Event')
    const result = deleteEvent(db, { eventId: 'evt-empty' }, { author_user_id: 'user-1', device_id: 'device-1' })
    expect(result.ok).toBe(true)
    expect(result.ops).toHaveLength(1)
    expect(result.ops[0].entity).toBe('events')
    expect(db.prepare('SELECT COUNT(*) c FROM events WHERE id = ?').get('evt-empty').c).toBe(0)
  })
})
