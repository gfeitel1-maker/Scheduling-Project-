// T328 Slice 1 correction pass (docs/adr/2026-10-02-wan-discovery-transport-ladder.md) — schema
// v89: widens peer_last_addresses from PRIMARY KEY(peer_id) (v88, last-write-wins) to composite
// PRIMARY KEY(peer_id, multiaddr), so a multi-homed peer's multiple observed addresses all
// survive instead of the newest silently discarding the others. Mirrors the fresh/upgraded-db
// shape of peerLastAddresses.migration.test.js (v88), plus the v88->v89 data-carry-forward case.
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

const freshDb = () => openLocalDb(tmpFile('v89-fresh'))

function preV89Db(tag = 'v89-migrated') {
  // A db that has already migrated through v88's single-row shape, with one pre-existing
  // remembered address, then rewound to simulate "about to migrate to v89".
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS peer_last_addresses')
  db.exec(`CREATE TABLE peer_last_addresses (
    peer_id TEXT PRIMARY KEY,
    multiaddr TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`)
  db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)').run(
    'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', '2026-10-02T00:00:00.000Z'
  )
  db.prepare('DELETE FROM schema_migrations WHERE version >= 89').run()
  return db
}

describe('migration v89: version and composite-key shape', () => {
  it('declares schema version 89 on a fresh db', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 89').get().c).toBe(1)
    db.close()
  })

  it('allows TWO rows for the same peer_id at different addresses on a fresh db', () => {
    const db = freshDb()
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)')
      .run('peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', '2026-10-02T00:00:00.000Z')
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)')
      .run('peer-a', '/ip4/192.168.1.9/tcp/4001/p2p/peer-a', '2026-10-02T00:01:00.000Z')
    const rows = db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').all('peer-a')
    expect(rows).toHaveLength(2)
    db.close()
  })

  it('migrates a pre-v89 db forward, carrying the existing single row as the composite-key shape', () => {
    const db = preV89Db()
    expect(getSchemaVersion(db)).toBe(88)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    const rows = db.prepare('SELECT * FROM peer_last_addresses').all()
    expect(rows).toEqual([
      { peer_id: 'peer-a', multiaddr: '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', last_seen_at: '2026-10-02T00:00:00.000Z' },
    ])
    // Composite key now allows a SECOND address for the same peer — the v88 shape would have
    // thrown a PRIMARY KEY collision here.
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)')
      .run('peer-a', '/ip4/192.168.1.9/tcp/4001/p2p/peer-a', '2026-10-02T00:02:00.000Z')
    expect(db.prepare('SELECT COUNT(*) c FROM peer_last_addresses WHERE peer_id = ?').get('peer-a').c).toBe(2)
    db.close()
  })

  it('is idempotent — re-running initSchema on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})
