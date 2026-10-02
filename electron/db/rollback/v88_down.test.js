// T328 Slice 1 — rollbackV88 drops peer_last_addresses. Mirrors v86_down.test.js's shape (the
// closest template: a wholly new, additive table with no back-fill).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV88 } from './v88_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v88-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const seed = (db) => {
  db.prepare(
    'INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)'
  ).run('peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', '2026-10-02T00:00:00.000Z')
}

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('rollbackV88', () => {
  it('drops peer_last_addresses', () => {
    const db = migratedDb()
    seed(db)
    rollbackV88(db)
    expect(hasTable(db, 'peer_last_addresses')).toBe(false)
    db.close()
  })

  it('reports how many rows were discarded', () => {
    const db = migratedDb()
    seed(db)
    db.prepare(
      'INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)'
    ).run('peer-b', '/ip4/10.0.0.9/tcp/4001/p2p/peer-b', '2026-10-02T00:00:00.000Z')
    expect(rollbackV88(db).discarded).toEqual({ addresses: 2 })
    db.close()
  })

  // `>= 88`, never `= 88` — a bare equality strands a HIGHER version in the table
  // (bareEqualityRollback.guard.test.js's class).
  it('clears version 88 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (89, ?)')
      .run(new Date().toISOString())
    rollbackV88(db)
    expect(getSchemaVersion(db)).toBe(87)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db)
    rollbackV88(db)
    expect(() => rollbackV88(db)).not.toThrow()
    expect(rollbackV88(db).discarded).toEqual({ addresses: 0 })
    db.close()
  })

  it('lets initSchema re-create the table, empty', () => {
    const db = migratedDb()
    seed(db)
    rollbackV88(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM peer_last_addresses').get().c).toBe(0)
    db.close()
  }, 30000)
})
