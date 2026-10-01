// T322 S3a — rollbackV86 drops peer_tombstone_reports. Mirrors v85_down.test.js's
// shape (the closest template: a wholly new, additive table with no back-fill).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV86 } from './v86_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v86-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const seed = (db) => {
  db.prepare(
    "INSERT INTO peer_tombstone_reports (device_id, tombstone_id, version, reported_at) VALUES (?, ?, ?, ?)"
  ).run('device-b', 'tomb-x', 1, '2026-10-01T00:00:00.000Z')
}

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('rollbackV86', () => {
  it('drops peer_tombstone_reports', () => {
    const db = migratedDb()
    seed(db)
    rollbackV86(db)
    expect(hasTable(db, 'peer_tombstone_reports')).toBe(false)
    db.close()
  })

  it('reports how many rows were discarded', () => {
    const db = migratedDb()
    seed(db)
    db.prepare(
      "INSERT INTO peer_tombstone_reports (device_id, tombstone_id, version, reported_at) VALUES (?, ?, ?, ?)"
    ).run('device-b', 'tomb-y', 2, '2026-10-01T00:00:00.000Z')
    expect(rollbackV86(db).discarded).toEqual({ reports: 2 })
    db.close()
  })

  // `>= 86`, never `= 86` — a bare equality strands a HIGHER version in the
  // table (bareEqualityRollback.guard.test.js's class).
  it('clears version 86 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (87, ?)')
      .run(new Date().toISOString())
    rollbackV86(db)
    expect(getSchemaVersion(db)).toBe(85)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db)
    rollbackV86(db)
    expect(() => rollbackV86(db)).not.toThrow()
    expect(rollbackV86(db).discarded).toEqual({ reports: 0 })
    db.close()
  })

  it('lets initSchema re-create the table, empty', () => {
    const db = migratedDb()
    seed(db)
    rollbackV86(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM peer_tombstone_reports').get().c).toBe(0)
    db.close()
  }, 30000)
})
