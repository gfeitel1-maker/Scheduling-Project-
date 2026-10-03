// T331 — rollbackV90 drops applied_authority_log and authority_cache. Mirrors v88_down.test.js's
// shape (the closest template: wholly new, additive, never-synced tables with no back-fill).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV90 } from './v90_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v90-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const seed = (db) => {
  db.prepare(
    'INSERT INTO applied_authority_log (entry_id, kind, target_device_id, signer_device_id, verified_at) VALUES (?, ?, ?, ?, ?)'
  ).run('e1', 'grant', 'device-a', 'FOUNDER', '2026-10-02T00:00:00.000Z')
  db.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run(
    'device-a',
    'admin',
    '2026-10-02T00:00:00.000Z'
  )
}

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('rollbackV90', () => {
  it('drops applied_authority_log and authority_cache', () => {
    const db = migratedDb()
    seed(db)
    rollbackV90(db)
    expect(hasTable(db, 'applied_authority_log')).toBe(false)
    expect(hasTable(db, 'authority_cache')).toBe(false)
    db.close()
  })

  it('reports how many rows were discarded', () => {
    const db = migratedDb()
    seed(db)
    expect(rollbackV90(db).discarded).toEqual({ appliedAuthorityLog: 1, authorityCache: 1 })
    db.close()
  })

  // `>= 90`, never `= 90` — a bare equality strands a HIGHER version in the table
  // (bareEqualityRollback.guard.test.js's class).
  it('clears version 90 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (91, ?)').run(
      new Date().toISOString()
    )
    rollbackV90(db)
    expect(getSchemaVersion(db)).toBe(89)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db)
    rollbackV90(db)
    expect(() => rollbackV90(db)).not.toThrow()
    expect(rollbackV90(db).discarded).toEqual({ appliedAuthorityLog: 0, authorityCache: 0 })
    db.close()
  })

  it('lets initSchema re-create both tables, empty', () => {
    const db = migratedDb()
    seed(db)
    rollbackV90(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM applied_authority_log').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM authority_cache').get().c).toBe(0)
    db.close()
  }, 30000)
})
