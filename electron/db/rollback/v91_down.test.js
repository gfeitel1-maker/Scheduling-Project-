// Amendment 2026-10-03b — rollbackV91 drops devices.revoked_without_authority_knowledge. Mirrors
// v87_down.test.js's shape (the closest template: a plain single-column ALTER DROP COLUMN, no
// table rebuild).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
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

const hasColumn = (db, table, column) =>
  db.pragma(`table_info(${table})`).some((c) => c.name === column)

const seed = (db, id, flag) => {
  db.prepare(
    "INSERT INTO devices (id, name, revoked_at, revoked_without_authority_knowledge) VALUES (?, ?, ?, ?)"
  ).run(id, `Device ${id}`, '2026-10-03T00:00:00.000Z', flag)
}

describe('rollbackV91', () => {
  it('drops devices.revoked_without_authority_knowledge', () => {
    const db = migratedDb()
    seed(db, 'device-1', 1)
    rollbackV91(db)
    expect(hasColumn(db, 'devices', 'revoked_without_authority_knowledge')).toBe(false)
    db.close()
  })

  it('reports how many markers (value=1) were discarded', () => {
    const db = migratedDb()
    seed(db, 'device-1', 1)
    seed(db, 'device-2', 1)
    seed(db, 'device-3', null)
    expect(rollbackV91(db).discarded).toEqual({ uncorroboratedMarkers: 2 })
    db.close()
  })

  // `>= 91`, never `= 91` — a bare equality strands a HIGHER version in the table
  // (bareEqualityRollback.guard.test.js's class).
  it('clears version 91 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db, 'device-1', 1)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (92, ?)')
      .run(new Date().toISOString())
    rollbackV91(db)
    expect(getSchemaVersion(db)).toBe(90)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db, 'device-1', 1)
    rollbackV91(db)
    expect(() => rollbackV91(db)).not.toThrow()
    expect(rollbackV91(db).discarded).toEqual({ uncorroboratedMarkers: 0 })
    db.close()
  })

  it('lets initSchema re-create the column, empty', () => {
    const db = migratedDb()
    seed(db, 'device-1', 1)
    rollbackV91(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasColumn(db, 'devices', 'revoked_without_authority_knowledge')).toBe(true)
    db.close()
  }, 30000)
})
