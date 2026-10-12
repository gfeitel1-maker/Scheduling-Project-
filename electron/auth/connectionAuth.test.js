// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §2): unit tests for
// the transport-independent admission decision used by the libp2p auth gate
// (authGate.js, via syncNode.js). These tests cover the ADR's threat-model
// scenarios at the function level, independent of the transport.
//
// _Prior: the decision was described as shared by "both syncServer.js's WS
// `handleAuthenticate` and the libp2p auth gate". syncServer.js was deleted at the
// Stage 6c cutover, so there is one consumer now — see connectionAuth.js's own
// header for why the extraction is kept anyway. Testing at the function level
// rather than through a transport is still the right level._
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID, randomBytes, scryptSync } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { ensureHostSigningKey } from './localAuth.js'
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

// The roster binds a device id to the libp2p peer id the Host signed for it. These unit tests stand in for the
// derivation (projector.js's upsertDeviceRosterEntity, covered by deviceRoster.projector.test.js) by writing the
// derived roster_cache row directly.
const peerOf = (deviceId) => `peer-of-${deviceId}`
function rosterDevice(deviceId, peerId = peerOf(deviceId)) {
  db.prepare('INSERT INTO roster_cache (device_id, peer_id, verified_at) VALUES (?, ?, ?)').run(deviceId, peerId, new Date().toISOString())
}

function setupCampWithAuthorizedDevice(deviceId) {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run(deviceId, 'Device', new Date().toISOString(), randomBytes(32).toString('hex'))
  rosterDevice(deviceId)
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

describe('evaluateAuthenticate — shared admission decision (signed device roster, T376)', () => {
  it('admits a rostered device presenting its rostered peer id, with no token', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })

    expect(result.ok).toBe(true)
    expect(result.verified).toEqual({ deviceId, userId: null })
  })

  it('admits a rostered device that has no devices row at all (it enrolled on another device) and registers one', () => {
    const deviceId = randomUUID()
    rosterDevice(deviceId)

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get(deviceId).pairing_status).toBe('pending')
  })

  it('does not require devices.authorized_at: the roster is the positive membership fact', () => {
    const deviceId = randomUUID()
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, 'Device')
    rosterDevice(deviceId)

    expect(evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) }).ok).toBe(true)
  })

  it('rejects a device that is not on the roster with 4403/device_not_authorized', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('DELETE FROM roster_cache').run()

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })

    expect(result).toMatchObject({ ok: false, code: 4403, reason: 'device_not_authorized' })
  })

  it('an authorized devices row is not membership: authorized_at without a roster entry is refused', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('DELETE FROM roster_cache').run()
    db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date().toISOString(), deviceId)

    expect(evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) }).reason).toBe('device_not_authorized')
  })

  it('refuses a missing device id or peer id', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    expect(evaluateAuthenticate(db, { device_id: deviceId }).reason).toBe('device_not_authorized')
    expect(evaluateAuthenticate(db, { peerId: peerOf(deviceId) }).reason).toBe('device_not_authorized')
  })

  it('ignores a token entirely: a garbage token on a rostered device admits, and none rescues an unrostered one', () => {
    const rostered = randomUUID()
    setupCampWithAuthorizedDevice(rostered)
    const stranger = randomUUID()

    expect(evaluateAuthenticate(db, { token: 'garbage', device_id: rostered, peerId: peerOf(rostered) }).ok).toBe(true)
    expect(evaluateAuthenticate(db, { token: 'garbage', device_id: stranger, peerId: 'peer-stranger' }).reason).toBe('device_not_authorized')
  })

  it('a rostered device claiming another rostered device id gets 4405/peer_identity_mismatch', () => {
    const a = randomUUID()
    const b = randomUUID()
    setupCampWithAuthorizedDevice(a)
    rosterDevice(b)

    const result = evaluateAuthenticate(db, { device_id: a, peerId: peerOf(b) })

    expect(result).toMatchObject({ ok: false, code: 4405, reason: 'peer_identity_mismatch' })
  })

  it('a rostered device id presented from a different peer id gets 4405/peer_identity_mismatch', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: 'peer-of-a-stranger' })

    expect(result).toMatchObject({ ok: false, code: 4405, reason: 'peer_identity_mismatch' })
  })

  it('rejects a revoked device (legacy devices.revoked_at stamp)', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?").run(new Date().toISOString(), deviceId)

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })

    expect(result).toMatchObject({ ok: false, code: 4404, reason: 'device_revoked' })
  })

  it('T331 gate A: rejects a device the DISTRIBUTED authority_cache marks revoked even though it is rostered and devices.revoked_at was never set', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run(deviceId, 'revoked', new Date().toISOString())

    const result = evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })

    expect(result).toMatchObject({ ok: false, code: 4404, reason: 'device_revoked_by_authority' })
  })

  it('T331 gate A: admits a device the authority_cache marks admin', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run(deviceId, 'admin', new Date().toISOString())

    expect(evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) }).ok).toBe(true)
  })

  it('a fleet-confirmed admin is admitted despite a stale legacy devices.revoked_at stamp (RISK-1 precedence)', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId)
    db.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run(deviceId, 'admin', new Date().toISOString())

    expect(evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) }).ok).toBe(true)
  })

  it('audits the refusal of a rostered device, and writes nothing for an unrostered stranger', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run(deviceId, 'revoked', new Date().toISOString())
    const rows = () => db.prepare("SELECT outcome, reason FROM audit_events WHERE action = 'auth.authenticate'").all()

    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId) })
    expect(rows()).toEqual([{ outcome: 'deny', reason: 'device_revoked_by_authority' }])

    for (let i = 0; i < 5; i++) evaluateAuthenticate(db, { device_id: randomUUID(), peerId: `stranger-${i}` })
    expect(rows()).toHaveLength(1)
  })
})

// T322 S3a (docs/adr/2026-09-19-multi-device-erasure-propagation.md's "Addendum
// (2026-10-01, Architect, T322 S3a)"): a peer self-reports, in its `authenticate`
// request, the set of (tombstone id, version) pairs it has verified-and-projected.
// evaluateAuthenticate persists this into peer_tombstone_reports, keyed by the
// AUTHENTICATED verified.deviceId — never the raw, pre-verification device_id off
// the wire — and ONLY after the roster/revocation gate passes.
describe('evaluateAuthenticate — appliedTombstones self-report (T322 S3a)', () => {
  const reportsFor = (deviceId) =>
    db.prepare('SELECT * FROM peer_tombstone_reports WHERE device_id = ?').all(deviceId)

  it('persists a verified tombstone report for an admitted device', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    const result = evaluateAuthenticate(db, {
      device_id: deviceId,
      peerId: peerOf(deviceId),
      appliedTombstones: [{ id: 'camper-x', version: 1 }],
    })

    expect(result.ok).toBe(true)
    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ device_id: deviceId, tombstone_id: 'camper-x', version: 1 })
    expect(rows[0].reported_at).toBeTruthy()
  })

  it('has no row for a tombstone id never included in the report', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-x', version: 1 }] })

    expect(db.prepare('SELECT 1 FROM peer_tombstone_reports WHERE device_id = ? AND tombstone_id = ?').get(deviceId, 'camper-never-reported')).toBeUndefined()
  })

  // THE FORGED/UNAUTHENTICATED-WRITE PLANT. A token that fails verification, or a
  // revoked/unauthorized device, must never get its self-report persisted — the
  // write must happen strictly AFTER the trust/revocation gate, never before.
  it('never persists a report for a device that is not on the roster', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('DELETE FROM roster_cache').run()

    const result = evaluateAuthenticate(db, {
      device_id: deviceId,
      peerId: peerOf(deviceId),
      appliedTombstones: [{ id: 'camper-x', version: 1 }],
    })

    expect(result.ok).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM peer_tombstone_reports').get().c).toBe(0)
  })

  it('never persists a report for a revoked device', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId)

    const result = evaluateAuthenticate(db, {
      device_id: deviceId,
      peerId: peerOf(deviceId),
      appliedTombstones: [{ id: 'camper-x', version: 1 }],
    })

    expect(result.ok).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM peer_tombstone_reports').get().c).toBe(0)
  })

  it('never persists a report for a pending device that is not on the roster', () => {
    const deviceId = randomUUID()
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, 'Pending device')

    const result = evaluateAuthenticate(db, {
      device_id: deviceId,
      peerId: peerOf(deviceId),
      appliedTombstones: [{ id: 'camper-x', version: 1 }],
    })

    expect(result.ok).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM peer_tombstone_reports').get().c).toBe(0)
  })

  it('does not throw and does not corrupt the table on a non-array appliedTombstones', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    expect(() => evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: 'not-an-array' })).not.toThrow()
    expect(reportsFor(deviceId)).toHaveLength(0)
  })

  it('skips a malformed entry (missing id) without throwing or blocking the rest of the batch', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    expect(() =>
      evaluateAuthenticate(db, {
        device_id: deviceId,
        peerId: peerOf(deviceId),
        appliedTombstones: [{ version: 1 }, { id: 'camper-y', version: 2 }],
      })
    ).not.toThrow()
    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].tombstone_id).toBe('camper-y')
  })

  it('skips a malformed entry (negative version) without throwing or blocking the rest of the batch', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    expect(() =>
      evaluateAuthenticate(db, {
        device_id: deviceId,
        peerId: peerOf(deviceId),
        appliedTombstones: [{ id: 'camper-bad', version: -1 }, { id: 'camper-y', version: 2 }],
      })
    ).not.toThrow()
    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].tombstone_id).toBe('camper-y')
  })

  it('skips a malformed entry (non-string id) without throwing or blocking the rest of the batch', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    expect(() =>
      evaluateAuthenticate(db, {
        device_id: deviceId,
        peerId: peerOf(deviceId),
        appliedTombstones: [{ id: 42, version: 1 }, { id: 'camper-y', version: 2 }],
      })
    ).not.toThrow()
    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].tombstone_id).toBe('camper-y')
  })

  it('is idempotent: re-authenticating with the same payload does not duplicate or error', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-x', version: 1 }] })
    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-x', version: 1 }] })

    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(1)
  })

  // MONOTONIC GUARD (q-s3a-self-report-monotonic-guard). The self-report must only
  // ever advance a stored (device, tombstone) version. A stale/out-of-order
  // re-authenticate (an OLDER version arriving after a NEWER one for the same pair)
  // must be a no-op — never LOWER the stored version, which would flicker a peer's
  // S3b badge from LOGICALLY_ERASED back to UNKNOWN.
  it('does not lower the stored version when an OLDER report arrives after a newer one', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-x', version: 5 }] })
    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-x', version: 2 }] })

    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(5)
  })

  it('advances the stored version when a NEWER report arrives', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-x', version: 2 }] })
    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-x', version: 7 }] })

    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(7)
  })

  it('inserts a fresh (device, tombstone) report that has no prior row', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    evaluateAuthenticate(db, { device_id: deviceId, peerId: peerOf(deviceId), appliedTombstones: [{ id: 'camper-fresh', version: 3 }] })

    const rows = reportsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tombstone_id: 'camper-fresh', version: 3 })
  })

  it('persists only after the roster peer-identity binding also passes', () => {
    const deviceId = randomUUID()
    setupCampWithAuthorizedDevice(deviceId)

    const result = evaluateAuthenticate(db, {
      device_id: deviceId,
      peerId: 'peer-b',
      appliedTombstones: [{ id: 'camper-x', version: 1 }],
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe(4405)
    expect(reportsFor(deviceId)).toHaveLength(0)
  })
})

// T162 (docs/adr/2026-09-14-device-identity-and-token-binding.md §3/§4), reworked by T376: evaluateAuthenticate no longer
// TOFU-binds a peer id on first contact. The Host-signed roster fixes the binding, so a first contact from an
// unrostered peer id is refused (see the shared-admission describe above) and evaluateLogin keeps the TOFU bind below.

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
