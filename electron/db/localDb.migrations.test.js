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
  it('getSchemaVersion reaches at least 2 after openLocalDb runs', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(2)
    db.close()
  })

  it('calling initSchema again does not throw and version 2 stays applied exactly once', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(2)
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

describe('Fix 6: nullable users.camp_id (schema version 4)', () => {
  it('getSchemaVersion returns 4 after openLocalDb runs', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(4)
    db.close()
  })

  it('allows inserting a users row with camp_id = NULL', () => {
    const db = freshDb()
    expect(() => {
      db.prepare(
        'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('u-null', null, '', '', '', 'staff')
    }).not.toThrow()
    db.close()
  })

  it('still rejects a duplicate camp_id+name pair when both are real non-null values', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare(
      'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('u1', 'camp1', 'Dup', 'h', 's', 'staff')
    expect(() => {
      db.prepare(
        'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('u2', 'camp1', 'Dup', 'h', 's', 'staff')
    }).toThrow(/UNIQUE/)
    db.close()
  })
})

describe('THIRD CORRECTION: version-4 migration is transactional', () => {
  it('a fresh install never has a NOT NULL camp_id at any point, and schema version reaches 4', () => {
    const db = freshDb()
    const campIdColumn = db.pragma('table_info(users)').find((col) => col.name === 'camp_id')
    expect(campIdColumn).toBeDefined()
    expect(campIdColumn.notnull).toBe(0)
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(4)
    db.close()
  })

  it('rolls back the whole users_new rebuild if any statement in the sequence fails, leaving the original users table intact', () => {
    const db = freshDb()
    // Force the pre-existing (NOT NULL camp_id) path by rebuilding a legacy users table,
    // then seed a row that will make the migration's rebuild collide (duplicate camp_id+name)
    // once idx_users_camp_name is (re)created, simulating a mid-sequence failure.
    db.exec('DROP TABLE users')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        pin_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
      )
    `)
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u1', 'camp1', 'Dup', 'h', 's', 'staff')
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u2', 'camp1', 'Dup', 'h', 's', 'staff')
    db.prepare('DELETE FROM schema_migrations WHERE version = 4').run()

    let threw = false
    try {
      initSchema(db)
    } catch (err) {
      threw = true
    }
    expect(threw).toBe(true)

    // Whole rebuild rolled back: original (legacy) users table with its rows must still exist.
    const rows = db.prepare('SELECT id FROM users ORDER BY id').all()
    expect(rows.map((r) => r.id)).toEqual(['u1', 'u2'])
    const usersNewExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users_new'")
      .get()
    expect(usersNewExists).toBeUndefined()
    db.close()
  })
})

describe('Task 4: devices.last_synced_at (schema version 5)', () => {
  it('getSchemaVersion returns 6 after openLocalDb runs', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(7)
    db.close()
  })

  it('a fresh install already has last_synced_at via schema.sql, with no ALTER needed', () => {
    const db = freshDb()
    const col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_at')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(7)
    db.close()
  })

  it('an existing pre-migration db (missing last_synced_at) gets the column added via the guarded ALTER', () => {
    const db = freshDb()
    // Simulate a pre-migration db: rebuild devices without last_synced_at, drop the v5+ markers.
    db.exec('DROP TABLE devices')
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_seen_at TEXT
      )
    `)
    db.prepare('DELETE FROM schema_migrations WHERE version >= 5').run()

    let col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_at')
    expect(col).toBeUndefined()

    initSchema(db)

    col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_at')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(7)
    db.close()
  })
})

describe('Task 9 Round 2 Fix 2: login_attempts table (schema version 6)', () => {
  it('creates the login_attempts table on a fresh install', () => {
    const db = freshDb()
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'")
      .get()
    expect(table).toBeDefined()
    expect(getSchemaVersion(db)).toBe(7)
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(7)
    db.close()
  })

  it('adds login_attempts to a pre-migration db missing it', () => {
    const db = freshDb()
    db.exec('DROP TABLE login_attempts')
    // getSchemaVersion is a MAX() over schema_migrations, so simulating "a
    // pre-migration db that never reached version 6" requires clearing every
    // version >= 6 (not just 6 itself) now that version 7 also exists —
    // otherwise the leftover version-7 row alone would make MAX() report 7
    // and the `< 6` guard would never re-trigger.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 6').run()

    let table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'")
      .get()
    expect(table).toBeUndefined()

    initSchema(db)

    table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'")
      .get()
    expect(table).toBeDefined()
    expect(getSchemaVersion(db)).toBe(7)
    db.close()
  })
})

describe('Task 10 round-4 Fix 3: devices.last_synced_seq (schema version 7)', () => {
  it('a fresh install has last_synced_seq on devices, defaulting to NULL (unset)', () => {
    const db = freshDb()
    const col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_seq')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(7)
    db.close()
  })

  it('an existing pre-migration db (missing last_synced_seq) gets the column added via the guarded ALTER', () => {
    const db = freshDb()
    db.exec('ALTER TABLE devices RENAME TO devices_tmp')
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_seen_at TEXT,
        last_synced_at TEXT
      )
    `)
    db.exec('INSERT INTO devices SELECT id, name, last_seen_at, last_synced_at FROM devices_tmp')
    db.exec('DROP TABLE devices_tmp')
    db.prepare('DELETE FROM schema_migrations WHERE version = 7').run()

    let col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_seq')
    expect(col).toBeUndefined()

    initSchema(db)

    col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_seq')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(7)
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
