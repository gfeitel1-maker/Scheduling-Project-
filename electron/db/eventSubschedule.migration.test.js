// @vitest-environment node
//
// Migration v41 — event internal sub-schedule (Slice 2).
// docs/adr/2026-08-22-event-internal-subschedule.md
//
// Same shape as specialDays.migration.test.js: no backfill here (every
// event starts with zero time blocks / zero groups / zero slots), so this
// file is fresh-vs-migrated equivalence + an idempotency twin, not a
// backfill-correctness suite.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV41 } from './rollback/v41_down.js'

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
  return openLocalDb(tmpFile('v41-fresh'))
}

// A database rolled back to the v40 shape: no event_time_blocks/event_groups/
// event_slots tables, so v41 can be exercised against it.
function preV41Db(tag = 'v41-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS event_slots')
  db.exec('DROP TABLE IF EXISTS event_time_blocks')
  db.exec('DROP TABLE IF EXISTS event_groups')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 41').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql

describe('migration v41: fresh vs migrated equivalence', () => {
  it('creates the three tables on a fresh db and declares schema version 41', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 41').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM event_time_blocks').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM event_groups').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM event_slots').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v41 db forward to 41', () => {
    const db = preV41Db()
    expect(getSchemaVersion(db)).toBe(40)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical columns and DDL for all three tables', () => {
    const fresh = freshDb()
    const migrated = preV41Db()
    initSchema(migrated)

    for (const table of ['event_time_blocks', 'event_groups', 'event_slots']) {
      expect(tableInfo(migrated, table)).toEqual(tableInfo(fresh, table))
      // sqlite_master stores the original CREATE TABLE text — the only check
      // that catches a byte-level drift between schema.sql and localDb.js.
      expect(tableSql(migrated, table)).toBe(tableSql(fresh, table))
    }
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares every column from the CREATE TABLE for each table', () => {
    const db = freshDb()
    expect(db.pragma('table_info(event_time_blocks)').map((c) => c.name)).toEqual([
      'id', 'event_id', 'name', 'sort_order', 'start_time', 'end_time',
    ])
    expect(db.pragma('table_info(event_groups)').map((c) => c.name)).toEqual([
      'id', 'event_id', 'name', 'sort_order',
    ])
    expect(db.pragma('table_info(event_slots)').map((c) => c.name)).toEqual([
      'id', 'event_id', 'event_group_id', 'time_block_id', 'activity_id', 'location_id',
    ])
    db.close()
  })

  it('gives fresh and migrated the same whole table set', () => {
    const fresh = freshDb()
    const migrated = preV41Db()
    initSchema(migrated)
    const tables = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    expect(tables(migrated)).toEqual(tables(fresh))
    expect(tables(fresh)).toEqual(
      expect.arrayContaining(['event_time_blocks', 'event_groups', 'event_slots'])
    )
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v41 does not duplicate any table or rows', () => {
    const db = preV41Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('evt1', 'camp1', 'Color War')").run()
    initSchema(db) // runs v41
    db.prepare(
      "INSERT INTO event_time_blocks (id, event_id, name, sort_order) VALUES ('tb1', 'evt1', 'Station 1', 0)"
    ).run()
    const firstCount = db.prepare('SELECT COUNT(*) c FROM event_time_blocks').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 41').run()
    initSchema(db) // re-run v41
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM event_time_blocks').get().c).toBe(firstCount)
    for (const table of ['event_time_blocks', 'event_groups', 'event_slots']) {
      expect(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(table).c
      ).toBe(1)
    }
    db.close()
  })

  it('no backfill — every event starts with zero time blocks, zero groups, zero slots', () => {
    const db = preV41Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('evt1', 'camp1', 'Color War')").run()
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM event_time_blocks').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM event_groups').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM event_slots').get().c).toBe(0)
    // No op was written for the migration — a DDL-only change.
    expect(
      db.prepare("SELECT COUNT(*) c FROM operations WHERE entity IN ('event_time_blocks','event_groups','event_slots')").get().c
    ).toBe(0)
    db.close()
  })

  for (const [table, schemaConst] of [
    ['event_time_blocks', 'EVENT_TIME_BLOCKS_DDL'],
    ['event_groups', 'EVENT_GROUPS_DDL'],
    ['event_slots', 'EVENT_SLOTS_DDL'],
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

describe('rollbackV41', () => {
  it('drops all three tables and the schema_migrations row, reporting discarded row counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('evt1', 'camp1', 'Color War')").run()
    db.prepare(
      "INSERT INTO event_time_blocks (id, event_id, name, sort_order) VALUES ('tb1', 'evt1', 'Station 1', 0)"
    ).run()
    db.prepare(
      "INSERT INTO event_groups (id, event_id, name, sort_order) VALUES ('eg1', 'evt1', 'Blue Team', 0)"
    ).run()
    db.prepare(
      'INSERT INTO event_slots (id, event_id, event_group_id, time_block_id) VALUES (?, ?, ?, ?)'
    ).run('sl1', 'evt1', 'eg1', 'tb1')

    const result = rollbackV41(db)
    expect(result).toEqual({ eventSlots: 1, eventTimeBlocks: 1, eventGroups: 1 })
    for (const table of ['event_slots', 'event_time_blocks', 'event_groups']) {
      expect(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(table).c
      ).toBe(0)
    }
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 41').get().c).toBe(0)
    db.close()
  })
})
