// @vitest-environment node
//
// Migration v57 — devices.libp2p_peer_id, per
// docs/adr/2026-09-06-libp2p-membership-mapping.md §4 (Stage 5d-2a).
//
// ALTER-column shape (like client_write_id/v8, devices.last_synced_seq/v7),
// not a new-table shape: the column, its nullability, and its partial UNIQUE
// index (unique among non-NULL values only) on a fresh install vs. a
// migrated pre-v57 db.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

function freshDb() {
  return openLocalDb(tmpFile('v57-fresh'))
}

// Simulate a pre-v57 db: fully migrated (so every other table/column is at
// its current shape), then strip this column back out and reset the version
// marker, so initSchema's v57 block has to rebuild it from scratch — mirrors
// the devices.last_synced_seq/v7 precedent (localDb.migrations.test.js).
function preV57Db(tag = 'v57-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP INDEX IF EXISTS idx_devices_libp2p_peer_id')
  db.exec('ALTER TABLE devices RENAME TO devices_tmp')
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_seen_at TEXT,
      last_synced_at TEXT,
      last_synced_seq INTEGER,
      authorized_at TEXT,
      authorized_by_user_id TEXT,
      revoked_at TEXT,
      revoked_by_user_id TEXT,
      revocation_reason TEXT,
      device_secret_identifier TEXT,
      pairing_status TEXT NOT NULL DEFAULT 'pending'
    )
  `)
  db.exec(`
    INSERT INTO devices (
      id, name, last_seen_at, last_synced_at, last_synced_seq,
      authorized_at, authorized_by_user_id, revoked_at, revoked_by_user_id,
      revocation_reason, device_secret_identifier, pairing_status
    )
    SELECT
      id, name, last_seen_at, last_synced_at, last_synced_seq,
      authorized_at, authorized_by_user_id, revoked_at, revoked_by_user_id,
      revocation_reason, device_secret_identifier, pairing_status
    FROM devices_tmp
  `)
  db.exec('DROP TABLE devices_tmp')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 57').run()
  return db
}

const columnInfo = (db) =>
  db
    .pragma('table_info(devices)')
    .find((c) => c.name === 'libp2p_peer_id')

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'devices'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

describe('migration v57: devices.libp2p_peer_id', () => {
  it('a fresh install has the column, nullable, and declares schema version 57', () => {
    const db = freshDb()
    expect(CURRENT_SCHEMA_VERSION).toBe(57)
    expect(getSchemaVersion(db)).toBe(57)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 57').get().c).toBe(1)

    const col = columnInfo(db)
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0)
    db.close()
  })

  it('migrates a pre-v57 db forward, adding the column', () => {
    const db = preV57Db()
    expect(getSchemaVersion(db)).toBe(56)
    expect(columnInfo(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(57)
    const col = columnInfo(db)
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0)
    db.close()
  })

  it('allows a devices row with libp2p_peer_id left NULL (the common case)', () => {
    const db = freshDb()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device 1')
    const row = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1')
    expect(row.libp2p_peer_id).toBeNull()
    db.close()
  })

  it('allows two devices to both be NULL, but rejects two devices claiming the same PeerId', () => {
    const db = freshDb()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device 1')
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d2', 'Device 2')

    expect(() => {
      db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run('peer-abc', 'd1')
    }).not.toThrow()

    expect(() => {
      db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run('peer-abc', 'd2')
    }).toThrow()

    db.close()
  })

  it('gives a fresh db and a migrated db identical devices columns and libp2p_peer_id index', () => {
    const fresh = freshDb()
    const migrated = preV57Db()
    initSchema(migrated)

    const normalize = (cols) =>
      cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
    expect(normalize(migrated.pragma('table_info(devices)'))).toEqual(normalize(fresh.pragma('table_info(devices)')))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)
    expect(getSchemaVersion(fresh)).toBe(CURRENT_SCHEMA_VERSION)
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v57 on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})

describe('devices.libp2p_peer_id is documented as a non-trust routing convenience', () => {
  it('is not referenced anywhere in the authorization boundary', () => {
    const authorizeSrc = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../auth/authorize.js'),
      'utf8'
    )
    expect(authorizeSrc).not.toMatch(/libp2p_peer_id/)
  })
})
