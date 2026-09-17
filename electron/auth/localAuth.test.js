// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, createPrivateKey, sign as edSign } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { SCRYPT_PARAMS, setScryptParamsForTests } from './localAuth.js'
import {
  createUser,
  verifyPin,
  issueCampToken,
  issueLocalToken,
  issueDeviceToken,
  verifySessionToken,
  attemptLogin,
  ensureHostSigningKey,
  hashPin,
} from './localAuth.js'
import { appendOp } from '../ops/operations.js'
import { verifyAuthFields } from './authSignature.js'

let tmpFile
// The suite-wide cost is lowered in vitest.setup.js — see the note there for
// why, and why it is safe. These two tests are the guard that makes it safe.
describe('the production hashing cost', () => {
  it('is the real one — this suite lowers it, and that must never be what ships', () => {
    expect(SCRYPT_PARAMS.N).toBe(65536)
    expect(SCRYPT_PARAMS.r).toBe(8)
    expect(SCRYPT_PARAMS.p).toBe(1)
  })

  it('mints at the REAL cost when nothing has lowered it, and that hash verifies', async () => {
    // The one case that pays full price on purpose: proof that the shipped
    // parameters actually work end to end, not just that the constant says so.
    setScryptParamsForTests()
    try {
      const user = await createUser(db, { camp_id: 'camp-1', name: 'RealCost', pin: '1234', role: 'staff' }, testWrite())
      const stored = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(user.id).pin_hash
      expect(stored).toContain(`N=${SCRYPT_PARAMS.N}`)
      expect(verifyPin(db, user.id, '1234')).toBe(true)
    } finally {
      setScryptParamsForTests({ N: 1024, maxmem: 32 * 1024 * 1024 }) // back to the suite-wide cost
    }
  }, 30_000)
})

let db

const DEVICE_ID = 'device-1'

beforeEach(() => {
  // Was openLocalDb(freshPath) — replays all 65 migrations, ~304ms per test.
  // The template copy is the same database that chain produces, ~10x cheaper.
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-1')
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run(DEVICE_ID, 'Test Device', new Date().toISOString(), randomBytes(32).toString('hex'))
  // Most of this file exercises attemptLogin as if run on the Host's own db
  // (matching the WS login handler, which runs in the Host process), so seed
  // a host_signing_key + matching camps.signing_public_key here — the same
  // thing bootstrapCamp() does for real. Individual tests that specifically
  // want the non-Host (issueLocalToken) path drop or skip this.
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

// Test-only write function matching syncClient's write() signature:
// ({ entity, entity_id, field, value }) => Promise<{ status, op? }>
// appendOp is only ever called directly from inside syncClient.js in real code;
// here we stand in for a local-mode syncClient so createUser's op-log routing
// can be exercised without spinning up a real syncClient instance.
function testWrite() {
  return async ({ entity, entity_id, field, value }) => {
    const op = appendOp(db, {
      entity,
      entity_id,
      field,
      value,
      author_user_id: null,
      device_id: DEVICE_ID,
      parent_op_id: null,
    })
    return { status: 'applied', op }
  }
}

describe('createUser / verifyPin', () => {
  it('returns true for the correct PIN and false for an incorrect one', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Alice', pin: '1234', role: 'staff' }, testWrite())
    expect(user.id).toBeTruthy()
    expect(user.name).toBe('Alice')
    expect(user.role).toBe('staff')

    expect(verifyPin(db, user.id, '1234')).toBe(true)
    expect(verifyPin(db, user.id, '0000')).toBe(false)
  })

  it('never stores the raw PIN in the users row', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Bob', pin: '567890', role: 'admin' }, testWrite())
    const row = db.prepare('SELECT pin_hash, pin_salt FROM users WHERE id = ?').get(user.id)
    expect(row.pin_hash).not.toBe('5678')
    expect(row.pin_salt).not.toBe('5678')
  })

  // Q1 slice 2: a created user carries a Host signature that verifies over its credential fields.
  it('stamps a Host auth_sig that verifies over {id, role, pin_hash, pin_salt}', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Signed', pin: '1234', role: 'staff' }, testWrite())
    const row = db.prepare('SELECT role, pin_hash, pin_salt, auth_sig, cred_version FROM users WHERE id = ?').get(user.id)
    const pub = db.prepare('SELECT signing_public_key FROM camps LIMIT 1').get().signing_public_key
    expect(row.auth_sig).not.toBe('')
    expect(verifyAuthFields(pub, { id: user.id, role: row.role, pin_hash: row.pin_hash, pin_salt: row.pin_salt, cred_version: row.cred_version }, row.auth_sig)).toBe(true)
    // tamper: the same signature must not validate a smuggled admin role
    expect(verifyAuthFields(pub, { id: user.id, role: 'admin', pin_hash: row.pin_hash, pin_salt: row.pin_salt, cred_version: row.cred_version }, row.auth_sig)).toBe(false)
  })
})

describe('verifyPin resilience', () => {
  it('returns false instead of throwing for a nonexistent userId', () => {
    expect(() => verifyPin(db, 'nonexistent-user-id', '1234')).not.toThrow()
    expect(verifyPin(db, 'nonexistent-user-id', '1234')).toBe(false)
  })
})

describe('PIN input validation', () => {
  it('createUser throws for an empty PIN', async () => {
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'Test1', pin: '', role: 'staff' }, testWrite())
    ).rejects.toThrow()
  })

  it('createUser throws for a null PIN', async () => {
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'Test2', pin: null, role: 'staff' }, testWrite())
    ).rejects.toThrow()
  })

  it('createUser throws for a PIN longer than 32 characters', async () => {
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'Test3', pin: 'x'.repeat(33), role: 'staff' }, testWrite())
    ).rejects.toThrow()
  })

  it('createUser still works for a valid 4-char PIN (no regression)', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Test4', pin: '1234', role: 'staff' }, testWrite())
    expect(verifyPin(db, user.id, '1234')).toBe(true)
  })

  it('verifyPin throws for an invalid pin argument', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Test5', pin: '1234', role: 'staff' }, testWrite())
    expect(() => verifyPin(db, user.id, '')).toThrow()
    expect(() => verifyPin(db, user.id, null)).toThrow()
    expect(() => verifyPin(db, user.id, 'x'.repeat(33))).toThrow()
  })
})

// T163 (owner decision 2026-09-14, SECURITY.md T150): admin PINs need 6+
// digits, staff keep 4; both roles are digits-only now.
describe('PIN length by role (T163)', () => {
  it('createUser rejects a 5-digit admin PIN', async () => {
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'ShortAdmin', pin: '12345', role: 'admin' }, testWrite())
    ).rejects.toThrow(/at least 6 digits/)
  })

  it('createUser accepts a 6-digit admin PIN', async () => {
    const user = await createUser(
      db,
      { camp_id: 'camp-1', name: 'LongAdmin', pin: '123456', role: 'admin' },
      testWrite()
    )
    expect(verifyPin(db, user.id, '123456')).toBe(true)
  })

  it('createUser rejects a 3-digit staff PIN', async () => {
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'ShortStaff', pin: '123', role: 'staff' }, testWrite())
    ).rejects.toThrow(/at least 4 digits/)
  })

  it('createUser accepts a 4-digit staff PIN (no regression)', async () => {
    const user = await createUser(
      db,
      { camp_id: 'camp-1', name: 'OkStaff', pin: '1234', role: 'staff' },
      testWrite()
    )
    expect(verifyPin(db, user.id, '1234')).toBe(true)
  })

  it('createUser rejects a non-digit PIN for staff', async () => {
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'LetterStaff', pin: 'abcd', role: 'staff' }, testWrite())
    ).rejects.toThrow(/only digits/)
  })

  it('createUser rejects a non-digit PIN for admin', async () => {
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'LetterAdmin', pin: 'abcdef', role: 'admin' }, testWrite())
    ).rejects.toThrow(/only digits/)
  })
})

describe('unique username per camp', () => {
  it('throws a clear error when creating a second user with the same name in the same camp', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '1111', role: 'staff' }, testWrite())
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '222222', role: 'admin' }, testWrite())
    ).rejects.toThrow(/already exists/)
  })

  it('rejects the duplicate BEFORE emitting any ops (clean no-op rejection)', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Sam2', pin: '1111', role: 'staff' }, testWrite())
    const opsBefore = db.prepare('SELECT COUNT(*) as n FROM operations').get().n

    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'Sam2', pin: '222222', role: 'admin' }, testWrite())
    ).rejects.toThrow(/already exists/)

    const opsAfter = db.prepare('SELECT COUNT(*) as n FROM operations').get().n
    expect(opsAfter).toBe(opsBefore)
  })

  it('allows two users with the same name in different camps', async () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')
    await createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '1111', role: 'staff' }, testWrite())
    await expect(
      createUser(db, { camp_id: 'camp-2', name: 'Sam', pin: '2222', role: 'staff' }, testWrite())
    ).resolves.not.toThrow()
  })
})

describe('createUser op-log integration', () => {
  it('routes all 7 field writes through the provided write function instead of calling appendOp directly', async () => {
    const calls = []
    const write = async ({ entity, entity_id, field, value }) => {
      calls.push({ entity, entity_id, field, value })
      const op = appendOp(db, {
        entity,
        entity_id,
        field,
        value,
        author_user_id: null,
        device_id: DEVICE_ID,
        parent_op_id: null,
      })
      return { status: 'applied', op }
    }

    const user = await createUser(db, { camp_id: 'camp-1', name: 'Opuser0', pin: '1234', role: 'staff' }, write)

    expect(calls).toHaveLength(7)
    expect(calls.every((c) => c.entity === 'users' && c.entity_id === user.id)).toBe(true)
    expect(calls.map((c) => c.field).sort()).toEqual(['camp_id', 'name', 'pin_hash', 'pin_salt', 'role', 'auth_sig', 'cred_version'].sort())
  })

  it('emits exactly 7 operations rows for the new user, one per field, all with parent_op_id null', async () => {
    const user = await createUser(
      db,
      { camp_id: 'camp-1', name: 'Opuser', pin: '1234', role: 'staff' },
      testWrite()
    )

    const ops = db
      .prepare('SELECT field, parent_op_id FROM operations WHERE entity = ? AND entity_id = ?')
      .all('users', user.id)

    expect(ops).toHaveLength(7)
    expect(ops.map((op) => op.field).sort()).toEqual(
      ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role', 'auth_sig', 'cred_version'].sort()
    )
    expect(ops.every((op) => op.parent_op_id === null)).toBe(true)
  })

  it('produces a queryable users row via projection with the correct name and role', async () => {
    const user = await createUser(
      db,
      { camp_id: 'camp-1', name: 'Opuser2', pin: '123456', role: 'admin' },
      testWrite()
    )

    const row = db.prepare('SELECT name, role FROM users WHERE id = ?').get(user.id)
    expect(row.name).toBe('Opuser2')
    expect(row.role).toBe('admin')
  })

  it('converts a SQLITE_CONSTRAINT_UNIQUE-shaped error from write() into the friendly duplicate-name error', async () => {
    const write = async () => {
      const err = new Error('UNIQUE constraint failed')
      err.code = 'SQLITE_CONSTRAINT_UNIQUE'
      throw err
    }

    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'RaceUser', pin: '1234', role: 'staff' }, write)
    ).rejects.toThrow(/already exists/)
  })
})

describe('createUser status-blindness fix', () => {
  it('throws a clear error and stops after the first field when write() resolves a non-applied status', async () => {
    const calls = []
    const write = async (args) => {
      calls.push(args)
      return { status: 'queued' }
    }

    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'OfflineUser', pin: '1234', role: 'staff' }, write)
    ).rejects.toThrow(/active connection to the camp's sync host/)

    expect(calls).toHaveLength(1)
  })

  it('throws after the 3rd field when it resolves timeout, without calling write for remaining fields', async () => {
    const calls = []
    const write = async (args) => {
      calls.push(args)
      if (calls.length <= 2) return { status: 'applied' }
      return { status: 'timeout' }
    }

    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'TimeoutUser', pin: '1234', role: 'staff' }, write)
    ).rejects.toThrow(/active connection to the camp's sync host/)

    expect(calls).toHaveLength(3)
  })

  it('still succeeds when all 5 writes resolve applied (happy path unchanged)', async () => {
    const user = await createUser(
      db,
      { camp_id: 'camp-1', name: 'HappyUser', pin: '1234', role: 'staff' },
      testWrite()
    )
    expect(user.name).toBe('HappyUser')
    expect(verifyPin(db, user.id, '1234')).toBe(true)
  })
})

describe('ensureHostSigningKey', () => {
  it('generates a keypair exactly once — a second call returns the SAME key, not a freshly-generated one, and only one row ever exists', () => {
    const first = ensureHostSigningKey(db)
    expect(first.public_key).toEqual(expect.any(String))
    expect(first.private_key).toEqual(expect.any(String))

    const second = ensureHostSigningKey(db)
    expect(second.public_key).toBe(first.public_key)
    expect(second.private_key).toBe(first.private_key)

    const rows = db.prepare('SELECT * FROM host_signing_key').all()
    expect(rows).toHaveLength(1)
  })
})

describe('issueCampToken / issueLocalToken / verifySessionToken', () => {
  it('round-trips userId/deviceId through a Host-signed camp token', () => {
    const token = issueCampToken(db, 'user-1', 'device-1')
    const payload = verifySessionToken(db, token)
    expect(payload).toMatchObject({ userId: 'user-1', deviceId: 'device-1', type: 'camp' })
  })

  it('round-trips userId/deviceId through a device-HMAC local token', () => {
    const token = issueLocalToken(db, 'user-1', DEVICE_ID)
    const payload = verifySessionToken(db, token)
    expect(payload).toMatchObject({ userId: 'user-1', deviceId: DEVICE_ID, type: 'local' })
  })

  it('issueCampToken throws when this device has no host_signing_key row (is not the Host)', () => {
    const otherFile = path.join(os.tmpdir(), `shoresh-localauth-notthehost-${Date.now()}-${Math.random()}.sqlite`)
    const clientDb = openLocalDb(otherFile)
    clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')

    expect(() => issueCampToken(clientDb, 'user-1', 'device-1')).toThrow(/not the Host/)

    clientDb.close()
    fs.unlinkSync(otherFile)
  })

  // Finding 2 fix (Stage 5d-2b re-review): the Host's self-issued token for
  // authenticating outward over libp2p used to be issueCampToken(db, null,
  // deviceId) — a userId:null 'camp' token that verifySessionToken ALWAYS
  // rejected (`typeof userId !== 'string'` fails on null), so the Host could
  // never authenticate to any peer. issueDeviceToken mints a distinct
  // 'device' type that carries no userId at all and round-trips through
  // verifySessionToken, closing that dead path.
  it('round-trips deviceId (and no userId) through a Host-signed device token', () => {
    const token = issueDeviceToken(db, 'device-1')
    const payload = verifySessionToken(db, token)
    expect(payload).toMatchObject({ deviceId: 'device-1', type: 'device', userId: null })
  })

  it('issueDeviceToken throws when this device has no host_signing_key row (is not the Host)', () => {
    const otherFile = path.join(os.tmpdir(), `shoresh-localauth-devicetoken-notthehost-${Date.now()}-${Math.random()}.sqlite`)
    const clientDb = openLocalDb(otherFile)
    clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')

    expect(() => issueDeviceToken(clientDb, 'device-1')).toThrow(/not the Host/)

    clientDb.close()
    fs.unlinkSync(otherFile)
  })

  it('a device token is verified with the SAME Host signing key as a camp token (Ed25519, not HMAC)', () => {
    const token = issueDeviceToken(db, 'device-1')
    const [payloadB64, signature] = token.split('.')
    // Tamper the payload — a device token, exactly like a camp token, must
    // fail signature verification on tamper, not merely on missing userId.
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    payload.deviceId = 'device-2'
    const forgedPayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    expect(verifySessionToken(db, `${forgedPayloadB64}.${signature}`)).toBeNull()
  })

  it('issueLocalToken throws when the device has no device_secret_identifier (not paired)', () => {
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES ('unpaired', 'Unpaired', 'pending')").run()
    expect(() => issueLocalToken(db, 'user-1', 'unpaired')).toThrow(/device_secret_identifier/)
  })

  it('rejects a camp token issued against a DIFFERENT camp/db Host key', () => {
    const otherFile = path.join(os.tmpdir(), `shoresh-localauth-othercamp-${Date.now()}-${Math.random()}.sqlite`)
    const otherDb = openLocalDb(otherFile)
    otherDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-other', 'Other Camp')
    const otherHostKey = ensureHostSigningKey(otherDb)
    otherDb.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(otherHostKey.public_key, 'camp-other')

    const tokenFromOtherCamp = issueCampToken(otherDb, 'user-1', 'device-1')
    expect(verifySessionToken(db, tokenFromOtherCamp)).toBeNull()

    otherDb.close()
    fs.unlinkSync(otherFile)
  })

  it('a local token is verifiable only against the SAME device_secret_identifier, not a different device\'s', () => {
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES ('device-2', 'Other Device', ?, ?, 'authorized')"
    ).run(new Date().toISOString(), randomBytes(32).toString('hex'))

    const token = issueLocalToken(db, 'user-1', DEVICE_ID)
    // Tamper the deviceId claim to point at device-2's secret instead.
    const [payloadB64] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    payload.deviceId = 'device-2'
    const forgedPayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const forged = `${forgedPayloadB64}.${token.split('.')[1]}`

    expect(verifySessionToken(db, forged)).toBeNull()
  })

  it('rejects an expired token', () => {
    const token = issueCampToken(db, 'user-1', 'device-1')
    const [payloadB64, signature] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    payload.exp = Date.now() - 1000
    // Re-sign with the same Host key so this exercises exp-enforcement
    // specifically, not signature failure.
    const hostKey = db.prepare('SELECT private_key FROM host_signing_key WHERE id = 1').get()
    void signature
    const expiredPayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const privateKeyObj = createPrivateKey({ key: Buffer.from(hostKey.private_key, 'hex'), format: 'der', type: 'pkcs8' })
    const expiredSignature = edSign(null, Buffer.from(expiredPayloadB64), privateKeyObj).toString('base64url')
    const expiredToken = `${expiredPayloadB64}.${expiredSignature}`

    expect(verifySessionToken(db, expiredToken)).toBeNull()
  })

  it('rejects malformed/missing type without throwing', () => {
    const token = issueCampToken(db, 'user-1', 'device-1')
    const [payloadB64] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    delete payload.type
    const noTypePayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const noTypeToken = `${noTypePayloadB64}.${token.split('.')[1]}`
    expect(() => verifySessionToken(db, noTypeToken)).not.toThrow()
    expect(verifySessionToken(db, noTypeToken)).toBeNull()

    payload.type = 'not-a-real-type'
    const badTypePayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const badTypeToken = `${badTypePayloadB64}.${token.split('.')[1]}`
    expect(() => verifySessionToken(db, badTypeToken)).not.toThrow()
    expect(verifySessionToken(db, badTypeToken)).toBeNull()
  })

  it('rejects a tampered token', () => {
    const token = issueCampToken(db, 'user-1', 'device-1')
    // Flip a character comfortably inside the signature (not the very last
    // char) — the last base64url character of a byte string can encode only
    // a couple of unused bits, so some single-character edits there
    // coincidentally decode to the same bytes and would flakily pass.
    const idx = token.length - 5
    const flipped = token[idx] === 'A' ? 'B' : 'A'
    const tampered = token.slice(0, idx) + flipped + token.slice(idx + 1)
    expect(() => verifySessionToken(db, tampered)).not.toThrow()
    expect(verifySessionToken(db, tampered)).toBeNull()
  })

  it('rejects tokens with a mutated payload across many random tamper attempts', () => {
    // Flipping a single base64url character in the raw token string is not
    // a reliable tamper: some bit positions in a base64url character land
    // on padding bits that don't survive re-decoding, so the flip can
    // occasionally decode back to the SAME bytes it started from (the
    // same root cause documented for the Sync-Task 3 test flake in project
    // memory — ~6% of single-character flips are semantically no-ops).
    // Guarantee a REAL semantic change instead: mutate the decoded JSON
    // payload itself (a field value), then re-encode — this is always a
    // different payload, so the signature must always fail to verify it.
    for (let i = 0; i < 20; i++) {
      const token = issueCampToken(db, `user-${i}`, `device-${i}`)
      const [payloadB64, signature] = token.split('.')
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
      payload.userId = `${payload.userId}-tampered`
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      const tampered = `${tamperedPayloadB64}.${signature}`
      expect(verifySessionToken(db, tampered)).toBeNull()
    }
  })

  it('rejects malformed tokens without throwing', () => {
    expect(verifySessionToken(db, 'garbage-no-separator')).toBeNull()
    expect(verifySessionToken(db, '')).toBeNull()
    expect(verifySessionToken(db, null)).toBeNull()
    expect(verifySessionToken(db, 'a.b.c')).toBeNull()
  })
})

// Deviation from the plan: the plan's attemptLogin tests each created their
// own randomUUID() camp, but this file's beforeEach already seeds a
// 'camp-1' row, and attemptLogin (like the login() it was extracted from)
// looks up its camp via `SELECT id FROM camps LIMIT 1` — a second camp row
// would just be ignored (or picked ahead of it non-deterministically),
// making a new user created under a fresh camp id invisible to the lookup.
// Fixed by reusing the pre-seeded 'camp-1' for the positive-path tests, and
// by deleting it for the "no camp exists" test so that case is genuine.
describe('attemptLogin', () => {
  it('returns a token for correct camp-scoped name and pin', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Wanda', pin: '1234', role: 'staff' }, testWrite())

    const result = attemptLogin(db, { name: 'Wanda', pin: '1234', deviceId: 'device-1' })
    expect(result.token).toEqual(expect.any(String))
    expect(result.userId).toBe(user.id)
    expect(result.role).toBe('staff')
  })

  it('returns null for a wrong pin', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Xena', pin: '1234', role: 'staff' }, testWrite())

    expect(attemptLogin(db, { name: 'Xena', pin: 'wrong', deviceId: 'device-1' })).toBeNull()
  })

  it('returns null when no camp exists at all', () => {
    db.prepare('DELETE FROM camps').run()
    expect(attemptLogin(db, { name: 'Nobody', pin: '1234', deviceId: 'device-1' })).toBeNull()
  })

  it('locks out after 5 failed attempts and reports retryAfterMs', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Yara', pin: '5555', role: 'staff' }, testWrite())

    // A FROZEN CLOCK, and the reason is worth stating because it looks like
    // test convenience and is not. Verifying a PIN costs a real scrypt hash at
    // T150's raised parameters, so driving five failed attempts spends seconds
    // of real time. On a loaded machine it once spent MORE than the 30-second
    // lockout window — so the window expired mid-test, the sixth attempt
    // succeeded, and the test reported "the lockout does not work" when what
    // happened was "this machine was too slow to finish setting up".
    //
    // That is the worst kind of failing test: it blames the security property
    // for the harness's problem, and it teaches people to re-run it. With time
    // held still, the six hashes can take as long as they like and the property
    // under test is the only thing that can fail.
    const frozen = () => 1_700_000_000_000
    for (let i = 0; i < 5; i++) {
      expect(attemptLogin(db, { name: 'Yara', pin: 'wrong', deviceId: 'device-1' }, { now: frozen })).toBeNull()
    }
    const result = attemptLogin(db, { name: 'Yara', pin: '5555', deviceId: 'device-1' }, { now: frozen })
    expect(result).toEqual({ locked: true, retryAfterMs: expect.any(Number) })
    // Exactly the window, because nothing has been allowed to elapse.
    expect(result.retryAfterMs).toBe(30_000)
  })

  it('the lockout expires — the correct PIN works again once the window has passed', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Yuri', pin: '5555', role: 'staff' }, testWrite())

    let clock = 1_700_000_000_000
    const now = () => clock
    for (let i = 0; i < 5; i++) {
      attemptLogin(db, { name: 'Yuri', pin: 'wrong', deviceId: 'device-1' }, { now })
    }
    expect(attemptLogin(db, { name: 'Yuri', pin: '5555', deviceId: 'device-1' }, { now })?.locked).toBe(true)

    // Advance past the window. Free, and deterministic — the old shape of this
    // test would have had to sleep 30 seconds to cover it, so it never did.
    clock += 30_001
    const after = attemptLogin(db, { name: 'Yuri', pin: '5555', deviceId: 'device-1' }, { now })
    expect(after.locked).toBeUndefined()
    expect(after.token).toBeTruthy()
  })

  it('still uses the real clock when nobody injects one', async () => {
    // The production path. Guards against the injection quietly becoming
    // required, which would make every caller that forgot it behave oddly.
    await createUser(db, { camp_id: 'camp-1', name: 'Yoko', pin: '5555', role: 'staff' }, testWrite())
    expect(attemptLogin(db, { name: 'Yoko', pin: '5555', deviceId: 'device-1' })?.token).toBeTruthy()
  })

  it('issues a token bound to the deviceId passed in, not any other device', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Zane', pin: '999999', role: 'admin' }, testWrite())

    const result = attemptLogin(db, { name: 'Zane', pin: '999999', deviceId: 'remote-device-42' })
    const verified = verifySessionToken(db, result.token)
    expect(verified.deviceId).toBe('remote-device-42')
  })

  it('records an audit_events row for a successful login', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Wanda2', pin: '1234', role: 'staff' }, testWrite())

    attemptLogin(db, { name: 'Wanda2', pin: '1234', deviceId: 'device-1' })

    const rows = db.prepare('SELECT * FROM audit_events WHERE action = ?').all('auth.login')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_user_id: user.id, outcome: 'allow' })
  })

  it('records an audit_events row for a failed login with an invalid_pin reason', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Xena2', pin: '1234', role: 'staff' }, testWrite())

    attemptLogin(db, { name: 'Xena2', pin: 'wrong', deviceId: 'device-1' })

    const rows = db.prepare('SELECT * FROM audit_events WHERE action = ?').all('auth.login')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'deny', reason: 'invalid_pin' })
  })

  it('records an audit_events row for a login by a nonexistent user with a user_not_found reason', () => {
    attemptLogin(db, { name: 'Nobody2', pin: '1234', deviceId: 'device-1' })

    const rows = db.prepare('SELECT * FROM audit_events WHERE action = ?').all('auth.login')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'deny', reason: 'user_not_found', actor_user_id: null })
  })

  it('issues a camp token (not local) when run on a db that holds host_signing_key, per the Host/Client dispatch rule', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'HostUser', pin: '444444', role: 'admin' }, testWrite())

    const result = attemptLogin(db, { name: 'HostUser', pin: '444444', deviceId: 'device-1' })
    const verified = verifySessionToken(db, result.token)
    expect(verified.type).toBe('camp')
  })

  it('issues a local token (not camp) when run on a db that is NOT the Host', async () => {
    const otherFile = path.join(os.tmpdir(), `shoresh-localauth-clientlogin-${Date.now()}-${Math.random()}.sqlite`)
    const clientDb = openLocalDb(otherFile)
    clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
    clientDb.prepare(
      `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
       VALUES (?, ?, ?, ?, 'authorized')`
    ).run('device-1', 'Test Device', new Date().toISOString(), randomBytes(32).toString('hex'))

    // A Client device does not run createUser (that is a Host-only operation now — only the Host can
    // sign credential fields, Q1 fix). It receives user rows via REPLICATION from the Host. Seed the
    // row directly to mirror that: an already-synced admin the client can authenticate offline.
    const salt = randomBytes(16).toString('hex')
    clientDb.prepare(
      "INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig) VALUES (?, 'camp-1', 'ClientUser', ?, ?, 'admin', '')"
    ).run(randomUUID(), hashPin('444444', salt), salt)

    const result = attemptLogin(clientDb, { name: 'ClientUser', pin: '444444', deviceId: 'device-1' })
    const verified = verifySessionToken(clientDb, result.token)
    expect(verified.type).toBe('local')

    clientDb.close()
    fs.unlinkSync(otherFile)
  })
})

// --- PIN hashing cost, and the legacy format that must keep verifying (T150) ---
//
// `users.pin_hash`/`pin_salt` are modeled document fields: they replicate to
// every approved device and sit in a plaintext file on each one. Raising the
// scrypt cost does not make a four-digit PIN safe — nothing does — but it is
// nearly free and it is the only lever available without changing the product.
// What these pin is that the raise cannot silently break existing logins, and
// that the parameters travel WITH the hash so the next raise needs no flag day.
describe('PIN hashing cost and format', () => {
  it('a new hash is self-describing — it carries the parameters it was made with', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Costed', pin: '1234', role: 'staff' }, testWrite())
    const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(user.id)
    expect(row.pin_hash).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$[0-9a-f]+$/)
    expect(verifyPin(db, user.id, '1234')).toBe(true)
    expect(verifyPin(db, user.id, '4321')).toBe(false)
  })

  it('a LEGACY bare-hex hash still verifies — at the cost it was produced with, not the current one', async () => {
    const { scryptSync } = await import('node:crypto')
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Legacy', pin: '1234', role: 'staff' }, testWrite())
    // Overwrite with exactly what pre-T150 code wrote: Node's DEFAULT cost, no
    // parameters recorded. Written directly rather than through the op-log,
    // because this is simulating a row that predates the format.
    const salt = db.prepare('SELECT pin_salt FROM users WHERE id = ?').get(user.id).pin_salt
    const legacy = scryptSync('1234', salt, 64).toString('hex')
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(legacy, user.id)
    expect(verifyPin(db, user.id, '1234')).toBe(true)
    expect(verifyPin(db, user.id, '9999')).toBe(false)
  })

  it('a malformed stored hash is a failed login, never a throw', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Corrupt', pin: '1234', role: 'staff' }, testWrite())
    for (const junk of ['scrypt$N=notanumber,r=8,p=1$abcd', 'scrypt$$', '']) {
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(junk, user.id)
      expect(() => verifyPin(db, user.id, '1234')).not.toThrow()
      expect(verifyPin(db, user.id, '1234')).toBe(false)
    }
  })
})

// The stored hash replicates, so a peer can write it. These are the inputs a
// hostile one would choose.
describe('PIN hash parsing treats the stored value as untrusted input', () => {
  it('refuses an absurd cost parameter instead of trying to allocate it', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Bomb', pin: '1234', role: 'staff' }, testWrite())
    // N=2^30 with the earlier "size maxmem from the stored N" logic asked for
    // hundreds of GB on every login attempt, on every device that replicated it.
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(`scrypt$N=${2 ** 30},r=8,p=1$abcd`, user.id)
    const started = Date.now()
    expect(verifyPin(db, user.id, '1234')).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('refuses degenerate parameters (zero, negative, non-integer) as a failed login', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Degenerate', pin: '1234', role: 'staff' }, testWrite())
    for (const params of ['N=0,r=8,p=1', 'N=-1,r=8,p=1', 'N=16384,r=0,p=1', 'N=16384,r=8,p=0', 'N=1.5,r=8,p=1']) {
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(`scrypt$${params}$abcd`, user.id)
      expect(() => verifyPin(db, user.id, '1234')).not.toThrow()
      expect(verifyPin(db, user.id, '1234')).toBe(false)
    }
  })

  it('a non-hex payload is a failed login, not a length coincidence', async () => {
    const user = await createUser(db, { camp_id: 'camp-1', name: 'NotHex', pin: '1234', role: 'staff' }, testWrite())
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run('scrypt$N=65536,r=8,p=1$zzzz', user.id)
    expect(verifyPin(db, user.id, '1234')).toBe(false)
  })
})

// Discards the cached template. Per-test cleanup would rebuild the chain every time
// and undo the saving, so this runs once, at the end.
afterAll(() => {
  cleanupTemplatedDbs()
})
