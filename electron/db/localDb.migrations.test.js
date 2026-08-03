// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, initSchema, getSchemaVersion, getOrCreateDeviceId, CURRENT_SCHEMA_VERSION } from './localDb.js'

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
    } catch {
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('a fresh install already has last_synced_at via schema.sql, with no ALTER needed', () => {
    const db = freshDb()
    const col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_at')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})

describe('Task 10 round-4 Fix 3: devices.last_synced_seq (schema version 7)', () => {
  it('a fresh install has last_synced_seq on devices, defaulting to NULL (unset)', () => {
    const db = freshDb()
    const col = db.pragma('table_info(devices)').find((c) => c.name === 'last_synced_seq')
    expect(col).toBeDefined()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})

describe('schema v9: camps.signing_secret', () => {
  it('a fresh install has a nullable signing_secret column on camps, at version 9', () => {
    const db = freshDb()
    const col = db.pragma('table_info(camps)').find((c) => c.name === 'signing_secret')
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
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

    expect(getSchemaVersion(migratedDatabase)).toBe(CURRENT_SCHEMA_VERSION)

    freshDatabase.close()
    migratedDatabase.close()
  })
})

describe('Round 2 Red Hat fix, HIGH finding 1: UNIQUE(camp_id, name) on cohorts (schema version 11)', () => {
  it('a fresh install rejects a second cohort with the same camp_id + name', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('c1', 'camp1', 'Main')
    expect(() => {
      db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('c2', 'camp1', 'Main')
    }).toThrow(/UNIQUE/)
    db.close()
  })

  it('adds idx_cohorts_camp_name to a pre-migration db missing it, dedeuping any pre-existing violators first', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    // Simulate a genuine pre-fix db: its cohorts table predates the inline
    // UNIQUE(camp_id, name) in schema.sql, so rebuild it without that
    // constraint (a fresh test db, unlike a real pre-fix db, always gets
    // the constraint from schema.sql directly) before seeding a
    // race-created duplicate pair.
    db.exec('DROP TABLE cohorts')
    db.exec(`
      CREATE TABLE cohorts (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        session_week_start TEXT,
        session_week_end TEXT,
        capacity_source TEXT,
        anchor_model TEXT,
        sort_order INTEGER
      )
    `)
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('c1', 'camp1', 'Main')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('c2', 'camp1', 'Main')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 11').run()

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM cohorts WHERE camp_id = ? AND name = ?').all('camp1', 'Main')
    expect(rows.length).toBe(1)
    expect(() => {
      db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('c3', 'camp1', 'Main')
    }).toThrow(/UNIQUE/)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('GOVERNOR fix (round 2 escalation): repoints time_blocks/anchor_activities FKs off a duplicate cohort before deleting it, instead of crashing on FOREIGN KEY constraint failed', () => {
    const db = freshDb()
    db.pragma('foreign_keys = ON')
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.exec('DROP TABLE cohorts')
    db.exec(`
      CREATE TABLE cohorts (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        session_week_start TEXT,
        session_week_end TEXT,
        capacity_source TEXT,
        anchor_model TEXT,
        sort_order INTEGER
      )
    `)
    // Reproduce Red Hat's exact repro: a real-world db that already hit the
    // round-1 race (two "Main" cohorts) and has since been used normally —
    // a time_block and an anchor_activity both point at the NON-min-rowid
    // duplicate, which is exactly the row the old dedupe would delete.
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('c1', 'camp1', 'Main')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('c2', 'camp1', 'Main')
    db.prepare(
      "INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES ('tb1', 'camp1', 'c2', 'Morning')"
    ).run()
    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, cohort_id) VALUES ('aa1', 'camp1', 'c2')"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 11').run()

    // Before the fix, this threw `SqliteError: FOREIGN KEY constraint
    // failed` and bricked openLocalDb for any such device.
    expect(() => initSchema(db)).not.toThrow()

    const survivor = db.prepare('SELECT id FROM cohorts WHERE camp_id = ? AND name = ?').get('camp1', 'Main')
    expect(db.prepare('SELECT cohort_id FROM time_blocks WHERE id = ?').get('tb1').cohort_id).toBe(survivor.id)
    expect(db.prepare('SELECT cohort_id FROM anchor_activities WHERE id = ?').get('aa1').cohort_id).toBe(
      survivor.id
    )
    db.close()
  })
})

describe('Round 2 Red Hat fix, HIGH finding 3: UNIQUE(camp_id, name) on groups (schema version 12)', () => {
  it('a fresh install rejects a second group with the same camp_id + name', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', 'camp1', 'Yeladim 1')
    expect(() => {
      db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g2', 'camp1', 'Yeladim 1')
    }).toThrow(/UNIQUE/)
    db.close()
  })

  it('adds idx_groups_camp_name to a pre-migration db missing it, deduping any pre-existing violators first', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    // Simulate a genuine pre-fix db: its groups table predates the inline
    // UNIQUE(camp_id, name) in schema.sql, so rebuild it without that
    // constraint before seeding a race-created duplicate pair.
    db.exec('DROP TABLE groups')
    db.exec(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        tier_id TEXT,
        availability TEXT
      )
    `)
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', 'camp1', 'Yeladim 1')
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g2', 'camp1', 'Yeladim 1')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 12').run()

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM groups WHERE camp_id = ? AND name = ?').all('camp1', 'Yeladim 1')
    expect(rows.length).toBe(1)
    expect(() => {
      db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g3', 'camp1', 'Yeladim 1')
    }).toThrow(/UNIQUE/)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('GOVERNOR fix precedent applied to groups: repoints template_slots.group_id off a duplicate group before deleting it, instead of crashing on FOREIGN KEY constraint failed', () => {
    const db = freshDb()
    db.pragma('foreign_keys = ON')
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.exec('DROP TABLE groups')
    db.exec(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        tier_id TEXT,
        availability TEXT
      )
    `)
    // Reproduce Red Hat's exact repro pattern from the cohorts fix: a
    // real-world db that already hit the round-1 race (two "Yeladim 1"
    // groups) and has since been used normally — a template_slot points at
    // the NON-min-rowid duplicate, which is exactly the row the naive
    // dedupe would delete.
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', 'camp1', 'Yeladim 1')
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g2', 'camp1', 'Yeladim 1')
    db.prepare(
      "INSERT INTO template_slots (id, template_id, group_id) VALUES ('ts1', 'tmpl1', 'g2')"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 12').run()

    // Before this fix's FK-repointing step, this would throw
    // `SqliteError: FOREIGN KEY constraint failed` and brick openLocalDb
    // for any such device.
    expect(() => initSchema(db)).not.toThrow()

    const survivor = db.prepare('SELECT id FROM groups WHERE camp_id = ? AND name = ?').get('camp1', 'Yeladim 1')
    expect(db.prepare('SELECT group_id FROM template_slots WHERE id = ?').get('ts1').group_id).toBe(
      survivor.id
    )
    db.close()
  })
})

describe('Round 2 Red Hat fix, HIGH finding 1: UNIQUE(camp_id, cohort_id, name) on time_blocks (schema version 13)', () => {
  it('a fresh install rejects a second time block with the same camp_id + cohort_id + name', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co1', 'camp1', 'Session 1')
    db.prepare('INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('tb1', 'camp1', 'co1', 'Block 1')
    expect(() => {
      db.prepare('INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('tb2', 'camp1', 'co1', 'Block 1')
    }).toThrow(/UNIQUE/)
    db.close()
  })

  it('allows the same name in two different cohorts (scoped by cohort, not camp-global)', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co1', 'camp1', 'Session 1')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co2', 'camp1', 'Session 2')
    db.prepare('INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('tb1', 'camp1', 'co1', 'Block 1')
    expect(() => {
      db.prepare('INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('tb2', 'camp1', 'co2', 'Block 1')
    }).not.toThrow()
    db.close()
  })

  it('adds idx_time_blocks_camp_cohort_name to a pre-migration db missing it, deduping any pre-existing violators first', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co1', 'camp1', 'Session 1')
    // Simulate a genuine pre-fix db: its time_blocks table predates the
    // inline UNIQUE(camp_id, cohort_id, name) in schema.sql, so rebuild it
    // without that constraint before seeding a race-created duplicate pair.
    db.exec('DROP TABLE time_blocks')
    db.exec(`
      CREATE TABLE time_blocks (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        cohort_id TEXT REFERENCES cohorts(id),
        name TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        part_of_day TEXT,
        sort_order INTEGER
      )
    `)
    db.prepare('INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('tb1', 'camp1', 'co1', 'Block 1')
    db.prepare('INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('tb2', 'camp1', 'co1', 'Block 1')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 13').run()

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM time_blocks WHERE camp_id = ? AND cohort_id = ? AND name = ?').all('camp1', 'co1', 'Block 1')
    expect(rows.length).toBe(1)
    expect(() => {
      db.prepare('INSERT INTO time_blocks (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('tb3', 'camp1', 'co1', 'Block 1')
    }).toThrow(/UNIQUE/)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

})

describe('Round 2 Red Hat fix, mirrors time_blocks HIGH finding 1: UNIQUE(camp_id, cohort_id, name) on tiers (schema version 14)', () => {
  it('a fresh install rejects a second tier with the same camp_id + cohort_id + name', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co1', 'camp1', 'Session 1')
    db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t1', 'camp1', 'co1', 'Yeladim')
    expect(() => {
      db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t2', 'camp1', 'co1', 'Yeladim')
    }).toThrow(/UNIQUE/)
    db.close()
  })

  it('allows the same name in two different cohorts (scoped by cohort, not camp-global)', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co1', 'camp1', 'Session 1')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co2', 'camp1', 'Session 2')
    db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t1', 'camp1', 'co1', 'Yeladim')
    expect(() => {
      db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t2', 'camp1', 'co2', 'Yeladim')
    }).not.toThrow()
    db.close()
  })

  it('adds idx_tiers_camp_cohort_name to a pre-migration db missing it, deduping any pre-existing violators first', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co1', 'camp1', 'Session 1')
    // Simulate a genuine pre-fix db: its tiers table predates the inline
    // UNIQUE(camp_id, cohort_id, name) in schema.sql, so rebuild it without
    // that constraint (matching a db that only ever ran the version-10
    // ALTER TABLE additions) before seeding a race-created duplicate pair.
    db.exec('DROP TABLE tiers')
    db.exec(`
      CREATE TABLE tiers (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        sort_order INTEGER,
        cohort_id TEXT REFERENCES cohorts(id)
      )
    `)
    db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t1', 'camp1', 'co1', 'Yeladim')
    db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t2', 'camp1', 'co1', 'Yeladim')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 14').run()

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND cohort_id = ? AND name = ?').all('camp1', 'co1', 'Yeladim')
    expect(rows.length).toBe(1)
    expect(() => {
      db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t3', 'camp1', 'co1', 'Yeladim')
    }).toThrow(/UNIQUE/)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('GOVERNOR fix (Sub-plan C Task 4 round-1 Security finding): repoints groups.tier_id off a duplicate tier before deleting it, instead of silently orphaning the group', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('co1', 'camp1', 'Session 1')
    db.exec('DROP TABLE tiers')
    db.exec(`
      CREATE TABLE tiers (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        sort_order INTEGER,
        cohort_id TEXT REFERENCES cohorts(id)
      )
    `)
    // Reproduce the exact scenario Security flagged: two devices race-create
    // the same-named tier before this fix existed; a group's tier_id points
    // at the NON-min-rowid duplicate — the row the naive dedupe would
    // delete. groups.tier_id has no DB-level FK, so unlike the analogous
    // groups.id fix (version 12) this would never throw — it would just
    // silently detach the group from its unit with zero signal.
    db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t1', 'camp1', 'co1', 'Yeladim')
    db.prepare('INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)').run('t2', 'camp1', 'co1', 'Yeladim')
    db.prepare("INSERT INTO groups (id, camp_id, name, tier_id) VALUES ('g1', 'camp1', 'Bunk A', 't2')").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 14').run()

    expect(() => initSchema(db)).not.toThrow()

    const survivor = db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND cohort_id = ? AND name = ?').get('camp1', 'co1', 'Yeladim')
    expect(db.prepare('SELECT tier_id FROM groups WHERE id = ?').get('g1').tier_id).toBe(survivor.id)
    db.close()
  })
})

describe('ActivitiesScreen migration: UNIQUE(camp_id, name) + new columns on activities (schema version 15)', () => {
  it('a fresh install rejects a second activity with the same camp_id + name', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a1', 'camp1', 'Water Play')
    expect(() => {
      db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a2', 'camp1', 'Water Play')
    }).toThrow(/UNIQUE/)
    db.close()
  })

  it('adds every new column to a pre-migration db missing them', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    // Simulate a genuine pre-fix db: its activities table only has the
    // version-10 columns (priority/is_locked/span_blocks), predating this
    // migration's ALTER TABLE additions.
    db.exec('DROP TABLE activities')
    db.exec(`
      CREATE TABLE activities (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        priority INTEGER,
        is_locked INTEGER,
        span_blocks INTEGER
      )
    `)
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a1', 'camp1', 'Water Play')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 15').run()

    expect(() => initSchema(db)).not.toThrow()

    const cols = db.pragma('table_info(activities)').map((c) => c.name)
    for (const col of [
      'location', 'is_outdoor', 'max_groups_per_slot', 'min_per_week', 'max_per_week',
      'same_tier_only', 'eligible_tier_ids', 'eligible_group_ids', 'prefer_before_day',
      'prefer_before_day_min', 'weather_alternative_id', 'notes',
    ]) {
      expect(cols).toContain(col)
    }
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('adds idx_activities_camp_name to a pre-migration db missing it, deduping any pre-existing violators first', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    // Simulate a genuine pre-fix db: its activities table predates the
    // inline UNIQUE(camp_id, name) in schema.sql, so rebuild it without that
    // constraint before seeding a race-created duplicate pair.
    db.exec('DROP TABLE activities')
    db.exec(`
      CREATE TABLE activities (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        priority INTEGER,
        is_locked INTEGER,
        span_blocks INTEGER
      )
    `)
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a1', 'camp1', 'Water Play')
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a2', 'camp1', 'Water Play')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 15').run()

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').all('camp1', 'Water Play')
    expect(rows.length).toBe(1)
    expect(() => {
      db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a3', 'camp1', 'Water Play')
    }).toThrow(/UNIQUE/)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('repoints template_slots.activity_id off a duplicate activity before deleting it, instead of crashing on FOREIGN KEY constraint failed', () => {
    const db = freshDb()
    db.pragma('foreign_keys = ON')
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.exec('DROP TABLE activities')
    db.exec(`
      CREATE TABLE activities (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        priority INTEGER,
        is_locked INTEGER,
        span_blocks INTEGER
      )
    `)
    // Reproduce the groups/cohorts precedent: a real-world db that already
    // hit a duplicate-name race (two "Water Play" activities) and has since
    // been used normally — a template_slot points at the NON-min-rowid
    // duplicate, which is exactly the row the naive dedupe would delete.
    // template_slots.activity_id IS a DB-level REFERENCES column (unlike
    // the plain-TEXT columns in prior tasks), so this needs the same
    // repoint-before-delete treatment groups.id/template_slots.group_id got
    // at version 12.
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a1', 'camp1', 'Water Play')
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a2', 'camp1', 'Water Play')
    db.prepare(
      "INSERT INTO template_slots (id, template_id, activity_id) VALUES ('ts1', 'tmpl1', 'a2')"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 15').run()

    expect(() => initSchema(db)).not.toThrow()

    const survivor = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get('camp1', 'Water Play')
    expect(db.prepare('SELECT activity_id FROM template_slots WHERE id = ?').get('ts1').activity_id).toBe(
      survivor.id
    )
    db.close()
  })

  it('repoints activities.weather_alternative_id (self-reference) off a duplicate activity before deleting it, instead of silently orphaning the pointer', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.exec('DROP TABLE activities')
    // weather_alternative_id is included here (unlike the other rebuilt-table
    // tests above) so the pointer can be seeded BEFORE the migration runs —
    // this table shape wouldn't exist on a genuine pre-version-15 db (the
    // column is new), but the point of this test is to exercise the
    // repoint-before-delete logic itself, not the ALTER TABLE add-column step
    // (already covered by the "adds every new column" test above).
    db.exec(`
      CREATE TABLE activities (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        priority INTEGER,
        is_locked INTEGER,
        span_blocks INTEGER,
        weather_alternative_id TEXT
      )
    `)
    // Reproduce the scenario: two "Water Play" activities exist (a race
    // before the UNIQUE constraint existed), and a third activity's weather
    // alternative points at the NON-min-rowid duplicate — exactly the row
    // the naive dedupe would delete.
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a1', 'camp1', 'Water Play')
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('a2', 'camp1', 'Water Play')
    db.prepare(
      "INSERT INTO activities (id, camp_id, name, weather_alternative_id) VALUES ('a3', 'camp1', 'Kayaking', 'a2')"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 15').run()

    expect(() => initSchema(db)).not.toThrow()

    const survivor = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get('camp1', 'Water Play')
    expect(db.prepare('SELECT weather_alternative_id FROM activities WHERE id = ?').get('a3').weather_alternative_id).toBe(
      survivor.id
    )
    db.close()
  })
})

describe('schema v19: audit_events table', () => {
  it('creates the audit_events table + indexes on a fresh install, at version 19', () => {
    const db = freshDb()
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
      .get()
    expect(table).toBeDefined()

    const cols = db.pragma('table_info(audit_events)').map((c) => c.name)
    for (const col of [
      'id', 'camp_id', 'actor_user_id', 'device_id', 'action',
      'target_type', 'target_id', 'occurred_at', 'outcome', 'reason', 'metadata',
    ]) {
      expect(cols).toContain(col)
    }

    const indexes = db.pragma('index_list(audit_events)').map((i) => i.name)
    expect(indexes).toContain('idx_audit_events_occurred_at')
    expect(indexes).toContain('idx_audit_events_actor')

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('adds audit_events to a pre-migration db missing it, via the guarded CREATE path', () => {
    const db = freshDb()
    db.exec('DROP TABLE audit_events')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 19').run()

    expect(() => initSchema(db)).not.toThrow()

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
      .get()
    expect(table).toBeDefined()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('rejects a row with an outcome outside allow/deny', () => {
    const db = freshDb()
    expect(() => {
      db.prepare(
        "INSERT INTO audit_events (action, occurred_at, outcome) VALUES ('auth.login', ?, 'maybe')"
      ).run(new Date().toISOString())
    }).toThrow(/CHECK/)
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})

describe('schema v20: device trust, pairing, and revocation', () => {
  const DEVICE_COLUMNS = [
    'authorized_at',
    'authorized_by_user_id',
    'revoked_at',
    'revoked_by_user_id',
    'revocation_reason',
    'device_secret_identifier',
    'pairing_status',
  ]

  it('a fresh install has all new devices columns, the host_signing_key table, and camps.signing_public_key, at version 20', () => {
    const db = freshDb()
    const deviceCols = db.pragma('table_info(devices)').map((c) => c.name)
    for (const col of DEVICE_COLUMNS) {
      expect(deviceCols, `expected devices.${col}`).toContain(col)
    }

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'host_signing_key'")
      .get()
    expect(table).toBeDefined()

    const campCols = db.pragma('table_info(camps)').map((c) => c.name)
    expect(campCols).toContain('signing_public_key')
    // signing_secret must still exist and be readable — this migration adds
    // signing_public_key alongside it, never drops it.
    expect(campCols).toContain('signing_secret')

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('a freshly-inserted devices row defaults pairing_status to pending', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
    const row = db.prepare('SELECT pairing_status, authorized_at, revoked_at FROM devices WHERE id = ?').get('d1')
    expect(row.pairing_status).toBe('pending')
    expect(row.authorized_at).toBeNull()
    expect(row.revoked_at).toBeNull()
    db.close()
  })

  it('host_signing_key enforces a singleton row via CHECK(id = 1)', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, 'pub', 'priv', ?)"
    ).run(new Date().toISOString())
    expect(() => {
      db.prepare(
        "INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (2, 'pub2', 'priv2', ?)"
      ).run(new Date().toISOString())
    }).toThrow(/CHECK/)
    db.close()
  })

  it('adds every new devices column, host_signing_key, and camps.signing_public_key to a pre-migration db missing them, via the guarded ALTER/CREATE path', () => {
    const db = freshDb()
    // See the identical note on the "fresh db (schema.sql) and a pre-v20 db"
    // test further below: renaming camps rewrites schedule_templates'
    // (and every other referencing table's) FK clause to point at
    // camps_tmp, which then dangles once camps_tmp is dropped — surfaced by
    // the version-21 migration's write to schedule_templates below.
    db.pragma('foreign_keys = OFF')
    db.exec('ALTER TABLE devices RENAME TO devices_tmp')
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_seen_at TEXT,
        last_synced_at TEXT,
        last_synced_seq INTEGER
      )
    `)
    db.exec('INSERT INTO devices (id, name, last_seen_at, last_synced_at, last_synced_seq) SELECT id, name, last_seen_at, last_synced_at, last_synced_seq FROM devices_tmp')
    db.exec('DROP TABLE devices_tmp')
    db.exec('DROP TABLE host_signing_key')

    db.exec('ALTER TABLE camps RENAME TO camps_tmp')
    db.exec('CREATE TABLE camps (id TEXT PRIMARY KEY, name TEXT NOT NULL, signing_secret TEXT)')
    db.exec('INSERT INTO camps (id, name, signing_secret) SELECT id, name, signing_secret FROM camps_tmp')
    db.exec('DROP TABLE camps_tmp')

    db.prepare('DELETE FROM schema_migrations WHERE version >= 20').run()

    let deviceCols = db.pragma('table_info(devices)').map((c) => c.name)
    expect(deviceCols).not.toContain('authorized_at')
    let campCols = db.pragma('table_info(camps)').map((c) => c.name)
    expect(campCols).not.toContain('signing_public_key')

    expect(() => initSchema(db)).not.toThrow()

    deviceCols = db.pragma('table_info(devices)').map((c) => c.name)
    for (const col of DEVICE_COLUMNS) {
      expect(deviceCols, `expected devices.${col} after migration`).toContain(col)
    }
    campCols = db.pragma('table_info(camps)').map((c) => c.name)
    expect(campCols).toContain('signing_public_key')
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'host_signing_key'")
      .get()
    expect(table).toBeDefined()

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('does NOT auto-authorize a pre-existing (pre-migration) devices row — lands as pending, per the no-migration-tooling-for-existing-camps non-goal', () => {
    const db = freshDb()
    db.exec('ALTER TABLE devices RENAME TO devices_tmp')
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_seen_at TEXT,
        last_synced_at TEXT,
        last_synced_seq INTEGER
      )
    `)
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('pre-existing-device', 'Old Device')
    db.exec('DROP TABLE devices_tmp')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 20').run()

    initSchema(db)

    const row = db.prepare('SELECT pairing_status, authorized_at FROM devices WHERE id = ?').get('pre-existing-device')
    expect(row.pairing_status).toBe('pending')
    expect(row.authorized_at).toBeNull()
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('fresh db (schema.sql) and a pre-v20 db upgraded via the migration block end up with IDENTICAL devices/camps/host_signing_key schema', () => {
    const freshDatabase = freshDb()

    const migratedDatabase = freshDb()
    // T7 fix follow-up: SQLite's ALTER TABLE RENAME automatically rewrites
    // every OTHER table's FOREIGN KEY clauses that reference the renamed
    // table (e.g. schedule_templates' `camp_id REFERENCES camps(id)` becomes
    // `REFERENCES camps_tmp(id)`) — a schema-level side effect, not merely a
    // temporary enforcement gap. Once camps_tmp is dropped below, that
    // rewritten reference points at a table that no longer exists, and any
    // later DML against schedule_templates (the version-21 migration below
    // is the first one that ever touches it) throws `no such table:
    // main.camps_tmp` with foreign_keys=ON. This test's rename-based
    // simulation of "a pre-migration db" predates schedule_templates having
    // any migration that writes to it, so this was never reachable before.
    // Disabling enforcement for this test's manual DDL + the initSchema call
    // below avoids it; production code never renames camps, so this is a
    // test-simulation artifact, not a real migration-safety gap.
    migratedDatabase.pragma('foreign_keys = OFF')
    migratedDatabase.exec('ALTER TABLE devices RENAME TO devices_tmp')
    migratedDatabase.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_seen_at TEXT,
        last_synced_at TEXT,
        last_synced_seq INTEGER
      )
    `)
    migratedDatabase.exec('INSERT INTO devices (id, name, last_seen_at, last_synced_at, last_synced_seq) SELECT id, name, last_seen_at, last_synced_at, last_synced_seq FROM devices_tmp')
    migratedDatabase.exec('DROP TABLE devices_tmp')
    migratedDatabase.exec('DROP TABLE host_signing_key')
    migratedDatabase.exec('ALTER TABLE camps RENAME TO camps_tmp')
    migratedDatabase.exec('CREATE TABLE camps (id TEXT PRIMARY KEY, name TEXT NOT NULL, signing_secret TEXT)')
    migratedDatabase.exec('INSERT INTO camps (id, name, signing_secret) SELECT id, name, signing_secret FROM camps_tmp')
    migratedDatabase.exec('DROP TABLE camps_tmp')
    migratedDatabase.prepare('DELETE FROM schema_migrations WHERE version >= 20').run()
    initSchema(migratedDatabase)

    for (const t of ['devices', 'camps', 'host_signing_key']) {
      const freshCols = freshDatabase.pragma(`table_info(${t})`)
      const migratedCols = migratedDatabase.pragma(`table_info(${t})`)
      const normalize = (cols) =>
        cols
          .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }))
          .sort((a, b) => a.name.localeCompare(b.name))
      expect(normalize(migratedCols), `schema mismatch for table ${t}`).toEqual(normalize(freshCols))
    }

    expect(getSchemaVersion(migratedDatabase)).toBe(CURRENT_SCHEMA_VERSION)
    freshDatabase.close()
    migratedDatabase.close()
  })
})

describe('T7 fix: schedule_templates re-key + UNIQUE(camp_id) (schema version 21)', () => {
  it('re-keys an existing random-UUID schedule_templates row to the deterministic id, repointing template_slots/template_overlays/schedule_snapshots children', () => {
    const db = freshDb()
    // freshDb() already ran the version-21 migration once (as a no-op, on an
    // empty schedule_templates table) as part of its initial full
    // migration — including creating idx_schedule_templates_camp. Drop it so
    // the manually-inserted "pre-migration" row below can be simulated
    // faithfully (a genuine pre-migration db never has this index), matching
    // every other repoint test in this file's own pattern (e.g. the cohorts/
    // groups/tiers/activities dedupe tests, which rebuild the table itself
    // rather than leave a later constraint in place).
    db.exec('DROP INDEX IF EXISTS idx_schedule_templates_camp')
    db.exec('DROP INDEX IF EXISTS idx_schedule_templates_camp_kind')
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    // Simulate the real production shape this migration exists for: one
    // pre-existing schedule_templates row under a random-UUID id, with real
    // children already pointing at it.
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run('old-random-uuid', 'camp1', 'Master Template')
    db.prepare("INSERT INTO template_slots (id, template_id) VALUES ('slot1', 'old-random-uuid')").run()
    db.prepare("INSERT INTO template_overlays (id, template_id) VALUES ('ov1', 'old-random-uuid')").run()
    db.prepare("INSERT INTO schedule_snapshots (id, template_id, created_at) VALUES ('snap1', 'old-random-uuid', ?)").run(new Date().toISOString())
    db.prepare('DELETE FROM schema_migrations WHERE version >= 21').run()

    expect(() => initSchema(db)).not.toThrow()

    const deterministicId = 'schedule-template:camp1'
    const row = db.prepare('SELECT id FROM schedule_templates WHERE camp_id = ?').get('camp1')
    expect(row.id).toBe(deterministicId)
    expect(db.prepare("SELECT id FROM schedule_templates WHERE id = 'old-random-uuid'").get()).toBeUndefined()

    expect(db.prepare('SELECT template_id FROM template_slots WHERE id = ?').get('slot1').template_id).toBe(deterministicId)
    expect(db.prepare('SELECT template_id FROM template_overlays WHERE id = ?').get('ov1').template_id).toBe(deterministicId)
    expect(db.prepare('SELECT template_id FROM schedule_snapshots WHERE id = ?').get('snap1').template_id).toBe(deterministicId)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('is a no-op re-key when the row already has the deterministic id', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run('schedule-template:camp1', 'camp1', 'Master Template')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 21').run()

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM schedule_templates WHERE camp_id = ?').all('camp1')
    expect(rows).toEqual([{ id: 'schedule-template:camp1' }])
    db.close()
  })

  it('dedupes multiple pre-existing rows for the same camp (keeping MIN(rowid), repointing children) before re-keying the survivor', () => {
    const db = freshDb()
    // See the note in the previous test — a genuine pre-migration db (which
    // is what a duplicate-row shape implies) never has this index yet.
    db.exec('DROP INDEX IF EXISTS idx_schedule_templates_camp')
    db.exec('DROP INDEX IF EXISTS idx_schedule_templates_camp_kind')
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run('dup1', 'camp1', 'First')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run('dup2', 'camp1', 'Second')
    // A child points at the NON-min-rowid duplicate — the row a naive
    // dedupe would delete outright, mirroring this project's precedent for
    // every other entity's version-11/12/14/15 dedupe fix.
    db.prepare("INSERT INTO template_slots (id, template_id) VALUES ('slot1', 'dup2')").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 21').run()

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM schedule_templates WHERE camp_id = ?').all('camp1')
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('schedule-template:camp1')
    expect(db.prepare('SELECT template_id FROM template_slots WHERE id = ?').get('slot1').template_id).toBe('schedule-template:camp1')
    db.close()
  })

  it('enforces one route per WEEK via UNIQUE(week_id, kind) — v27 superseded the old camp-scoped backstop', () => {
    // The v21 backstop was UNIQUE(camp_id); v23 narrowed it to (camp_id, kind);
    // v27 moved it to (week_id, kind) so a camp can hold many weeks
    // (docs/adr/2026-08-02-schedule-weeks-first-class.md). freshDb runs every
    // migration, so the live index here is the week-scoped one.
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, ?, 0)')
      .run('week1', 'camp1', 'Week 1', 0)
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, ?, 0)')
      .run('week2', 'camp1', 'Week 2', 1)
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
      .run('schedule-template:week1', 'camp1', 'Master Template', 'generated', 'week1')
    // Same week + same route under a different id: rejected.
    expect(() => {
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
        .run('some-other-id', 'camp1', 'Second Template', 'generated', 'week1')
    }).toThrow(/UNIQUE/)
    // Same camp, DIFFERENT week, same route: allowed — this is the whole point.
    expect(() => {
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
        .run('schedule-template:week2', 'camp1', 'Week 2', 'generated', 'week2')
    }).not.toThrow()
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})

describe('T7 fix: device_identity.first_sync_completed_at + backfill (schema version 22)', () => {
  it('a fresh install has the column, defaulting to NULL', () => {
    const db = freshDb()
    // device_identity only gains a row via getOrCreateDeviceId — openLocalDb
    // alone (freshDb()) does not call it, matching real startup order
    // (electron/main.js calls it separately, right after openLocalDb).
    getOrCreateDeviceId(db)
    const col = db.pragma('table_info(device_identity)').find((c) => c.name === 'first_sync_completed_at')
    expect(col).toBeDefined()
    const row = db.prepare('SELECT first_sync_completed_at FROM device_identity LIMIT 1').get()
    expect(row.first_sync_completed_at).toBeNull()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('backfills first_sync_completed_at for a device whose db already has a camps row at migration time (an already-working install, not a fresh pairing)', () => {
    const db = freshDb()
    getOrCreateDeviceId(db)
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 22').run()
    db.prepare('UPDATE device_identity SET first_sync_completed_at = NULL').run()

    initSchema(db)

    const row = db.prepare('SELECT first_sync_completed_at FROM device_identity LIMIT 1').get()
    expect(row.first_sync_completed_at).toBeTruthy()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('does NOT backfill for a device with no camps row — a genuinely fresh device must still be gated', () => {
    const db = freshDb()
    getOrCreateDeviceId(db)
    db.prepare('DELETE FROM schema_migrations WHERE version >= 22').run()
    db.prepare('UPDATE device_identity SET first_sync_completed_at = NULL').run()

    initSchema(db)

    const row = db.prepare('SELECT first_sync_completed_at FROM device_identity LIMIT 1').get()
    expect(row.first_sync_completed_at).toBeNull()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('does not clobber an already-set first_sync_completed_at on re-migration (COALESCE)', () => {
    const db = freshDb()
    getOrCreateDeviceId(db)
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    const earlier = '2020-01-01T00:00:00.000Z'
    db.prepare('UPDATE device_identity SET first_sync_completed_at = ?').run(earlier)
    db.prepare('DELETE FROM schema_migrations WHERE version >= 22').run()

    initSchema(db)

    const row = db.prepare('SELECT first_sync_completed_at FROM device_identity LIMIT 1').get()
    expect(row.first_sync_completed_at).toBe(earlier)
    db.close()
  })

  it('is idempotent: re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})
