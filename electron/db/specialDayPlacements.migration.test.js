// @vitest-environment node
//
// Migration v92 — special_day_placements (T350 slice 1,
// docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D1/D3). Additive table, no back-fill:
// fresh-vs-migrated equivalence, byte-identical DDL, and the rollback round trip.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION, SPECIAL_DAY_PLACEMENTS_DDL } from './localDb.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  }
})
function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

function preV92Db() {
  const db = new Database(tmpFile('v92-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE special_day_placements')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 92').run()
  return db
}

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'special_day_placements'").get()?.sql
const hasTable = (db) => tableSql(db) !== undefined

describe('migration v92: special_day_placements', () => {
  it('a fresh db has the table and declares version 92', () => {
    const db = openLocalDb(tmpFile('v92-fresh'))
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 92').get().c).toBe(1)
    expect(hasTable(db)).toBe(true)
    db.close()
  })

  it('upgrading a v91 db creates the identical table', () => {
    const fresh = openLocalDb(tmpFile('v92-fresh2'))
    const db = preV92Db()
    expect(getSchemaVersion(db)).toBe(91)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableSql(db)).toBe(tableSql(fresh))
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    fresh.close()
    db.close()
  })

  it('day_id and special_day_id are soft; week_id is a hard FK', () => {
    const db = openLocalDb(tmpFile('v92-fk'))
    db.prepare("INSERT INTO camps (id, name) VALUES ('c1', 'Camp')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('w1', 'c1', 'Week 1')").run()
    expect(() =>
      db.prepare("INSERT INTO special_day_placements (id, week_id, day_id, special_day_id) VALUES ('p1', 'w1', 'no-day', 'no-sd')").run()
    ).not.toThrow()
    expect(() =>
      db.prepare("INSERT INTO special_day_placements (id, week_id, day_id, special_day_id) VALUES ('p2', 'no-week', 'd', 's')").run()
    ).toThrow(/FOREIGN KEY/)
    db.close()
  })

  it('schema.sql and SPECIAL_DAY_PLACEMENTS_DDL agree byte-for-byte', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS special_day_placements \([\s\S]*?\n\);/)
    expect(match).toBeTruthy()
    expect(match[0].replace(/;$/, '')).toBe(SPECIAL_DAY_PLACEMENTS_DDL)
  })
})
