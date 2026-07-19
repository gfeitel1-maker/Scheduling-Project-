// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, initSchema, getSchemaVersion, getOrCreateDeviceId } from './localDb.js'

let tmpFile

afterEach(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function freshDb() {
  tmpFile = path.join(os.tmpdir(), `shoresh-test-${Date.now()}-${Math.random()}.sqlite`)
  return openLocalDb(tmpFile)
}

function seedUserAndDevice(db) {
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user1', 'camp1', 'User', 'hash', 'salt', 'staff')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device1', 'Device')
}

describe('Fix 1: nullable author_user_id', () => {
  it('allows inserting an operation with author_user_id = NULL', () => {
    const db = freshDb()
    seedUserAndDevice(db)
    expect(() => {
      db.prepare(
        `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('op1', 'entity', 'e1', 'field', 'val', null, 'device1', new Date().toISOString())
    }).not.toThrow()
    db.close()
  })
})

describe('Fix 2: schema versioning', () => {
  it('getSchemaVersion returns 2 after openLocalDb runs', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(2)
    db.close()
  })

  it('calling initSchema again does not throw and version stays 2', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(2)
    const rows = db.prepare('SELECT * FROM schema_migrations WHERE version = 1').all()
    expect(rows.length).toBe(1)
    const rows2 = db.prepare('SELECT * FROM schema_migrations WHERE version = 2').all()
    expect(rows2.length).toBe(1)
    db.close()
  })
})

describe('Fix 3: persisted device id', () => {
  it('getOrCreateDeviceId returns the same id on two successive calls, only one row', () => {
    const db = freshDb()
    const id1 = getOrCreateDeviceId(db)
    const id2 = getOrCreateDeviceId(db)
    expect(id1).toBe(id2)
    const rows = db.prepare('SELECT * FROM device_identity').all()
    expect(rows.length).toBe(1)
    db.close()
  })
})

describe('Fix 4: seq as real primary key, id unique', () => {
  it('inserting two ops without seq gives sequential increasing values', () => {
    const db = freshDb()
    seedUserAndDevice(db)
    const insert = db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const r1 = insert.run('op-a', 'entity', 'e1', 'field', 'v1', null, 'device1', new Date().toISOString())
    const r2 = insert.run('op-b', 'entity', 'e1', 'field', 'v2', null, 'device1', new Date().toISOString())
    expect(r2.lastInsertRowid).toBeGreaterThan(r1.lastInsertRowid)

    expect(() => {
      insert.run('op-a', 'entity', 'e1', 'field', 'dup', null, 'device1', new Date().toISOString())
    }).toThrow(/UNIQUE/)
    db.close()
  })
})

describe('Fix 5: WAL mode, busy_timeout, safe open', () => {
  it('sets journal_mode to wal and busy_timeout to 5000', () => {
    const db = freshDb()
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    db.close()
  })

  it('throws a clear error when opening a database at an invalid path', () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-baddb-'))
    expect(() => openLocalDb(dirPath)).toThrow(/Failed to open local database at/)
    fs.rmdirSync(dirPath)
  })
})
