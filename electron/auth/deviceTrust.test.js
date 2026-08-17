// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { deviceTrustStatus, deviceTrustReason } from './deviceTrust.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-devicetrust-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function insertDevice({ authorized = false, revoked = false, secret = randomBytes(32).toString('hex') } = {}) {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, revoked_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `Device ${id.slice(0, 8)}`,
    authorized ? new Date().toISOString() : null,
    revoked ? new Date().toISOString() : null,
    secret,
    authorized ? 'authorized' : 'pending'
  )
  return id
}

describe('deviceTrustStatus', () => {
  it('returns found:false and all-false flags for a device id with no row', () => {
    const trust = deviceTrustStatus(db, randomUUID())
    expect(trust).toEqual({ found: false, authorized: false, revoked: false, row: null })
  })

  it('returns found:true, authorized:true, revoked:false for a trusted device', () => {
    const id = insertDevice({ authorized: true, revoked: false })
    const trust = deviceTrustStatus(db, id)
    expect(trust.found).toBe(true)
    expect(trust.authorized).toBe(true)
    expect(trust.revoked).toBe(false)
    expect(trust.row.id).toBe(id)
  })

  it('returns authorized:false for a device that has never been authorized', () => {
    const id = insertDevice({ authorized: false, revoked: false })
    const trust = deviceTrustStatus(db, id)
    expect(trust.found).toBe(true)
    expect(trust.authorized).toBe(false)
    expect(trust.revoked).toBe(false)
  })

  it('returns revoked:true for a device revoked after being authorized', () => {
    const id = insertDevice({ authorized: true, revoked: true })
    const trust = deviceTrustStatus(db, id)
    expect(trust.found).toBe(true)
    expect(trust.authorized).toBe(true)
    expect(trust.revoked).toBe(true)
  })

  it('returns authorized:false, revoked:true for the reachable never-authorized-but-revoked state', () => {
    // Reachable because revokeDevice (electron/main.js) only requires the
    // device to exist — it does not require authorized_at to have been set.
    const id = insertDevice({ authorized: false, revoked: true })
    const trust = deviceTrustStatus(db, id)
    expect(trust.found).toBe(true)
    expect(trust.authorized).toBe(false)
    expect(trust.revoked).toBe(true)
  })

  it('includes device_secret_identifier on the raw row, for handleLogin', () => {
    const id = insertDevice({ authorized: true, secret: 'the-secret-value' })
    const trust = deviceTrustStatus(db, id)
    expect(trust.row.device_secret_identifier).toBe('the-secret-value')
  })
})

describe('deviceTrustReason', () => {
  it('returns device_not_found when not found', () => {
    expect(deviceTrustReason({ found: false, authorized: false, revoked: false })).toBe('device_not_found')
  })

  it('returns device_not_authorized when found but never authorized, not revoked', () => {
    expect(deviceTrustReason({ found: true, authorized: false, revoked: false })).toBe('device_not_authorized')
  })

  it('returns device_revoked when found, authorized, and revoked', () => {
    expect(deviceTrustReason({ found: true, authorized: true, revoked: true })).toBe('device_revoked')
  })

  it('returns null when found, authorized, and not revoked (fully trusted)', () => {
    expect(deviceTrustReason({ found: true, authorized: true, revoked: false })).toBeNull()
  })

  // Owner-directed harmonization (ADR C3): revoked wins over not-authorized.
  it('returns device_revoked (not device_not_authorized) for the reachable never-authorized-but-revoked combination', () => {
    expect(deviceTrustReason({ found: true, authorized: false, revoked: true })).toBe('device_revoked')
  })
})
