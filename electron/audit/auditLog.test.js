// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { recordAuditEvent, listAuditEvents } from './auditLog.js'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
let tmpFile
let db

beforeEach(() => {
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('recordAuditEvent', () => {
  it('inserts a row with expected fields', () => {
    recordAuditEvent(db, {
      actorUserId: 'user-1',
      deviceId: 'device-1',
      action: 'users.create',
      targetType: 'users',
      targetId: 'user-2',
      outcome: 'allow',
    })

    const rows = db.prepare('SELECT * FROM audit_events').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      camp_id: 'camp-1',
      actor_user_id: 'user-1',
      device_id: 'device-1',
      action: 'users.create',
      target_type: 'users',
      target_id: 'user-2',
      outcome: 'allow',
      reason: null,
    })
    expect(typeof rows[0].occurred_at).toBe('string')
  })

  it('derives camp_id when not passed', () => {
    recordAuditEvent(db, { action: 'auth.login', outcome: 'allow' })
    const row = db.prepare('SELECT camp_id FROM audit_events').get()
    expect(row.camp_id).toBe('camp-1')
  })

  it('scrubs secret keys from metadata before storing', () => {
    recordAuditEvent(db, {
      action: 'auth.login',
      outcome: 'deny',
      reason: 'invalid_pin',
      metadata: { pin: '1234', pin_hash: 'abc', name: 'Alice' },
    })

    const row = db.prepare('SELECT metadata FROM audit_events').get()
    const parsed = JSON.parse(row.metadata)
    expect(parsed).not.toHaveProperty('pin')
    expect(parsed).not.toHaveProperty('pin_hash')
    expect(parsed).toEqual({ name: 'Alice' })
  })

  it('scrubs secret keys nested inside metadata, not just top-level', () => {
    recordAuditEvent(db, {
      action: 'auth.login',
      outcome: 'deny',
      reason: 'invalid_pin',
      metadata: { context: { pin: '1234', name: 'Alice' }, attempts: [{ token: 'abc', ok: false }] },
    })

    const row = db.prepare('SELECT metadata FROM audit_events').get()
    const parsed = JSON.parse(row.metadata)
    expect(parsed.context).not.toHaveProperty('pin')
    expect(parsed.context).toEqual({ name: 'Alice' })
    expect(parsed.attempts[0]).not.toHaveProperty('token')
    expect(parsed.attempts[0]).toEqual({ ok: false })
  })

  it('discards non-plain-object metadata (array, Date, etc.) rather than treating it as a key/value bag', () => {
    recordAuditEvent(db, {
      action: 'auth.login',
      outcome: 'deny',
      metadata: ['secret-token-value'],
    })
    const arrayRow = db.prepare('SELECT metadata FROM audit_events').get()
    expect(arrayRow.metadata).toBeNull()

    recordAuditEvent(db, {
      action: 'auth.login',
      outcome: 'deny',
      metadata: new Date('2020-01-01'),
    })
    const dateRow = db.prepare('SELECT metadata FROM audit_events ORDER BY id DESC LIMIT 1').get()
    expect(dateRow.metadata).toBeNull()
  })

  it('stores null metadata when none is provided', () => {
    recordAuditEvent(db, { action: 'auth.login', outcome: 'allow' })
    const row = db.prepare('SELECT metadata FROM audit_events').get()
    expect(row.metadata).toBeNull()
  })

  it('does not throw when given a broken/closed db', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.close()

    expect(() =>
      recordAuditEvent(db, { action: 'users.create', outcome: 'allow' })
    ).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('listAuditEvents', () => {
  beforeEach(() => {
    recordAuditEvent(db, { actorUserId: 'user-1', action: 'users.create', outcome: 'allow' })
    recordAuditEvent(db, { actorUserId: 'user-1', action: 'auth.login', outcome: 'deny', reason: 'invalid_pin' })
    recordAuditEvent(db, { actorUserId: 'user-2', action: 'auth.login', outcome: 'allow' })
  })

  it('filters by actorUserId', () => {
    const rows = listAuditEvents(db, { actorUserId: 'user-1' })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.actor_user_id === 'user-1')).toBe(true)
  })

  it('filters by action', () => {
    const rows = listAuditEvents(db, { action: 'auth.login' })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.action === 'auth.login')).toBe(true)
  })

  it('filters by outcome', () => {
    const rows = listAuditEvents(db, { outcome: 'deny' })
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('invalid_pin')
  })

  it('combines multiple filters', () => {
    const rows = listAuditEvents(db, { actorUserId: 'user-1', action: 'auth.login', outcome: 'deny' })
    expect(rows).toHaveLength(1)
  })

  it('respects limit', () => {
    const rows = listAuditEvents(db, { limit: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('auth.login')
    expect(rows[0].actor_user_id).toBe('user-2')
  })
})
