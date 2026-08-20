// @vitest-environment node
//
// T40 slice 1 — special_days / special_day_time_blocks / special_day_slots
// (docs/work/specs/2026-08-20-special-days-data-shape-design.md). Projection
// round-trips through the real op-log path (appendOp -> applyProjection),
// mirroring electron/ops/projections.test.js's week_activity_exclusions
// block for the three-NOT-NULL-column reconstruction in special_day_slots.
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
  tmpFile = path.join(os.tmpdir(), `shoresh-special-days-projections-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('grp-1', 'camp-1', 'Bunk 1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('PROJECTIONS registry', () => {
  it('registers all three tables with their field allowlists', () => {
    expect(PROJECTIONS.special_days.fields).toEqual(['camp_id', 'name', 'sort_order'])
    expect(PROJECTIONS.special_day_time_blocks.fields).toEqual([
      'special_day_id', 'name', 'sort_order', 'start_time', 'end_time',
    ])
    expect(PROJECTIONS.special_day_slots.fields).toEqual([
      'special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id',
    ])
  })
})

describe('special_days — camp-scoped parent', () => {
  it('create->read round trip: name write materializes a row (ensureExists then UPDATE)', () => {
    appendOp(db, {
      entity: 'special_days', entity_id: 'sd-1',
      field: 'name', value: 'Among Us',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM special_days WHERE id = ?').get('sd-1')
    expect(row).toBeTruthy()
    expect(row.camp_id).toBe('camp-1')
    expect(row.name).toBe('Among Us')
  })

  it('sort_order write on an existing row updates it', () => {
    appendOp(db, {
      entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_days', entity_id: 'sd-1', field: 'sort_order', value: 2,
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT sort_order FROM special_days WHERE id = ?').get('sd-1').sort_order).toBe(2)
  })
})

describe('special_day_time_blocks — parent-scoped by special_day_id', () => {
  beforeEach(() => {
    appendOp(db, {
      entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us',
      author_user_id: 'user-1', device_id: 'device-1',
    })
  })

  it('create->read round trip: special_day_id write creates the row, name/sort_order/times fill it in', () => {
    appendOp(db, {
      entity: 'special_day_time_blocks', entity_id: 'tb-1',
      field: 'special_day_id', value: 'sd-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_time_blocks', entity_id: 'tb-1',
      field: 'name', value: 'Opening',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_time_blocks', entity_id: 'tb-1',
      field: 'start_time', value: '09:15',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM special_day_time_blocks WHERE id = ?').get('tb-1')
    expect(row).toBeTruthy()
    expect(row.special_day_id).toBe('sd-1')
    expect(row.name).toBe('Opening')
    expect(row.start_time).toBe('09:15')
  })

  it('no row before special_day_id is written (a name-only write is a harmless no-op)', () => {
    appendOp(db, {
      entity: 'special_day_time_blocks', entity_id: 'tb-orphan',
      field: 'name', value: 'Opening',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM special_day_time_blocks WHERE id = ?').get('tb-orphan')).toBeUndefined()
  })
})

describe('special_day_slots — parent-scoped by special_day_id, three NOT NULL columns', () => {
  beforeEach(() => {
    appendOp(db, {
      entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_time_blocks', entity_id: 'tb-1', field: 'special_day_id', value: 'sd-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
  })

  it('creates the row only once special_day_id, group_id, and time_block_id are all known', () => {
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-1', field: 'special_day_id', value: 'sd-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM special_day_slots WHERE id = ?').get('sl-1')).toBeUndefined()

    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-1', field: 'group_id', value: 'grp-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM special_day_slots WHERE id = ?').get('sl-1')).toBeUndefined()

    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-1', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM special_day_slots WHERE id = ?').get('sl-1')
    expect(row).toBeTruthy()
    expect(row.special_day_id).toBe('sd-1')
    expect(row.group_id).toBe('grp-1')
    expect(row.time_block_id).toBe('tb-1')
    expect(row.activity_id).toBeNull()
    expect(row.location_id).toBeNull()
  })

  it('is order-independent — the row still lands with the three fields written in reverse order', () => {
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-rev', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-rev', field: 'group_id', value: 'grp-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM special_day_slots WHERE id = ?').get('sl-rev')).toBeUndefined()

    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-rev', field: 'special_day_id', value: 'sd-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    const row = db.prepare('SELECT * FROM special_day_slots WHERE id = ?').get('sl-rev')
    expect(row).toBeTruthy()
    expect(row.group_id).toBe('grp-1')
    expect(row.time_block_id).toBe('tb-1')
  })

  it('activity_id and location_id fill in on an existing row', () => {
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-1', field: 'special_day_id', value: 'sd-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-1', field: 'group_id', value: 'grp-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-1', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-1', 'camp-1', 'Swim')
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-1', field: 'activity_id', value: 'act-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT activity_id FROM special_day_slots WHERE id = ?').get('sl-1').activity_id).toBe('act-1')
  })

  it('stub-seeds the special_days parent when a special_day_slots op arrives for a day never seen locally', () => {
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-orphan', field: 'special_day_id', value: 'sd-never-seen',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-orphan', field: 'group_id', value: 'grp-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'special_day_slots', entity_id: 'sl-orphan', field: 'time_block_id', value: 'tb-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT 1 FROM special_days WHERE id = ?').get('sd-never-seen')).toBeTruthy()
    expect(db.prepare('SELECT * FROM special_day_slots WHERE id = ?').get('sl-orphan')).toBeTruthy()
  })
})
