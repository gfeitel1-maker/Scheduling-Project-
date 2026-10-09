// T348 - schema v93: punch_identity and peer_punch_memory. Fresh-db and upgrade-from-v92 checks.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema, openLocalDb } from './localDb.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
  }
})
const tmpFile = (tag) => {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('migration v93', () => {
  it('a fresh db carries both tables at the current version', () => {
    const db = openLocalDb(tmpFile('v93-fresh'))
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 93').get().c).toBe(1)
    expect(hasTable(db, 'punch_identity')).toBe(true)
    expect(hasTable(db, 'peer_punch_memory')).toBe(true)
    db.close()
  })

  it('upgrading from v92 creates both tables, empty, and stamps v93', () => {
    const db = new Database(tmpFile('v93-up'))
    db.pragma('foreign_keys = ON')
    initSchema(db)
    db.exec('DROP TABLE punch_identity; DROP TABLE peer_punch_memory;')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 93').run()
    expect(getSchemaVersion(db)).toBe(92)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM punch_identity').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM peer_punch_memory').get().c).toBe(0)
    db.close()
  })
})
