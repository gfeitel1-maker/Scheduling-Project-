// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §2): unit
// tests for the extracted, transport-independent admission decision that
// both syncServer.js's WS `handleAuthenticate` and the libp2p auth gate
// (authGate.js, via syncNode.js) now share. These tests cover the ADR's
// threat-model scenarios at the function level, independent of either
// transport.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes, createPrivateKey, sign as edSign } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { ensureHostSigningKey, issueCampToken, issueLocalToken } from './localAuth.js'
import { evaluateAuthenticate } from './connectionAuth.js'

let db, tmpFile

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-connauth-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
})

afterEach(() => {
  db.close()
  fs.unlinkSync(tmpFile)
})

function setupCampWithAuthorizedDevice(deviceId) {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run(deviceId, 'Device', new Date().toISOString(), randomBytes(32).toString('hex'))
  return campId
}

describe('evaluateAuthenticate — shared admission decision', () => {
  it('admits a valid camp token for an authorized device', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)

    const result = evaluateAuthenticate(db, { token, device_id: deviceId })

    expect(result.ok).toBe(true)
    expect(result.verified.deviceId).toBe(deviceId)
    expect(result.verified.type).toBe('camp')
  })

  it('rejects a local-type token even though it is structurally valid', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const userId = randomUUID()
    const localToken = issueLocalToken(db, userId, deviceId)

    const result = evaluateAuthenticate(db, { token: localToken, device_id: deviceId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4402)
    expect(result.reason).toBe('local_token_not_valid_for_network')
  })

  it('rejects a tampered token', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)
    const [payload] = token.split('.')
    const tampered = `${payload}.${'a'.repeat(43)}`

    const result = evaluateAuthenticate(db, { token: tampered, device_id: deviceId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4401)
    expect(result.reason).toBe('invalid_token')
  })

  it('rejects an expired token (re-signed with the real Host key, so this is exp-enforcement specifically, not a signature failure)', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)
    const [payloadB64] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    payload.exp = Date.now() - 1000
    const hostKey = db.prepare('SELECT private_key FROM host_signing_key WHERE id = 1').get()
    const expiredPayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const privateKeyObj = createPrivateKey({ key: Buffer.from(hostKey.private_key, 'hex'), format: 'der', type: 'pkcs8' })
    const expiredSignature = edSign(null, Buffer.from(expiredPayloadB64), privateKeyObj).toString('base64url')
    const expiredToken = `${expiredPayloadB64}.${expiredSignature}`

    const result = evaluateAuthenticate(db, { token: expiredToken, device_id: deviceId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4401)
    expect(result.reason).toBe('invalid_token')
  })

  it('rejects a token whose device_id does not match the claimed device', () => {
    const deviceId = randomUUID()
    const otherDeviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)

    const result = evaluateAuthenticate(db, { token, device_id: otherDeviceId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4401)
    expect(result.reason).toBe('invalid_token')
  })

  it('rejects a revoked device even with a structurally valid token', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)
    db.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?").run(
      new Date().toISOString(),
      deviceId
    )

    const result = evaluateAuthenticate(db, { token, device_id: deviceId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4404)
    expect(result.reason).toBe('device_revoked')
  })

  it('rejects an unauthorized (never-approved) device', () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
    const hostKey = ensureHostSigningKey(db)
    db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
    const deviceId = randomUUID()
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, 'Device')
    const token = issueCampToken(db, randomUUID(), deviceId)

    const result = evaluateAuthenticate(db, { token, device_id: deviceId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4403)
    expect(result.reason).toBe('device_not_authorized')
  })
})
