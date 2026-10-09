// @vitest-environment node
//
// Migration v92 — drops pending_writes and pending_restores, the Client's durable offline
// write/restore queues, vestigial since the Stage 6c cutover (T311). Rollback:
// rollback/v92_down.test.js.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION, PENDING_RESTORES_DDL } from './localDb.js'

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

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('migration v92: pending_writes and pending_restores are gone', () => {
  it('a fresh database has neither table and declares version 92', () => {
    const db = openLocalDb(tmpFile('v92-fresh'))
    expect(hasTable(db, 'pending_writes')).toBe(false)
    expect(hasTable(db, 'pending_restores')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 92').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('a v90 database holding both tables, with rows, migrates to v92 with both gone', () => {
    const db = new Database(tmpFile('v92-migrated'))
    db.pragma('foreign_keys = ON')
    initSchema(db)
    db.exec(PENDING_RESTORES_DDL)
    db.exec(`CREATE TABLE IF NOT EXISTS pending_writes (
      pending_id TEXT PRIMARY KEY, client_write_id TEXT NOT NULL, entity TEXT NOT NULL,
      entity_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT, parent_op_id TEXT, created_at TEXT NOT NULL
    )`)
    db.prepare("INSERT INTO pending_restores (pending_id, entity, entity_id, requested_by, requested_at) VALUES ('p','activities','a','u','t')").run()
    db.prepare("INSERT INTO pending_writes (pending_id, client_write_id, entity, entity_id, field, created_at) VALUES ('w','c','activities','a','name','t')").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 92').run()
    expect(getSchemaVersion(db)).toBe(90)

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasTable(db, 'pending_writes')).toBe(false)
    expect(hasTable(db, 'pending_restores')).toBe(false)
    db.close()
  })
})
