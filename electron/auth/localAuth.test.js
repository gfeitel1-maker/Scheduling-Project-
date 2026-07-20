// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken } from './localAuth.js'
import { appendOp } from '../ops/operations.js'

let tmpFile
let db

const DEVICE_ID = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-auth-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
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

describe('issueSessionToken / verifySessionToken', () => {
  it('round-trips userId and deviceId correctly', () => {
    const token = issueSessionToken('user-1', 'device-1')
    const payload = verifySessionToken(token)
    expect(payload).toEqual({ userId: 'user-1', deviceId: 'device-1' })
  })

  // Flips the FIRST character of the signature segment (never the last character
  // of the whole token). The signature is a base64url encoding of a 32-byte HMAC
  // digest: 256 bits / 6 bits-per-char = 42.67, so the encoding needs 43 characters
  // and the LAST character only carries 4 significant bits — its bottom 2 bits are
  // always zero padding that base64url decoding drops. That means toggling the
  // trailing character between two values sharing the same top 4 bits (any of
  // A/B/C/D, which together cover ~6.25% of possible trailing characters) silently
  // decodes to IDENTICAL signature bytes, so "tampering" the token that way is a
  // no-op roughly 1 in 16 runs — which is exactly the observed ~3-10/30 flakiness.
  // The first character of the signature has no such truncation (it isn't the
  // group boundary), so toggling it between two distinct values always changes the
  // decoded bytes deterministically. Verified via 5000 simulated tokens: 0/5000
  // collisions when flipping the first signature character, vs ~5-6% collisions
  // when flipping the last token character.
  it('returns null for a tampered token instead of throwing', () => {
    const token = issueSessionToken('user-1', 'device-1')
    const dotIndex = token.indexOf('.')
    const sigStart = dotIndex + 1
    const firstSigChar = token[sigStart]
    const replacement = firstSigChar === 'A' ? 'B' : 'A'
    const tampered = token.slice(0, sigStart) + replacement + token.slice(sigStart + 1)

    expect(() => verifySessionToken(tampered)).not.toThrow()
    expect(verifySessionToken(tampered)).toBeNull()
  })

  it('reliably rejects a tampered token across many independently-issued tokens (stress test for the Fix 3 regression)', () => {
    for (let i = 0; i < 200; i++) {
      const token = issueSessionToken(`user-${i}`, `device-${i}`)
      const dotIndex = token.indexOf('.')
      const sigStart = dotIndex + 1
      const firstSigChar = token[sigStart]
      const replacement = firstSigChar === 'A' ? 'B' : 'A'
      const tampered = token.slice(0, sigStart) + replacement + token.slice(sigStart + 1)

      expect(verifySessionToken(tampered)).toBeNull()
    }
  })

  it('returns null for malformed input instead of throwing', () => {
    expect(verifySessionToken('garbage-no-separator')).toBeNull()
    expect(verifySessionToken('')).toBeNull()
    expect(verifySessionToken(null)).toBeNull()
    expect(verifySessionToken('a.b.c')).toBeNull()
  })
})
