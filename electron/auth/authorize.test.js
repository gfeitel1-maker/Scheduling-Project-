// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { issueSessionToken } from './localAuth.js'
import { authorize } from './authorize.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-authorize-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-1')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Test Device')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function insertUser({ id = randomUUID(), name = `User-${randomUUID()}`, role = 'staff' } = {}) {
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'camp-1', name, 'hash', 'salt', role)
  return id
}

describe('authorize', () => {
  it('allows a valid admin token for an admin-only action', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    const result = authorize({ db, token, action: 'users.create' })

    expect(result).toEqual({ allowed: true, userId, deviceId: 'device-1', role: 'admin' })
  })

  it('denies a valid staff token for an admin-only action', () => {
    const userId = insertUser({ role: 'staff' })
    const token = issueSessionToken(db, userId, 'device-1')

    const result = authorize({ db, token, action: 'users.create' })

    expect(result).toEqual({ allowed: false, reason: 'forbidden' })
  })

  it('allows a valid staff token for a staff-permitted action', () => {
    const userId = insertUser({ role: 'staff' })
    const token = issueSessionToken(db, userId, 'device-1')

    const result = authorize({ db, token, action: 'groups.write' })

    expect(result).toEqual({ allowed: true, userId, deviceId: 'device-1', role: 'staff' })
  })

  it('denies when the user row has been deleted since the token was issued', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    db.prepare('DELETE FROM users WHERE id = ?').run(userId)

    const result = authorize({ db, token, action: 'users.create' })

    expect(result).toEqual({ allowed: false, reason: 'user_not_found' })
  })

  it('denies when the device row has been deleted since the token was issued', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    db.prepare('DELETE FROM devices WHERE id = ?').run('device-1')

    const result = authorize({ db, token, action: 'users.create' })

    expect(result).toEqual({ allowed: false, reason: 'device_not_found' })
  })

  it('denies (default-deny) for an unknown action string, even for admin', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    // admin's '*' still matches anything, so use a non-admin role to prove
    // an unrecognized action is denied rather than silently allowed.
    const staffId = insertUser({ role: 'staff' })
    const staffToken = issueSessionToken(db, staffId, 'device-1')

    const result = authorize({ db, token: staffToken, action: 'not_a_real_action.explode' })

    expect(result).toEqual({ allowed: false, reason: 'forbidden' })
    // sanity: admin token still resolves fine for a real action
    expect(authorize({ db, token, action: 'users.create' }).allowed).toBe(true)
  })

  it('does not throw and denies for a missing token', () => {
    expect(() => authorize({ db, token: undefined, action: 'users.create' })).not.toThrow()
    expect(authorize({ db, token: undefined, action: 'users.create' })).toEqual({
      allowed: false,
      reason: 'invalid_token',
    })
  })

  it('does not throw and denies for a malformed token', () => {
    expect(() => authorize({ db, token: 'garbage-no-separator', action: 'users.create' })).not.toThrow()
    expect(authorize({ db, token: 'garbage-no-separator', action: 'users.create' })).toEqual({
      allowed: false,
      reason: 'invalid_token',
    })
  })

  it('does not throw and denies for null token', () => {
    expect(() => authorize({ db, token: null, action: 'users.create' })).not.toThrow()
    expect(authorize({ db, token: null, action: 'users.create' }).allowed).toBe(false)
  })

  it('re-reads role from the DB on every call, denying the SAME still-valid token after a role flip (admin -> staff)', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    expect(authorize({ db, token, action: 'users.create' })).toEqual({
      allowed: true,
      userId,
      deviceId: 'device-1',
      role: 'admin',
    })

    db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(userId)

    const result = authorize({ db, token, action: 'users.create' })

    expect(result).toEqual({ allowed: false, reason: 'forbidden' })
  })

  it('keeps every action reachable today by both roles reachable by both after this change (schedule + conflicts)', () => {
    const adminId = insertUser({ role: 'admin' })
    const staffId = insertUser({ role: 'staff' })
    const adminToken = issueSessionToken(db, adminId, 'device-1')
    const staffToken = issueSessionToken(db, staffId, 'device-1')

    const sharedActions = [
      'schedule_templates.read',
      'schedule_templates.write',
      'template_slots.read',
      'template_slots.write',
      'conflicts.read',
      'conflicts.resolve',
    ]

    for (const action of sharedActions) {
      expect(authorize({ db, token: adminToken, action }).allowed).toBe(true)
      expect(authorize({ db, token: staffToken, action }).allowed).toBe(true)
    }
  })

  it('keeps delete/bulk_replace admin-only for staff', () => {
    const staffId = insertUser({ role: 'staff' })
    const staffToken = issueSessionToken(db, staffId, 'device-1')

    expect(authorize({ db, token: staffToken, action: 'groups.delete' }).allowed).toBe(false)
    expect(authorize({ db, token: staffToken, action: 'groups.bulk_replace' }).allowed).toBe(false)
    expect(authorize({ db, token: staffToken, action: 'camps.rename' }).allowed).toBe(false)
  })

  it('accepts an unused resourceId without affecting the result', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    const result = authorize({ db, token, action: 'users.create', resourceId: 'some-resource' })

    expect(result.allowed).toBe(true)
  })

  it('does not throw and denies when a db-layer error occurs during the users/devices lookup', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    // Simulate a db in an unhealthy state (e.g. corrupted file, closed
    // handle, missing table) by dropping a table authorize() depends on.
    db.exec('DROP TABLE users')

    expect(() => authorize({ db, token, action: 'users.create' })).not.toThrow()
    expect(authorize({ db, token, action: 'users.create' })).toEqual({
      allowed: false,
      reason: 'db_error',
    })
  })

  it('denies an admin token when action is undefined, null, or an object, instead of matching the "*" shortcut', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    expect(authorize({ db, token, action: undefined })).toEqual({
      allowed: false,
      reason: 'invalid_action',
    })
    expect(authorize({ db, token, action: null })).toEqual({
      allowed: false,
      reason: 'invalid_action',
    })
    expect(authorize({ db, token, action: {} })).toEqual({
      allowed: false,
      reason: 'invalid_action',
    })
    expect(authorize({ db, token, action: '' })).toEqual({
      allowed: false,
      reason: 'invalid_action',
    })
  })
})
