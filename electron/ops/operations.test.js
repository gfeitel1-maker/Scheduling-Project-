// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOp, detectConflict } from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ops-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('appendOp', () => {
  it('inserts an op and it is retrievable via latestOp', () => {
    const op = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-1',
      field: 'activity_id',
      value: 'activity-1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    expect(op.id).toBeTruthy()
    expect(op.seq).toBeTruthy()
    expect(op.timestamp).toBeTruthy()

    const found = latestOp(db, 'template_slots', 'slot-1', 'activity_id')
    expect(found).toBeTruthy()
    expect(found.id).toBe(op.id)
    expect(found.seq).toBe(op.seq)
  })

  it('works when author_user_id is null (system-attributed op)', () => {
    const op = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-2',
      field: 'activity_id',
      value: 'activity-2',
      author_user_id: null,
      device_id: 'device-1',
      parent_op_id: null,
    })

    expect(op.author_user_id).toBeNull()
    const found = latestOp(db, 'template_slots', 'slot-2', 'activity_id')
    expect(found.id).toBe(op.id)
    expect(found.author_user_id).toBeNull()
  })
})

describe('appendOp projection', () => {
  it('updates the real users row when entity is users', () => {
    appendOp(db, {
      entity: 'users',
      entity_id: 'user-1',
      field: 'name',
      value: 'Alicia',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alicia')
  })
})

describe('appendOp field allowlist + transaction', () => {
  it('throws for a field not in the allowlist and does not insert an operations row', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n

    expect(() =>
      appendOp(db, {
        entity: 'users',
        entity_id: 'user-1',
        field: 'not_a_real_field',
        value: 'x',
        author_user_id: 'user-1',
        device_id: 'device-1',
        parent_op_id: null,
      })
    ).toThrow()

    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(after).toBe(before)

    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alice')
  })

  it('creates a brand-new users row via ensureExists when appending the first op for that entity_id', () => {
    appendOp(db, {
      entity: 'users',
      entity_id: 'brand-new-user',
      field: 'name',
      value: 'Fresh',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('brand-new-user')
    expect(row).toBeTruthy()
    expect(row.name).toBe('Fresh')
    expect(row.role).toBe('staff')
  })
})

describe('latestOp', () => {
  it('orders by seq, not timestamp, returning the most recently appended op', () => {
    const op1 = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-3',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const op2 = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-3',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: op1.id,
    })

    const found = latestOp(db, 'template_slots', 'slot-3', 'activity_id')
    expect(found.id).toBe(op2.id)
    expect(found.seq).toBeGreaterThan(op1.seq)
  })

  it('returns undefined when there is no op for the entity/entity_id/field', () => {
    const found = latestOp(db, 'template_slots', 'nonexistent-slot', 'activity_id')
    expect(found).toBeUndefined()
  })
})

describe('detectConflict', () => {
  it('reports no conflict when incoming op parent_op_id matches the current latest op id', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-4',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingOp = {
      entity: 'template_slots',
      entity_id: 'slot-4',
      field: 'activity_id',
      value: 'v2',
      parent_op_id: parentOp.id,
    }

    const result = detectConflict(db, incomingOp)
    expect(result.conflict).toBe(false)
  })

  it('reports a conflict when two ops diverge from the same parent', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const appliedOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: parentOp.id,
    })

    const incomingOp = {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v3',
      parent_op_id: parentOp.id,
    }

    const result = detectConflict(db, incomingOp)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(appliedOp.id)
  })
})
