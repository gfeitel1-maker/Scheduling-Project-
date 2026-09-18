// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §2): unit
// tests for the extracted, transport-independent admission decision that
// both syncServer.js's WS `handleAuthenticate` and the libp2p auth gate
// (authGate.js, via syncNode.js) now share. These tests cover the ADR's
// threat-model scenarios at the function level, independent of either
// transport.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID, randomBytes, createPrivateKey, sign as edSign, scryptSync } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { ensureHostSigningKey, issueCampToken, issueLocalToken, issueDeviceToken } from './localAuth.js'
import { signAuthFields } from './authSignature.js'
import { evaluateAuthenticate, evaluateLogin } from './connectionAuth.js'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
let db, tmpFile

beforeEach(() => {
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
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

// T162 (docs/adr/2026-09-14-device-identity-and-token-binding.md §3): sets up
// an authorized device (with a device_secret_identifier for evaluateLogin's
// own check) AND a user account attemptLogin can verify — mirrors
// pairingLogin.test.js's insertUser, inlined here so this stays a pure unit
// test isolated from libp2p (arbitrary peerId strings, same as existing
// tests pass arbitrary device_id strings).
function setupCampWithLoginableDevice(deviceId, { pin = '1234', role = 'admin' } = {}) {
  const campId = setupCampWithAuthorizedDevice(deviceId)
  const deviceSecretIdentifier = db
    .prepare('SELECT device_secret_identifier FROM devices WHERE id = ?')
    .get(deviceId).device_secret_identifier
  const userId = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pinHash = scryptSync(pin, salt, 64).toString('hex')
  const authSig = signAuthFields(db, { id: userId, role, pin_hash: pinHash, pin_salt: salt, cred_version: 1 })
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  ).run(userId, campId, 'Director', pinHash, salt, role, authSig)
  return { campId, deviceSecretIdentifier, userId, pin }
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

  // Finding 2 fix (Stage 5d-2b re-review): this is the regression test for
  // "the Host's self-issued token can never verify." Before this fix, the
  // Host self-issued issueCampToken(db, null, deviceId), which
  // verifySessionToken ALWAYS rejected (userId must be a non-empty string) —
  // evaluateAuthenticate could never reach this far for the Host's own
  // outbound authenticate. issueDeviceToken's admission-only 'device' type
  // must be ADMITTED here (the authorize()-side denial is a SEPARATE test in
  // authorize.test.js — admission and authorization are different layers).
  it('admits a Host-issued device (admission-only) token for an authorized device', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueDeviceToken(db, deviceId)

    const result = evaluateAuthenticate(db, { token, device_id: deviceId })

    expect(result.ok).toBe(true)
    expect(result.verified.deviceId).toBe(deviceId)
    expect(result.verified.type).toBe('device')
    expect(result.verified.userId).toBeNull()
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

// T162 (docs/adr/2026-09-14-device-identity-and-token-binding.md §3/§4):
// evaluateAuthenticate/evaluateLogin gain a `peerId` parameter and bind it to
// the device via bindOrVerifyPeerIdentity. Passing NO peerId (every test
// above) skips the bind check entirely — those tests exercise token/trust
// logic in isolation, unchanged.
describe('evaluateAuthenticate — peer identity binding (T162)', () => {
  it('a device with no bound peer id yet still succeeds and binds on first contact', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)

    const result = evaluateAuthenticate(db, { token, device_id: deviceId, peerId: 'peer-a' })

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(deviceId).libp2p_peer_id).toBe('peer-a')
  })

  it('a matching bound peer id still succeeds', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run('peer-a', deviceId)

    const result = evaluateAuthenticate(db, { token, device_id: deviceId, peerId: 'peer-a' })

    expect(result.ok).toBe(true)
  })

  it('a mismatched bound peer id is rejected with 4405/peer_identity_mismatch', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    const token = issueCampToken(db, randomUUID(), deviceId)
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run('peer-a', deviceId)

    const result = evaluateAuthenticate(db, { token, device_id: deviceId, peerId: 'peer-b' })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4405)
    expect(result.reason).toBe('peer_identity_mismatch')
    // The bound value must be untouched by a rejected mismatch.
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(deviceId).libp2p_peer_id).toBe('peer-a')
  })
})

describe('evaluateLogin — peer identity binding (T162)', () => {
  it('a device with no bound peer id yet still succeeds and binds on first login', () => {
    const deviceId = randomUUID()
    const { deviceSecretIdentifier, pin } = setupCampWithLoginableDevice(deviceId)

    const result = evaluateLogin(db, {
      device_id: deviceId,
      device_secret_identifier: deviceSecretIdentifier,
      name: 'Director',
      pin,
      peerId: 'peer-a',
    })

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(deviceId).libp2p_peer_id).toBe('peer-a')
  })

  it('a matching bound peer id still succeeds at login', () => {
    const deviceId = randomUUID()
    const { deviceSecretIdentifier, pin } = setupCampWithLoginableDevice(deviceId)
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run('peer-a', deviceId)

    const result = evaluateLogin(db, {
      device_id: deviceId,
      device_secret_identifier: deviceSecretIdentifier,
      name: 'Director',
      pin,
      peerId: 'peer-a',
    })

    expect(result.ok).toBe(true)
  })

  it('a mismatched bound peer id is rejected at login without a numeric code, matching the existing convention', () => {
    const deviceId = randomUUID()
    const { deviceSecretIdentifier, pin } = setupCampWithLoginableDevice(deviceId)
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run('peer-a', deviceId)

    const result = evaluateLogin(db, {
      device_id: deviceId,
      device_secret_identifier: deviceSecretIdentifier,
      name: 'Director',
      pin,
      peerId: 'peer-b',
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBeUndefined()
    expect(result.reason).toBe('peer_identity_mismatch')
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(deviceId).libp2p_peer_id).toBe('peer-a')
  })
})
