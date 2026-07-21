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
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })

  it('a fresh install already has last_synced_at via schema.sql, with no ALTER needed', () => {
    const db = freshDb()
    const col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_at')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(10)
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
    expect(getSchemaVersion(db)).toBe(10)
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
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(10)
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
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })
})

describe('Task 10 round-4 Fix 3: devices.last_synced_seq (schema version 7)', () => {
  it('a fresh install has last_synced_seq on devices, defaulting to NULL (unset)', () => {
    const db = freshDb()
    const col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_seq')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(10)
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
    db.prepare('DELETE FROM schema_migrations WHERE version >= 7').run()

    let col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_seq')
    expect(col).toBeUndefined()

    initSchema(db)

    col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_seq')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })
})

describe('Task 10 round-5 Fix 1/3: pending_writes table + operations.client_write_id (schema version 8)', () => {
  it('a fresh install has both the pending_writes table and operations.client_write_id, at version 8', () => {
    const db = freshDb()
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_writes'")
      .get()
    expect(table).toBeDefined()
    const col = db.pragma('table_info(operations)').find((c) => c.name === 'client_write_id')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })

  it('adds both to a pre-migration db missing them, via the guarded ALTER', () => {
    const db = freshDb()
    db.exec('DROP TABLE pending_writes')
    db.exec('ALTER TABLE operations RENAME TO operations_tmp')
    db.exec(`
      CREATE TABLE operations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT,
        author_user_id TEXT,
        device_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        parent_op_id TEXT
      )
    `)
    db.exec(`
      INSERT INTO operations (seq, id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
      SELECT seq, id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id FROM operations_tmp
    `)
    db.exec('DROP TABLE operations_tmp')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 8').run()

    let col = db.pragma('table_info(operations)').find((c) => c.name === 'client_write_id')
    expect(col).toBeUndefined()
    let table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_writes'")
      .get()
    expect(table).toBeUndefined()

    initSchema(db)

    col = db.pragma('table_info(operations)').find((c) => c.name === 'client_write_id')
    expect(col).toBeDefined()
    table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_writes'")
      .get()
    expect(table).toBeDefined()
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })
})

describe('schema v9: camps.signing_secret', () => {
  it('a fresh install has a nullable signing_secret column on camps, at version 9', () => {
    const db = freshDb()
    const col = db.pragma('table_info(camps)').find((c) => c.name === 'signing_secret')
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0)
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })

  it('backfills a freshly-generated secret for a camp row with a NULL signing_secret', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, NULL)').run('camp2', 'Camp Two')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 9').run()

    initSchema(db)

    const rows = db.prepare('SELECT id, signing_secret FROM camps').all()
    for (const row of rows) {
      expect(row.signing_secret).toEqual(expect.any(String))
      expect(row.signing_secret.length).toBeGreaterThan(0)
    }
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

describe('schema v10: renderer Supabase migration Sub-plan A schema', () => {
  const NEW_TABLES = [
    'cohorts',
    'days_of_operation',
    'time_blocks',
    'anchor_activities',
    'schedule_templates',
    'template_overlays',
    'schedule_snapshots',
    'day_override_templates',
    'day_override_template_slots',
  ]

  it('creates all 9 new tables on a fresh install, at version 10', () => {
    const db = freshDb()
    for (const t of NEW_TABLES) {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t)
      expect(table, `expected table ${t} to exist`).toBeDefined()
    }
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })

  it('adds sort_order/cohort_id to tiers, priority/is_locked/span_blocks to activities, flags/is_released/is_span_head to template_slots', () => {
    const db = freshDb()
    const tierCols = db.pragma('table_info(tiers)').map((c) => c.name)
    expect(tierCols).toEqual(expect.arrayContaining(['sort_order', 'cohort_id']))

    const activityCols = db.pragma('table_info(activities)').map((c) => c.name)
    expect(activityCols).toEqual(expect.arrayContaining(['priority', 'is_locked', 'span_blocks']))

    const slotCols = db.pragma('table_info(template_slots)').map((c) => c.name)
    expect(slotCols).toEqual(expect.arrayContaining(['flags', 'is_released', 'is_span_head']))
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })

  it('adds everything to a pre-migration db missing it all, via the guarded ALTER/CREATE path', () => {
    const db = freshDb()
    for (const t of NEW_TABLES) {
      db.exec(`DROP TABLE ${t}`)
    }
    db.exec('ALTER TABLE tiers RENAME TO tiers_tmp')
    db.exec('CREATE TABLE tiers (id TEXT PRIMARY KEY, camp_id TEXT NOT NULL REFERENCES camps(id), name TEXT NOT NULL)')
    db.exec('INSERT INTO tiers (id, camp_id, name) SELECT id, camp_id, name FROM tiers_tmp')
    db.exec('DROP TABLE tiers_tmp')

    db.exec('ALTER TABLE activities RENAME TO activities_tmp')
    db.exec('CREATE TABLE activities (id TEXT PRIMARY KEY, camp_id TEXT NOT NULL REFERENCES camps(id), name TEXT NOT NULL)')
    db.exec('INSERT INTO activities (id, camp_id, name) SELECT id, camp_id, name FROM activities_tmp')
    db.exec('DROP TABLE activities_tmp')

    db.exec('ALTER TABLE template_slots RENAME TO template_slots_tmp')
    db.exec(`
      CREATE TABLE template_slots (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        group_id TEXT REFERENCES groups(id),
        activity_id TEXT REFERENCES activities(id),
        day_id TEXT,
        time_block_id TEXT
      )
    `)
    db.exec('INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) SELECT id, template_id, group_id, activity_id, day_id, time_block_id FROM template_slots_tmp')
    db.exec('DROP TABLE template_slots_tmp')

    db.prepare('DELETE FROM schema_migrations WHERE version >= 10').run()

    for (const t of NEW_TABLES) {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t)
      expect(table).toBeUndefined()
    }
    let tierCols = db.pragma('table_info(tiers)').map((c) => c.name)
    expect(tierCols).not.toEqual(expect.arrayContaining(['sort_order']))

    initSchema(db)

    for (const t of NEW_TABLES) {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t)
      expect(table, `expected table ${t} to exist after migration`).toBeDefined()
    }
    tierCols = db.pragma('table_info(tiers)').map((c) => c.name)
    expect(tierCols).toEqual(expect.arrayContaining(['sort_order', 'cohort_id']))
    const activityCols = db.pragma('table_info(activities)').map((c) => c.name)
    expect(activityCols).toEqual(expect.arrayContaining(['priority', 'is_locked', 'span_blocks']))
    const slotCols = db.pragma('table_info(template_slots)').map((c) => c.name)
    expect(slotCols).toEqual(expect.arrayContaining(['flags', 'is_released', 'is_span_head']))
    expect(getSchemaVersion(db)).toBe(10)
    db.close()
  })

  it('fresh db (schema.sql) and a pre-v10 db upgraded via the migration block end up with IDENTICAL schema', () => {
    // Fresh db: gets everything via schema.sql's unconditional CREATE TABLE IF NOT EXISTS.
    const freshDatabase = freshDb()

    // Simulated pre-v10 db: same freshDb (also created via schema.sql, since that's
    // unconditional), but strip the v10 additions back out and reset the version
    // marker, then let initSchema's version-10 block rebuild them from scratch.
    const migratedDatabase = freshDb()
    for (const t of NEW_TABLES) {
      migratedDatabase.exec(`DROP TABLE ${t}`)
    }
    migratedDatabase.exec('ALTER TABLE tiers RENAME TO tiers_tmp')
    migratedDatabase.exec('CREATE TABLE tiers (id TEXT PRIMARY KEY, camp_id TEXT NOT NULL REFERENCES camps(id), name TEXT NOT NULL)')
    migratedDatabase.exec('INSERT INTO tiers (id, camp_id, name) SELECT id, camp_id, name FROM tiers_tmp')
    migratedDatabase.exec('DROP TABLE tiers_tmp')

    migratedDatabase.exec('ALTER TABLE activities RENAME TO activities_tmp')
    migratedDatabase.exec('CREATE TABLE activities (id TEXT PRIMARY KEY, camp_id TEXT NOT NULL REFERENCES camps(id), name TEXT NOT NULL)')
    migratedDatabase.exec('INSERT INTO activities (id, camp_id, name) SELECT id, camp_id, name FROM activities_tmp')
    migratedDatabase.exec('DROP TABLE activities_tmp')

    migratedDatabase.exec('ALTER TABLE template_slots RENAME TO template_slots_tmp')
    migratedDatabase.exec(`
      CREATE TABLE template_slots (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        group_id TEXT REFERENCES groups(id),
        activity_id TEXT REFERENCES activities(id),
        day_id TEXT,
        time_block_id TEXT
      )
    `)
    migratedDatabase.exec('INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) SELECT id, template_id, group_id, activity_id, day_id, time_block_id FROM template_slots_tmp')
    migratedDatabase.exec('DROP TABLE template_slots_tmp')

    migratedDatabase.prepare('DELETE FROM schema_migrations WHERE version >= 10').run()
    initSchema(migratedDatabase)

    const allAffectedTables = [...NEW_TABLES, 'tiers', 'activities', 'template_slots']
    for (const t of allAffectedTables) {
      const freshCols = freshDatabase.pragma(`table_info(${t})`)
      const migratedCols = migratedDatabase.pragma(`table_info(${t})`)
      const normalize = (cols) =>
        cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
      expect(normalize(migratedCols), `schema mismatch for table ${t}`).toEqual(normalize(freshCols))
    }

    for (const t of NEW_TABLES) {
      const table = migratedDatabase
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t)
      expect(table, `expected table ${t} to exist in migrated db`).toBeDefined()
    }

    expect(getSchemaVersion(migratedDatabase)).toBe(10)

    freshDatabase.close()
    migratedDatabase.close()
  })
})
