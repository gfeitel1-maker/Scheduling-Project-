// Amendment 2026-10-03, RISK-1 (docs/adr/2026-10-02-distributed-revocation-authority.md's "gate
// precedence & self-heal" section) — authority_cache, when a row exists, is authoritative for
// the revocation decision at evaluateAuthenticate/evaluateLogin; devices.revoked_at is consulted
// only when there is no row at all. Proves: a stale local revoked_at stamp on an actually-admin
// device no longer blocks it; a genuinely quorum-revoked device still blocks, even with NO
// devices.revoked_at stamp at all (enforcement does not depend on the legacy column once
// authority_cache says 'revoked'); a device with no authority_cache row at all is byte-for-byte
// governed by the legacy check, unchanged.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID, randomBytes, scryptSync } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { ensureHostSigningKey } from './localAuth.js'
import { signAuthFields } from './authSignature.js'
import { evaluateAuthenticate, evaluateLogin } from './connectionAuth.js'

afterAll(() => {
  cleanupTemplatedDbs()
})
let db, tmpFile

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  tmpFile = templated.file
})

afterEach(() => {
  db.close()
  fs.unlinkSync(tmpFile)
})

function setupCamp() {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Risk-1 Camp')
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  return campId
}

function insertDevice(deviceId, { authorized = true, revoked = false } = {}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, revoked_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    deviceId, 'Device',
    authorized ? now : null,
    revoked ? now : null,
    randomBytes(32).toString('hex'),
    revoked ? 'revoked' : authorized ? 'authorized' : 'pending'
  )
}

// The device is a roster member (a derived roster_cache row; the derivation itself is covered by
// deviceRoster.projector.test.js). evaluateAuthenticate admits on it, with no token.
const peerOf = (deviceId) => `peer-of-${deviceId}`
function roster(deviceId) {
  db.prepare('INSERT INTO roster_cache (device_id, peer_id, verified_at) VALUES (?, ?, ?)').run(deviceId, peerOf(deviceId), new Date().toISOString())
}

function setAuthorityCache(deviceId, status) {
  db.prepare('INSERT OR REPLACE INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)')
    .run(deviceId, status, new Date().toISOString())
}

function insertLoginableUser({ campId, deviceId, pin = '1234', role = 'admin' }) {
  const userId = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pinHash = scryptSync(pin, salt, 64).toString('hex')
  const authSig = signAuthFields(db, { id: userId, role, pin_hash: pinHash, pin_salt: salt, cred_version: 1 })
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  ).run(userId, campId, 'Director', pinHash, salt, role, authSig)
  void deviceId
  return { userId, pin }
}

describe('RISK-1 — evaluateAuthenticate gate precedence', () => {
  it('a stale devices.revoked_at does NOT block a device authority_cache says is admin', () => {
    setupCamp()
    const deviceId = randomUUID()
    insertDevice(deviceId, { authorized: true, revoked: true }) // stale local stamp
    roster(deviceId)
    setAuthorityCache(deviceId, 'admin') // but the real replay says this device is a valid admin

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })

    expect(result.ok).toBe(true)
  })

  it('authority_cache "revoked" still blocks, even with NO devices.revoked_at stamp at all', () => {
    setupCamp()
    const deviceId = randomUUID()
    insertDevice(deviceId, { authorized: true, revoked: false }) // never locally revoked
    roster(deviceId)
    setAuthorityCache(deviceId, 'revoked') // but quorum/replay says revoked

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4404)
    expect(result.reason).toBe('device_revoked_by_authority')
  })

  it('a device with no authority_cache row at all is governed by the legacy check, unchanged', () => {
    setupCamp()
    const liveDeviceId = randomUUID()
    insertDevice(liveDeviceId, { authorized: true, revoked: false })
    roster(liveDeviceId)
    expect(evaluateAuthenticate(db, { device_id: liveDeviceId, peerId: peerOf(liveDeviceId) }).ok).toBe(true)

    const revokedDeviceId = randomUUID()
    insertDevice(revokedDeviceId, { authorized: true, revoked: true })
    roster(revokedDeviceId)
    const result = evaluateAuthenticate(db, { device_id: revokedDeviceId, peerId: peerOf(revokedDeviceId) })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(4404)
    expect(result.reason).toBe('device_revoked')
  })
})

describe('RISK-1 — evaluateLogin gets the identical precedence', () => {
  it('a stale devices.revoked_at does NOT block login for a device authority_cache says is admin', () => {
    const campId = setupCamp()
    const deviceId = randomUUID()
    insertDevice(deviceId, { authorized: true, revoked: true })
    setAuthorityCache(deviceId, 'admin')
    const deviceSecretIdentifier = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId).device_secret_identifier
    const { pin } = insertLoginableUser({ campId, deviceId })

    const result = evaluateLogin(db, { device_id: deviceId, device_secret_identifier: deviceSecretIdentifier, name: 'Director', pin })

    expect(result.ok).toBe(true)
  })

  it('authority_cache "revoked" still blocks login, even with no devices.revoked_at stamp', () => {
    const campId = setupCamp()
    const deviceId = randomUUID()
    insertDevice(deviceId, { authorized: true, revoked: false })
    setAuthorityCache(deviceId, 'revoked')
    const deviceSecretIdentifier = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId).device_secret_identifier
    const { pin } = insertLoginableUser({ campId, deviceId })

    const result = evaluateLogin(db, { device_id: deviceId, device_secret_identifier: deviceSecretIdentifier, name: 'Director', pin })

    expect(result).toEqual({ ok: false, reason: 'not_paired' })
  })

  it('a device with no authority_cache row at all logs in exactly as it did before this amendment', () => {
    const campId = setupCamp()
    const deviceId = randomUUID()
    insertDevice(deviceId, { authorized: true, revoked: false })
    const deviceSecretIdentifier = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId).device_secret_identifier
    const { pin } = insertLoginableUser({ campId, deviceId })

    const result = evaluateLogin(db, { device_id: deviceId, device_secret_identifier: deviceSecretIdentifier, name: 'Director', pin })

    expect(result.ok).toBe(true)
  })
})
