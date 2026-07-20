// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken } from './localAuth.js'

let tmpFile
let db

const DEVICE_ID = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-auth-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(DEVICE_ID, 'Test Device')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('createUser / verifyPin', () => {
  it('returns true for the correct PIN and false for an incorrect one', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Alice', pin: '1234', role: 'staff', device_id: DEVICE_ID })
    expect(user.id).toBeTruthy()
    expect(user.name).toBe('Alice')
    expect(user.role).toBe('staff')

    expect(verifyPin(db, user.id, '1234')).toBe(true)
    expect(verifyPin(db, user.id, '0000')).toBe(false)
  })

  it('never stores the raw PIN in the users row', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Bob', pin: '5678', role: 'admin', device_id: DEVICE_ID })
    const row = db.prepare('SELECT pin_hash, pin_salt FROM users WHERE id = ?').get(user.id)
    expect(row.pin_hash).not.toBe('5678')
    expect(row.pin_salt).not.toBe('5678')
  })
})

describe('verifyPin resilience', () => {
  it('returns false instead of throwing for a nonexistent userId', () => {
    expect(() => verifyPin(db, 'nonexistent-user-id', '1234')).not.toThrow()
    expect(verifyPin(db, 'nonexistent-user-id', '1234')).toBe(false)
  })
})

describe('PIN input validation', () => {
  it('createUser throws for an empty PIN', () => {
    expect(() =>
      createUser(db, { camp_id: 'camp-1', name: 'Test1', pin: '', role: 'staff', device_id: DEVICE_ID })
    ).toThrow()
  })

  it('createUser throws for a null PIN', () => {
    expect(() =>
      createUser(db, { camp_id: 'camp-1', name: 'Test2', pin: null, role: 'staff', device_id: DEVICE_ID })
    ).toThrow()
  })

  it('createUser throws for a PIN longer than 32 characters', () => {
    expect(() =>
      createUser(db, { camp_id: 'camp-1', name: 'Test3', pin: 'x'.repeat(33), role: 'staff', device_id: DEVICE_ID })
    ).toThrow()
  })

  it('createUser still works for a valid 4-char PIN (no regression)', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Test4', pin: '1234', role: 'staff', device_id: DEVICE_ID })
    expect(verifyPin(db, user.id, '1234')).toBe(true)
  })

  it('verifyPin throws for an invalid pin argument', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Test5', pin: '1234', role: 'staff', device_id: DEVICE_ID })
    expect(() => verifyPin(db, user.id, '')).toThrow()
    expect(() => verifyPin(db, user.id, null)).toThrow()
    expect(() => verifyPin(db, user.id, 'x'.repeat(33))).toThrow()
  })
})

describe('unique username per camp', () => {
  it('throws a clear error when creating a second user with the same name in the same camp', () => {
    createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '1111', role: 'staff', device_id: DEVICE_ID })
    expect(() =>
      createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '2222', role: 'admin', device_id: DEVICE_ID })
    ).toThrow(/already exists/)
  })

  it('allows two users with the same name in different camps', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')
    createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '1111', role: 'staff', device_id: DEVICE_ID })
    expect(() =>
      createUser(db, { camp_id: 'camp-2', name: 'Sam', pin: '2222', role: 'staff', device_id: DEVICE_ID })
    ).not.toThrow()
  })
})

describe('createUser op-log integration', () => {
  it('emits exactly 5 operations rows for the new user, one per field, all with parent_op_id null', () => {
    const user = createUser(db, {
      camp_id: 'camp-1',
      name: 'Opuser',
      pin: '1234',
      role: 'staff',
      device_id: DEVICE_ID,
    })

    const ops = db
      .prepare('SELECT field, parent_op_id FROM operations WHERE entity = ? AND entity_id = ?')
      .all('users', user.id)

    expect(ops).toHaveLength(5)
    expect(ops.map((op) => op.field).sort()).toEqual(
      ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'].sort()
    )
    expect(ops.every((op) => op.parent_op_id === null)).toBe(true)
  })

  it('produces a queryable users row via projection with the correct name and role', () => {
    const user = createUser(db, {
      camp_id: 'camp-1',
      name: 'Opuser2',
      pin: '1234',
      role: 'admin',
      device_id: DEVICE_ID,
    })

    const row = db.prepare('SELECT name, role FROM users WHERE id = ?').get(user.id)
    expect(row.name).toBe('Opuser2')
    expect(row.role).toBe('admin')
  })
})

describe('issueSessionToken / verifySessionToken', () => {
  it('round-trips userId and deviceId correctly', () => {
    const token = issueSessionToken('user-1', 'device-1')
    const payload = verifySessionToken(token)
    expect(payload).toEqual({ userId: 'user-1', deviceId: 'device-1' })
  })

  it('returns null for a tampered token instead of throwing', () => {
    const token = issueSessionToken('user-1', 'device-1')
    const tampered = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A')
    expect(() => verifySessionToken(tampered)).not.toThrow()
    expect(verifySessionToken(tampered)).toBeNull()
  })

  it('returns null for malformed input instead of throwing', () => {
    expect(verifySessionToken('garbage-no-separator')).toBeNull()
    expect(verifySessionToken('')).toBeNull()
    expect(verifySessionToken(null)).toBeNull()
    expect(verifySessionToken('a.b.c')).toBeNull()
  })
})
