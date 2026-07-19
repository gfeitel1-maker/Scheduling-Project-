// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS, applyProjection } from './projections.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-projections-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('PROJECTIONS registry', () => {
  it('registers users with a fields allowlist and ensureExists', () => {
    expect(PROJECTIONS.users.table).toBe('users')
    expect(PROJECTIONS.users.key).toBe('id')
    expect(PROJECTIONS.users.fields).toEqual(['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'])
    expect(typeof PROJECTIONS.users.ensureExists).toBe('function')
  })
})

describe('applyProjection', () => {
  it('updates the real row for a registered entity', () => {
    applyProjection(db, { entity: 'users', entity_id: 'user-1', field: 'name', value: 'Bob' })
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Bob')
  })

  it('is a no-op for an unregistered entity', () => {
    expect(() =>
      applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: 'x' })
    ).not.toThrow()
  })

  it('creates a new row (via ensureExists) when the target row does not exist, and sets the field', () => {
    expect(() =>
      applyProjection(db, { entity: 'users', entity_id: 'brand-new-user', field: 'name', value: 'Nobody' })
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('brand-new-user')
    expect(row).toBeTruthy()
    expect(row.name).toBe('Nobody')
    expect(row.role).toBe('staff')
  })

  it('does not throw and does not modify the table when the field is not in the allowlist', () => {
    expect(() =>
      applyProjection(db, { entity: 'users', entity_id: 'user-1', field: 'not_a_real_field', value: 'x' })
    ).not.toThrow()
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alice')
  })

  it('rejects a malicious field string without executing it against the users table', () => {
    expect(() =>
      applyProjection(db, {
        entity: 'users',
        entity_id: 'user-1',
        field: "role = 'admin' -- ",
        value: 'x',
      })
    ).not.toThrow()
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get('user-1')
    expect(row.role).toBe('staff')
  })

  it('ensureExists does not touch the camps table (no sentinel camp row)', () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    applyProjection(db, { entity: 'users', entity_id: 'brand-new-user-2', field: 'name', value: 'X' })
    const after = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    expect(after).toBe(before)
    const row = db.prepare('SELECT camp_id FROM users WHERE id = ?').get('brand-new-user-2')
    expect(row.camp_id).toBe(null)
  })

  it('creates placeholder rows for two different new users without either being swallowed by INSERT OR IGNORE', () => {
    applyProjection(db, { entity: 'users', entity_id: 'new-user-a', field: 'name', value: 'A' })
    applyProjection(db, { entity: 'users', entity_id: 'new-user-b', field: 'name', value: 'B' })
    const rowA = db.prepare('SELECT * FROM users WHERE id = ?').get('new-user-a')
    const rowB = db.prepare('SELECT * FROM users WHERE id = ?').get('new-user-b')
    expect(rowA).toBeTruthy()
    expect(rowB).toBeTruthy()
    expect(rowA.camp_id).toBe(null)
    expect(rowB.camp_id).toBe(null)
  })

  it('leaves main.js-style camp lookups unaffected by placeholder user creation', () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    applyProjection(db, { entity: 'users', entity_id: 'brand-new-user-3', field: 'name', value: 'Y' })
    const after = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    expect(after).toBe(before)
    const firstCamp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    expect(firstCamp).toEqual({ id: 'camp-1' })
  })
})
