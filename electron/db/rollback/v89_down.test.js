// T328 Slice 1 correction pass — rollbackV89 collapses peer_last_addresses from v89's composite
// PRIMARY KEY(peer_id, multiaddr) shape back to v88's PRIMARY KEY(peer_id) shape, keeping only
// the most-recently-seen address per peer_id (the rest are discarded — documented data loss,
// recoverable the next time each peer reconnects, same posture as the table's other
// never-replicates rollbacks).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV89 } from './v89_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v89-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const isComposite = (db) =>
  db.pragma('table_info(peer_last_addresses)').filter((c) => c.pk > 0).length === 2

describe('rollbackV89', () => {
  it('collapses the table back to single-row-per-peer (PRIMARY KEY(peer_id))', () => {
    const db = migratedDb()
    expect(isComposite(db)).toBe(true)
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)')
      .run('peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', '2026-10-02T00:00:00.000Z')
    rollbackV89(db)
    expect(isComposite(db)).toBe(false)
    db.close()
  })

  it('keeps only the most-recently-seen address per peer_id, discarding the rest', () => {
    const db = migratedDb()
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)')
      .run('peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', '2026-10-02T00:00:00.000Z')
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)')
      .run('peer-a', '/ip4/192.168.1.9/tcp/4001/p2p/peer-a', '2026-10-02T00:05:00.000Z')
    const result = rollbackV89(db)
    const rows = db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').all('peer-a')
    expect(rows).toHaveLength(1)
    expect(rows[0].multiaddr).toBe('/ip4/192.168.1.9/tcp/4001/p2p/peer-a')
    expect(result.discarded).toEqual({ addresses: 1 })
    db.close()
  })

  it('clears version 89 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (90, ?)')
      .run(new Date().toISOString())
    rollbackV89(db)
    expect(getSchemaVersion(db)).toBe(88)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    rollbackV89(db)
    expect(() => rollbackV89(db)).not.toThrow()
    db.close()
  })

  it('lets initSchema re-migrate forward to the composite-key shape again', () => {
    const db = migratedDb()
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)')
      .run('peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', '2026-10-02T00:00:00.000Z')
    rollbackV89(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasTable(db, 'peer_last_addresses')).toBe(true)
    expect(isComposite(db)).toBe(true)
    db.close()
  }, 30000)
})
