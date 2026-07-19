// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken } from './localAuth.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-auth-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('createUser / verifyPin', () => {
  it('returns true for the correct PIN and false for an incorrect one', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Alice', pin: '1234', role: 'staff' })
    expect(user.id).toBeTruthy()
    expect(user.name).toBe('Alice')
    expect(user.role).toBe('staff')

    expect(verifyPin(db, user.id, '1234')).toBe(true)
    expect(verifyPin(db, user.id, '0000')).toBe(false)
  })

  it('never stores the raw PIN in the users row', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Bob', pin: '5678', role: 'admin' })
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
      createUser(db, { camp_id: 'camp-1', name: 'Test1', pin: '', role: 'staff' })
    ).toThrow()
  })

  it('createUser throws for a null PIN', () => {
    expect(() =>
      createUser(db, { camp_id: 'camp-1', name: 'Test2', pin: null, role: 'staff' })
    ).toThrow()
  })

  it('createUser throws for a PIN longer than 32 characters', () => {
    expect(() =>
      createUser(db, { camp_id: 'camp-1', name: 'Test3', pin: 'x'.repeat(33), role: 'staff' })
    ).toThrow()
  })

  it('createUser still works for a valid 4-char PIN (no regression)', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Test4', pin: '1234', role: 'staff' })
    expect(verifyPin(db, user.id, '1234')).toBe(true)
  })

  it('verifyPin throws for an invalid pin argument', () => {
    const user = createUser(db, { camp_id: 'camp-1', name: 'Test5', pin: '1234', role: 'staff' })
    expect(() => verifyPin(db, user.id, '')).toThrow()
    expect(() => verifyPin(db, user.id, null)).toThrow()
    expect(() => verifyPin(db, user.id, 'x'.repeat(33))).toThrow()
  })
})

describe('unique username per camp', () => {
  it('throws a clear error when creating a second user with the same name in the same camp', () => {
    createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '1111', role: 'staff' })
    expect(() =>
      createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '2222', role: 'admin' })
    ).toThrow(/already exists/)
  })

  it('allows two users with the same name in different camps', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')
    createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '1111', role: 'staff' })
    expect(() =>
      createUser(db, { camp_id: 'camp-2', name: 'Sam', pin: '2222', role: 'staff' })
    ).not.toThrow()
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
