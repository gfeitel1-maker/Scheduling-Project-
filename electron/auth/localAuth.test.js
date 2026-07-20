// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken, attemptLogin } from './localAuth.js'
import { appendOp } from '../ops/operations.js'

let tmpFile
let db

const DEVICE_ID = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-auth-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-1')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(DEVICE_ID, 'Test Device')
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
    const user = await createUser(db, { camp_id: 'camp-1', name: 'Bob', pin: '5678', role: 'admin' }, testWrite())
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

describe('unique username per camp', () => {
  it('throws a clear error when creating a second user with the same name in the same camp', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '1111', role: 'staff' }, testWrite())
    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'Sam', pin: '2222', role: 'admin' }, testWrite())
    ).rejects.toThrow(/already exists/)
  })

  it('rejects the duplicate BEFORE emitting any ops (clean no-op rejection)', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Sam2', pin: '1111', role: 'staff' }, testWrite())
    const opsBefore = db.prepare('SELECT COUNT(*) as n FROM operations').get().n

    await expect(
      createUser(db, { camp_id: 'camp-1', name: 'Sam2', pin: '2222', role: 'admin' }, testWrite())
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
  it('routes all 5 field writes through the provided write function instead of calling appendOp directly', async () => {
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

    expect(calls).toHaveLength(5)
    expect(calls.every((c) => c.entity === 'users' && c.entity_id === user.id)).toBe(true)
    expect(calls.map((c) => c.field).sort()).toEqual(['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'].sort())
  })

  it('emits exactly 5 operations rows for the new user, one per field, all with parent_op_id null', async () => {
    const user = await createUser(
      db,
      { camp_id: 'camp-1', name: 'Opuser', pin: '1234', role: 'staff' },
      testWrite()
    )

    const ops = db
      .prepare('SELECT field, parent_op_id FROM operations WHERE entity = ? AND entity_id = ?')
      .all('users', user.id)

    expect(ops).toHaveLength(5)
    expect(ops.map((op) => op.field).sort()).toEqual(
      ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'].sort()
    )
    expect(ops.every((op) => op.parent_op_id === null)).toBe(true)
  })

  it('produces a queryable users row via projection with the correct name and role', async () => {
    const user = await createUser(
      db,
      { camp_id: 'camp-1', name: 'Opuser2', pin: '1234', role: 'admin' },
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

describe('issueSessionToken / verifySessionToken', () => {
  it('round-trips userId/deviceId through a signed token using the camp signing_secret', () => {
    const token = issueSessionToken(db, 'user-1', 'device-1')
    const payload = verifySessionToken(db, token)
    expect(payload).toEqual({ userId: 'user-1', deviceId: 'device-1' })
  })

  it('rejects a token issued against a DIFFERENT camp/db signing_secret', () => {
    const otherFile = path.join(os.tmpdir(), `shoresh-localauth-othercamp-${Date.now()}-${Math.random()}.sqlite`)
    const otherDb = openLocalDb(otherFile)
    otherDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-other', 'Other Camp')
    otherDb.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-other')

    const tokenFromOtherCamp = issueSessionToken(otherDb, 'user-1', 'device-1')
    expect(verifySessionToken(db, tokenFromOtherCamp)).toBeNull()

    otherDb.close()
    fs.unlinkSync(otherFile)
  })

  it('rejects a tampered token', () => {
    const token = issueSessionToken(db, 'user-1', 'device-1')
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A')
    expect(() => verifySessionToken(db, tampered)).not.toThrow()
    expect(verifySessionToken(db, tampered)).toBeNull()
  })

  it('rejects tokens with a mutated payload across many random tamper attempts', () => {
    for (let i = 0; i < 20; i++) {
      const token = issueSessionToken(db, `user-${i}`, `device-${i}`)
      const chars = token.split('')
      const idx = Math.floor(Math.random() * chars.length)
      chars[idx] = chars[idx] === 'x' ? 'y' : 'x'
      const tampered = chars.join('')
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

    for (let i = 0; i < 5; i++) {
      expect(attemptLogin(db, { name: 'Yara', pin: 'wrong', deviceId: 'device-1' })).toBeNull()
    }
    const result = attemptLogin(db, { name: 'Yara', pin: '5555', deviceId: 'device-1' })
    expect(result).toEqual({ locked: true, retryAfterMs: expect.any(Number) })
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('issues a token bound to the deviceId passed in, not any other device', async () => {
    await createUser(db, { camp_id: 'camp-1', name: 'Zane', pin: '9999', role: 'admin' }, testWrite())

    const result = attemptLogin(db, { name: 'Zane', pin: '9999', deviceId: 'remote-device-42' })
    const verified = verifySessionToken(db, result.token)
    expect(verified.deviceId).toBe('remote-device-42')
  })
})
