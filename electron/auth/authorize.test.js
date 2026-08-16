// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { issueLocalToken, issueCampToken, ensureHostSigningKey } from './localAuth.js'
import { authorize } from './authorize.js'

let tmpFile
let db

function issueSessionToken(db, userId, deviceId) {
  return issueLocalToken(db, userId, deviceId)
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-authorize-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-1')
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run('device-1', 'Test Device', new Date().toISOString(), randomBytes(32).toString('hex'))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
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

  it('records an audit_events row for a denied action', () => {
    const userId = insertUser({ role: 'staff' })
    const token = issueSessionToken(db, userId, 'device-1')

    authorize({ db, token, action: 'users.create' })

    const rows = db.prepare('SELECT * FROM audit_events WHERE actor_user_id = ?').all(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'users.create', outcome: 'deny', reason: 'forbidden' })
  })

  it('records an audit_events row for an allowed users.* action but not for a non-users.* allowed action', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueSessionToken(db, userId, 'device-1')

    authorize({ db, token, action: 'users.create' })
    authorize({ db, token, action: 'groups.write' })

    const rows = db.prepare('SELECT * FROM audit_events WHERE actor_user_id = ?').all(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'users.create', outcome: 'allow' })
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
    // Uses a camp token (not local) deliberately: a local token's signature
    // itself depends on the device row (HMAC keyed by its
    // device_secret_identifier), so deleting the row would make the token
    // fail signature verification and short-circuit to 'invalid_token'
    // before ever reaching authorize()'s own device-lookup step — which is
    // not what this test is isolating. A camp token's signature depends
    // only on the Host's key, so this exercises authorize()'s device
    // lookup specifically.
    const token = issueCampToken(db, userId, 'device-1')

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
      // Multi-week entities: ordinary camp-scoped field writes, so staff+admin
      // per the matrix (same as their sibling schedule entities above). These
      // regressed to admin-only once — see permissionsEntityParity.test.js.
      'schedule_weeks.read',
      'schedule_weeks.write',
      'week_activity_exclusions.read',
      'week_activity_exclusions.write',
      'week_group_exclusions.read',
      'week_group_exclusions.write',
      'week_location_exclusions.read',
      'week_location_exclusions.write',
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
    // Permanent week delete is admin-only: deleteWeekHandler (electron/main.js)
    // authorizes 'schedule_weeks.delete', which staff do NOT hold — staff keep
    // 'schedule_weeks.write' (create/edit/duplicate) but cannot permanently
    // delete a week and cascade away its snapshots/slots/overlays. This
    // assertion is the matrix half of that gate; deleteWeekHandler's use of the
    // '.delete' action is what makes it load-bearing.
    expect(authorize({ db, token: staffToken, action: 'schedule_weeks.delete' }).allowed).toBe(false)
  })

  it('lets staff DELETE week-exclusion rows (toggle-off), the deliberate delete exception', () => {
    const staffId = insertUser({ role: 'staff' })
    const staffToken = issueSessionToken(db, staffId, 'device-1')

    // Toggling an exclusion off is a row delete (DELETE_FIELD sentinel ->
    // '<entity>.delete'); staff must be able to un-exclude what they excluded.
    expect(authorize({ db, token: staffToken, action: 'week_activity_exclusions.delete' }).allowed).toBe(true)
    expect(authorize({ db, token: staffToken, action: 'week_group_exclusions.delete' }).allowed).toBe(true)
    expect(authorize({ db, token: staffToken, action: 'week_location_exclusions.delete' }).allowed).toBe(true)
    // The exception is scoped to those three entities only — no other camp entity
    // gains a staff '.delete' from this grant.
    expect(authorize({ db, token: staffToken, action: 'activities.delete' }).allowed).toBe(false)
    expect(authorize({ db, token: staffToken, action: 'template_slots.delete' }).allowed).toBe(false)
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

  it('denies with device_not_authorized for a device row that has never been authorized', () => {
    db.prepare(
      "INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')"
    ).run('device-pending', 'Pending Device')
    db.prepare('UPDATE devices SET device_secret_identifier = ? WHERE id = ?').run(
      randomBytes(32).toString('hex'),
      'device-pending'
    )
    const userId = insertUser({ role: 'admin' })
    const token = issueLocalToken(db, userId, 'device-pending')

    const result = authorize({ db, token, action: 'users.create' })

    expect(result).toEqual({ allowed: false, reason: 'device_not_authorized' })
  })

  it('denies with device_revoked for a device whose revoked_at is set, even with an otherwise-valid token', () => {
    const userId = insertUser({ role: 'admin' })
    const token = issueLocalToken(db, userId, 'device-1')

    // Sanity: works before revocation.
    expect(authorize({ db, token, action: 'users.create' }).allowed).toBe(true)

    db.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?").run(
      new Date().toISOString(),
      'device-1'
    )

    const result = authorize({ db, token, action: 'users.create' })
    expect(result).toEqual({ allowed: false, reason: 'device_revoked' })
  })

  it('re-derives revocation on every call — the SAME still-valid token is denied on its very next request after revocation', () => {
    const userId = insertUser({ role: 'staff' })
    const token = issueLocalToken(db, userId, 'device-1')

    expect(authorize({ db, token, action: 'groups.write' }).allowed).toBe(true)

    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), 'device-1')

    expect(authorize({ db, token, action: 'groups.write' })).toEqual({
      allowed: false,
      reason: 'device_revoked',
    })
  })
})
