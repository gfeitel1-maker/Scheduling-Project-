// T322 S3a (docs/adr/2026-09-19-multi-device-erasure-propagation.md's
// "Addendum (2026-10-01, Architect, T322 S3a)") — schema v86: the new
// peer_tombstone_reports table. A peer self-reports the set of
// (tombstone id, version) pairs it has verified-and-projected, over the
// authenticated `authenticate` handshake; this table is the receiver's
// projection of those self-reports. Mirrors camperIdentityKeys.migration.
// test.js's shape (fresh-db + upgraded-db checks), minus a back-fill — this
// table starts empty on upgrade, since there is nothing to derive it from.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema, openLocalDb } from './localDb.js'

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

const freshDb = () => openLocalDb(tmpFile('v86-fresh'))
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

function preV86Db(tag = 'v86-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS peer_tombstone_reports')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 86').run()
  return db
}

describe('migration v86: version and table presence', () => {
  it('declares schema version 86 on a fresh db', () => {
    const db = freshDb()
    expect(CURRENT_SCHEMA_VERSION).toBe(86)
    expect(getSchemaVersion(db)).toBe(86)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 86').get().c).toBe(1)
    db.close()
  })

  it('creates peer_tombstone_reports on a fresh db', () => {
    const db = freshDb()
    expect(hasTable(db, 'peer_tombstone_reports')).toBe(true)
    db.close()
  })

  it('creates peer_tombstone_reports on an upgraded pre-v86 db', () => {
    const db = preV86Db()
    expect(hasTable(db, 'peer_tombstone_reports')).toBe(false)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(86)
    expect(hasTable(db, 'peer_tombstone_reports')).toBe(true)
    db.close()
  })
})

describe('peer_tombstone_reports: composite primary key (device_id, tombstone_id)', () => {
  it('persists two rows for the same device with different tombstone ids', () => {
    const db = freshDb()
    const insert = db.prepare(
      'INSERT INTO peer_tombstone_reports (device_id, tombstone_id, version, reported_at) VALUES (?, ?, ?, ?)'
    )
    insert.run('device-b', 'tomb-x', 1, '2026-10-01T00:00:00.000Z')
    insert.run('device-b', 'tomb-y', 2, '2026-10-01T00:00:00.000Z')
    expect(db.prepare('SELECT COUNT(*) c FROM peer_tombstone_reports WHERE device_id = ?').get('device-b').c).toBe(2)
    db.close()
  })

  it('replaces, not duplicates, a second row for the same (device_id, tombstone_id)', () => {
    const db = freshDb()
    db.prepare(
      'INSERT OR REPLACE INTO peer_tombstone_reports (device_id, tombstone_id, version, reported_at) VALUES (?, ?, ?, ?)'
    ).run('device-b', 'tomb-x', 1, '2026-10-01T00:00:00.000Z')
    db.prepare(
      'INSERT OR REPLACE INTO peer_tombstone_reports (device_id, tombstone_id, version, reported_at) VALUES (?, ?, ?, ?)'
    ).run('device-b', 'tomb-x', 2, '2026-10-01T00:01:00.000Z')
    const rows = db.prepare('SELECT * FROM peer_tombstone_reports WHERE device_id = ? AND tombstone_id = ?').all('device-b', 'tomb-x')
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(2)
    db.close()
  })
})
