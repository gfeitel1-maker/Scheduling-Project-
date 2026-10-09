// T311 — rollbackV91 recreates pending_writes and pending_restores, empty, with the v90 DDL.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema, PENDING_RESTORES_DDL } from '../localDb.js'
import { rollbackV91 } from './v91_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v91-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const tableSql = (db, name) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql

describe('rollbackV91', () => {
  it('recreates both tables, empty', () => {
    const db = migratedDb()
    expect(tableSql(db, 'pending_writes')).toBeUndefined()
    rollbackV91(db)
    expect(db.prepare('SELECT COUNT(*) c FROM pending_writes').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM pending_restores').get().c).toBe(0)
    db.close()
  })

  it('recreates pending_restores byte-identical to the v25 DDL', () => {
    const db = migratedDb()
    rollbackV91(db)
    expect(tableSql(db, 'pending_restores')).toBe(PENDING_RESTORES_DDL.replace('IF NOT EXISTS ', ''))
    db.close()
  })

  it('clears version 91 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (93, ?)').run(
      new Date().toISOString()
    )
    rollbackV91(db)
    expect(getSchemaVersion(db)).toBe(90)
    db.close()
  })

  it('is idempotent', () => {
    const db = migratedDb()
    rollbackV91(db)
    expect(() => rollbackV91(db)).not.toThrow()
    db.close()
  })

  it('lets initSchema drop both tables again', () => {
    const db = migratedDb()
    rollbackV91(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableSql(db, 'pending_writes')).toBeUndefined()
    expect(tableSql(db, 'pending_restores')).toBeUndefined()
    db.close()
  }, 30000)
})
