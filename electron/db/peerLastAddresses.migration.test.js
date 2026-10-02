// T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md, Slice 1) — schema v88: the
// new peer_last_addresses table. Mirrors peerTombstoneReports.migration.test.js's shape
// (fresh-db + upgraded-db checks), minus a back-fill — this table starts empty on upgrade, since
// there is nothing to derive it from (a peer's address is learned only from a live authenticated
// connection).
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

const freshDb = () => openLocalDb(tmpFile('v88-fresh'))
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

function preV88Db(tag = 'v88-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS peer_last_addresses')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 88').run()
  return db
}

describe('migration v88: version and table presence', () => {
  it('declares schema version 88 on a fresh db', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 88').get().c).toBe(1)
    db.close()
  })

  it('creates peer_last_addresses on a fresh db', () => {
    const db = freshDb()
    expect(hasTable(db, 'peer_last_addresses')).toBe(true)
    db.close()
  })

  it('creates peer_last_addresses on an upgraded pre-v88 db', () => {
    const db = preV88Db()
    expect(hasTable(db, 'peer_last_addresses')).toBe(false)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasTable(db, 'peer_last_addresses')).toBe(true)
    db.close()
  })
})

describe('peer_last_addresses: single row per peer_id', () => {
  it('upserts rather than duplicates a second remembered address for the same peer_id', () => {
    const db = freshDb()
    db.prepare(
      'INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(peer_id) DO UPDATE SET multiaddr = excluded.multiaddr, last_seen_at = excluded.last_seen_at'
    ).run('peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', '2026-10-02T00:00:00.000Z')
    db.prepare(
      'INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(peer_id) DO UPDATE SET multiaddr = excluded.multiaddr, last_seen_at = excluded.last_seen_at'
    ).run('peer-a', '/ip4/10.0.0.9/tcp/4001/p2p/peer-a', '2026-10-02T00:01:00.000Z')
    const rows = db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').all('peer-a')
    expect(rows).toHaveLength(1)
    expect(rows[0].multiaddr).toBe('/ip4/10.0.0.9/tcp/4001/p2p/peer-a')
    db.close()
  })
})
