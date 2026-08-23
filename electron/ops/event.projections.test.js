// @vitest-environment node
//
// Events internal sub-schedule Slice 2 — event_time_blocks / event_groups /
// event_slots (docs/adr/2026-08-22-event-internal-subschedule.md). Projection
// round-trips through the real op-log path (appendOp -> applyProjection),
// mirroring electron/ops/specialDays.projections.test.js's shape for the
// three-NOT-NULL-column reconstruction in event_slots, plus a companion
// event_groups block proving it is structurally identical to
// event_time_blocks.
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
  tmpFile = path.join(os.tmpdir(), `shoresh-event-projections-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('PROJECTIONS registry', () => {
  it('registers all three tables with their field allowlists', () => {
    expect(PROJECTIONS.event_time_blocks.fields).toEqual([
      'event_id', 'name', 'sort_order', 'start_time', 'end_time',
    ])
    expect(PROJECTIONS.event_groups.fields).toEqual(['event_id', 'name', 'sort_order'])
    expect(PROJECTIONS.event_slots.fields).toEqual([
      'event_id', 'event_group_id', 'time_block_id', 'activity_id', 'location_id',
    ])
  })
})

describe('event_time_blocks — parent-scoped by event_id', () => {
  beforeEach(() => {
    appendOp(db, {
      entity: 'events', entity_id: 'evt-1', field: 'name', value: 'Color War',
      author_user_id: 'user-1', device_id: 'device-1',
    })
  })

  it('create->read round trip: event_id write creates the row, name/sort_order/times fill it in', () => {
    appendOp(db, {
      entity: 'event_time_blocks', entity_id: 'tb-1', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_time_blocks', entity_id: 'tb-1', field: 'name', value: 'Station 1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_time_blocks', entity_id: 'tb-1', field: 'start_time', value: '09:15',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM event_time_blocks WHERE id = ?').get('tb-1')
    expect(row).toBeTruthy()
    expect(row.event_id).toBe('evt-1')
    expect(row.name).toBe('Station 1')
    expect(row.start_time).toBe('09:15')
  })

  it('no row before event_id is written (a name-only write is a harmless no-op)', () => {
    appendOp(db, {
      entity: 'event_time_blocks', entity_id: 'tb-orphan', field: 'name', value: 'Station 1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM event_time_blocks WHERE id = ?').get('tb-orphan')).toBeUndefined()
  })
})

describe('event_groups — parent-scoped by event_id, structurally identical to event_time_blocks', () => {
  beforeEach(() => {
    appendOp(db, {
      entity: 'events', entity_id: 'evt-1', field: 'name', value: 'Color War',
      author_user_id: 'user-1', device_id: 'device-1',
    })
  })

  it('create->read round trip: event_id write creates the row, name/sort_order fill it in', () => {
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-1', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-1', field: 'name', value: 'Blue Team',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-1', field: 'sort_order', value: 1,
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM event_groups WHERE id = ?').get('eg-1')
    expect(row).toBeTruthy()
    expect(row.event_id).toBe('evt-1')
    expect(row.name).toBe('Blue Team')
    expect(row.sort_order).toBe(1)
  })

  it('reorder via sort_order swap — two groups can be reordered by writing sort_order', () => {
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-1', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-1', field: 'sort_order', value: 0,
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-2', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-2', field: 'sort_order', value: 1,
      author_user_id: 'user-1', device_id: 'device-1',
    })

    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-1', field: 'sort_order', value: 1,
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-2', field: 'sort_order', value: 0,
      author_user_id: 'user-1', device_id: 'device-1',
    })

    expect(db.prepare('SELECT sort_order FROM event_groups WHERE id = ?').get('eg-1').sort_order).toBe(1)
    expect(db.prepare('SELECT sort_order FROM event_groups WHERE id = ?').get('eg-2').sort_order).toBe(0)
  })

  it('no row before event_id is written', () => {
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-orphan', field: 'name', value: 'Blue Team',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM event_groups WHERE id = ?').get('eg-orphan')).toBeUndefined()
  })
})

describe('event_slots — parent-scoped by event_id, three NOT NULL columns', () => {
  beforeEach(() => {
    appendOp(db, {
      entity: 'events', entity_id: 'evt-1', field: 'name', value: 'Color War',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_time_blocks', entity_id: 'tb-1', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_groups', entity_id: 'eg-1', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
  })

  it('creates the row only once event_id, event_group_id, and time_block_id are all known', () => {
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-1', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM event_slots WHERE id = ?').get('sl-1')).toBeUndefined()

    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-1', field: 'event_group_id', value: 'eg-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM event_slots WHERE id = ?').get('sl-1')).toBeUndefined()

    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-1', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM event_slots WHERE id = ?').get('sl-1')
    expect(row).toBeTruthy()
    expect(row.event_id).toBe('evt-1')
    expect(row.event_group_id).toBe('eg-1')
    expect(row.time_block_id).toBe('tb-1')
    expect(row.activity_id).toBeNull()
    expect(row.location_id).toBeNull()
  })

  it('is order-independent — the row still lands with the three fields written in reverse order', () => {
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-rev', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-rev', field: 'event_group_id', value: 'eg-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM event_slots WHERE id = ?').get('sl-rev')).toBeUndefined()

    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-rev', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM event_slots WHERE id = ?').get('sl-rev')
    expect(row).toBeTruthy()
    expect(row.event_group_id).toBe('eg-1')
    expect(row.time_block_id).toBe('tb-1')
  })

  it('activity_id and location_id fill in on an existing row', () => {
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-1', field: 'event_id', value: 'evt-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-1', field: 'event_group_id', value: 'eg-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-1', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-1', 'camp-1', 'Swim')
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-1', field: 'activity_id', value: 'act-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT activity_id FROM event_slots WHERE id = ?').get('sl-1').activity_id).toBe('act-1')
  })

  it('stub-seeds the events parent when an event_slots op arrives for an event never seen locally', () => {
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-orphan', field: 'event_id', value: 'evt-never-seen',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-orphan', field: 'event_group_id', value: 'eg-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'event_slots', entity_id: 'sl-orphan', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT 1 FROM events WHERE id = ?').get('evt-never-seen')).toBeTruthy()
    expect(db.prepare('SELECT * FROM event_slots WHERE id = ?').get('sl-orphan')).toBeTruthy()
  })
})
