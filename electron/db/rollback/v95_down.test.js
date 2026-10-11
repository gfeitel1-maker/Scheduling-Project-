// F2 — rollbackV95 drops time_blocks.events_only (v87_down.test.js's shape).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV95 } from './v95_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v95-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', ?)").run('a'.repeat(64))
  return db
}

const hasColumn = (db, table, column) => db.pragma(`table_info(${table})`).some((c) => c.name === column)

const block = (db, id, eventsOnly) =>
  db.prepare("INSERT INTO time_blocks (id, camp_id, name, events_only) VALUES (?, 'c1', ?, ?)").run(id, id, eventsOnly)

describe('rollbackV95', () => {
  it('drops time_blocks.events_only', () => {
    const db = migratedDb()
    block(db, 'b1', 1)
    rollbackV95(db)
    expect(hasColumn(db, 'time_blocks', 'events_only')).toBe(false)
    db.close()
  })

  it('reports how many events-only blocks were discarded', () => {
    const db = migratedDb()
    block(db, 'b1', 1)
    block(db, 'b2', 1)
    block(db, 'b3', 0)
    expect(rollbackV95(db).discarded).toEqual({ eventsOnlyBlocks: 2 })
    db.close()
  })

  it('clears version 95 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (96, ?)').run(new Date().toISOString())
    rollbackV95(db)
    expect(getSchemaVersion(db)).toBe(94)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    rollbackV95(db)
    expect(rollbackV95(db).discarded).toEqual({ eventsOnlyBlocks: 0 })
    db.close()
  })

  it('lets initSchema re-add the column, all schedulable', () => {
    const db = migratedDb()
    block(db, 'b1', 1)
    rollbackV95(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasColumn(db, 'time_blocks', 'events_only')).toBe(true)
    expect(db.prepare('SELECT events_only FROM time_blocks WHERE id = ?').get('b1').events_only).toBe(0)
    db.close()
  }, 30000)
})
