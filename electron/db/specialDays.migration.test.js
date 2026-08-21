// @vitest-environment node
//
// Migration v34 — special days data shape (T40 slice 1).
// docs/work/specs/2026-08-20-special-days-data-shape-design.md
//
// Same shape as campMaps.migration.test.js's fresh-vs-migrated section: no
// backfill here (every camp starts with zero special days), so this file is
// fresh-vs-migrated equivalence + an idempotency twin, not a
// backfill-correctness suite.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV34 } from './rollback/v34_down.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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

function freshDb() {
  return openLocalDb(tmpFile('v34-fresh'))
}

// A database rolled back to the v33 shape: no special_days/special_day_time_blocks/
// special_day_slots tables, so v34 can be exercised against it.
function preV34Db(tag = 'v34-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS special_day_slots')
  db.exec('DROP TABLE IF EXISTS special_day_time_blocks')
  db.exec('DROP TABLE IF EXISTS special_days')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 34').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql

describe('migration v34: fresh vs migrated equivalence', () => {
  it('creates the three tables on a fresh db and declares schema version 34', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 34').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM special_days').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM special_day_time_blocks').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM special_day_slots').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v34 db forward to 34', () => {
    const db = preV34Db()
    expect(getSchemaVersion(db)).toBe(33)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical columns and DDL for all three tables', () => {
    const fresh = freshDb()
    const migrated = preV34Db()
    initSchema(migrated)

    for (const table of ['special_days', 'special_day_time_blocks', 'special_day_slots']) {
      expect(tableInfo(migrated, table)).toEqual(tableInfo(fresh, table))
      // sqlite_master stores the original CREATE TABLE text — the only check
      // that catches a byte-level drift between schema.sql and localDb.js.
      expect(tableSql(migrated, table)).toBe(tableSql(fresh, table))
    }
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares every column from the CREATE TABLE for each table — no ALTER-added column, no column-order trap', () => {
    const db = freshDb()
    expect(db.pragma('table_info(special_days)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'sort_order', 'notes',
    ])
    expect(db.pragma('table_info(special_day_time_blocks)').map((c) => c.name)).toEqual([
      'id', 'special_day_id', 'name', 'sort_order', 'start_time', 'end_time',
    ])
    expect(db.pragma('table_info(special_day_slots)').map((c) => c.name)).toEqual([
      'id', 'special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id',
    ])
    db.close()
  })

  it('gives fresh and migrated the same whole table set', () => {
    const fresh = freshDb()
    const migrated = preV34Db()
    initSchema(migrated)
    const tables = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    expect(tables(migrated)).toEqual(tables(fresh))
    expect(tables(fresh)).toEqual(
      expect.arrayContaining(['special_days', 'special_day_time_blocks', 'special_day_slots'])
    )
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v34 does not duplicate any table or rows', () => {
    const db = preV34Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    initSchema(db) // runs v34
    db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd1', 'camp1', 'Among Us')").run()
    const firstCount = db.prepare('SELECT COUNT(*) c FROM special_days').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 34').run()
    initSchema(db) // re-run v34
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM special_days').get().c).toBe(firstCount)
    for (const table of ['special_days', 'special_day_time_blocks', 'special_day_slots']) {
      expect(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(table).c
      ).toBe(1)
    }
    db.close()
  })

  it('no backfill — every camp starts with zero special days', () => {
    const db = preV34Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM special_days').get().c).toBe(0)
    // No op was written for the migration — a DDL-only change.
    expect(
      db.prepare("SELECT COUNT(*) c FROM operations WHERE entity IN ('special_days','special_day_time_blocks','special_day_slots')").get().c
    ).toBe(0)
    db.close()
  })

  it('enforces UNIQUE(camp_id, name) on special_days', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd1', 'camp1', 'Among Us')").run()
    expect(() =>
      db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd2', 'camp1', 'Among Us')").run()
    ).toThrow(/UNIQUE/)
    db.close()
  })

  for (const [table, schemaConst] of [
    ['special_days', 'SPECIAL_DAYS_DDL'],
    ['special_day_time_blocks', 'SPECIAL_DAY_TIME_BLOCKS_DDL'],
    ['special_day_slots', 'SPECIAL_DAY_SLOTS_DDL'],
  ]) {
    it(`schema.sql and localDb.js ${schemaConst} agree byte-for-byte (guarded independently of the DB check above)`, async () => {
      const localDbModule = await import('./localDb.js')
      const ddl = localDbModule[schemaConst]
      const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
      const match = schemaText.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`)
      )
      expect(match, `expected a ${table} CREATE TABLE block in schema.sql`).toBeTruthy()
      const schemaDdl = match[0].replace(/;$/, '')
      expect(schemaDdl).toBe(ddl)
    })
  }
})

describe('rollbackV34', () => {
  it('drops all three tables and the schema_migrations row, reporting discarded row counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd1', 'camp1', 'Among Us')").run()
    db.prepare(
      "INSERT INTO special_day_time_blocks (id, special_day_id, name, sort_order) VALUES ('tb1', 'sd1', 'Opening', 0)"
    ).run()
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('grp1', 'camp1', 'Bunk 1')").run()
    db.prepare(
      'INSERT INTO special_day_slots (id, special_day_id, group_id, time_block_id) VALUES (?, ?, ?, ?)'
    ).run('sl1', 'sd1', 'grp1', 'tb1')

    const result = rollbackV34(db)
    expect(result).toEqual({ specialDays: 1, specialDayTimeBlocks: 1, specialDaySlots: 1 })
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='special_days'").get().c
    ).toBe(0)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='special_day_time_blocks'").get().c
    ).toBe(0)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='special_day_slots'").get().c
    ).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 34').get().c).toBe(0)
    db.close()
  })
})
