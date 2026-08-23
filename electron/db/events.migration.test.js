// @vitest-environment node
//
// Migration v40 — events overlay placement (Slice 1).
// docs/adr/2026-08-22-events-overlay-placement.md
// docs/work/specs/2026-08-22-events-overlay-slices.md
//
// Mirrors electives.migration.test.js's structure: one new table (events)
// PLUS an ALTER-added nullable column on the existing template_slots table
// (event_id), fresh-vs-migrated equivalence, no backfill.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV40 } from './rollback/v40_down.js'

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
  return openLocalDb(tmpFile('v40-fresh'))
}

// A database rolled back to the pre-v40 shape: no events table and no
// template_slots.event_id column, so v40 can be exercised against it.
function preV40Db(tag = 'v40-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS events')
  const cols = db.pragma('table_info(template_slots)').map((c) => c.name)
  const keep = cols.filter((c) => c !== 'event_id')
  db.exec('ALTER TABLE template_slots RENAME TO template_slots_tmp')
  db.exec(`CREATE TABLE template_slots (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    group_id TEXT REFERENCES groups(id),
    activity_id TEXT REFERENCES activities(id),
    day_id TEXT,
    time_block_id TEXT,
    flags TEXT,
    is_released INTEGER,
    is_span_head INTEGER,
    anchor_id TEXT,
    is_anchor INTEGER,
    elective_set_id TEXT
  )`)
  db.exec(`INSERT INTO template_slots (${keep.join(', ')})
    SELECT ${keep.join(', ')} FROM template_slots_tmp`)
  db.exec('DROP TABLE template_slots_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 40').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql

describe('migration v40: fresh vs migrated equivalence', () => {
  it('creates the events table and the template_slots.event_id column on a fresh db, declares schema version 40', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(43)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 40').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(0)
    expect(db.pragma('table_info(template_slots)').map((c) => c.name)).toContain('event_id')
    db.close()
  })

  it('migrates a pre-v40 db forward to 40', () => {
    const db = preV40Db()
    expect(getSchemaVersion(db)).toBe(39)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical columns and DDL for events', () => {
    const fresh = freshDb()
    const migrated = preV40Db()
    initSchema(migrated)

    expect(tableInfo(migrated, 'events')).toEqual(tableInfo(fresh, 'events'))
    expect(tableSql(migrated, 'events')).toBe(tableSql(fresh, 'events'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated the same template_slots column set', () => {
    const fresh = freshDb()
    const migrated = preV40Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'template_slots').map((c) => c.name)).toEqual(
      tableInfo(fresh, 'template_slots').map((c) => c.name)
    )
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares every column for events — id, camp_id, name, sort_order, notes', () => {
    const db = freshDb()
    expect(db.pragma('table_info(events)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'sort_order', 'notes',
    ])
    db.close()
  })

  it('template_slots gains event_id as its 12th (new last) column', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(template_slots)').map((c) => c.name)
    expect(cols).toEqual([
      'id', 'template_id', 'group_id', 'activity_id', 'day_id', 'time_block_id',
      'flags', 'is_released', 'is_span_head', 'anchor_id', 'is_anchor', 'elective_set_id', 'event_id',
    ])
    db.close()
  })

  it('is idempotent — re-running v40 does not duplicate any table, column, or rows', () => {
    const db = preV40Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    initSchema(db) // runs v40
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev1', 'camp1', 'Color War')").run()
    const firstCount = db.prepare('SELECT COUNT(*) c FROM events').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 40').run()
    initSchema(db) // re-run v40
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(firstCount)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='events'").get().c
    ).toBe(1)
    expect(
      db.pragma('table_info(template_slots)').filter((c) => c.name === 'event_id')
    ).toHaveLength(1)
    db.close()
  })

  it('no backfill — every camp starts with zero events, every existing slot keeps event_id NULL', () => {
    const db = preV40Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO template_slots (id, template_id) VALUES ('ts1', 'tpl1')"
    ).run()
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(0)
    expect(db.prepare("SELECT event_id FROM template_slots WHERE id = 'ts1'").get().event_id).toBeNull()
    expect(
      db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'events'").get().c
    ).toBe(0)
    db.close()
  })

  it('enforces UNIQUE(camp_id, name) on events', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev1', 'camp1', 'Color War')").run()
    expect(() =>
      db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev2', 'camp1', 'Color War')").run()
    ).toThrow(/UNIQUE/)
    db.close()
  })

  it('schema.sql and localDb.js EVENTS_DDL agree byte-for-byte (guarded independently of the DB check above)', async () => {
    const localDbModule = await import('./localDb.js')
    const ddl = localDbModule.EVENTS_DDL
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS events \([\s\S]*?\n\);/)
    expect(match, 'expected an events CREATE TABLE block in schema.sql').toBeTruthy()
    const schemaDdl = match[0].replace(/;$/, '')
    expect(schemaDdl).toBe(ddl)
  })
})

describe('rollbackV40', () => {
  it('drops events, removes template_slots.event_id, and the schema_migrations row, reporting discarded row counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev1', 'camp1', 'Color War')").run()
    db.prepare(
      "INSERT INTO template_slots (id, template_id, event_id) VALUES ('ts1', 'tpl1', 'ev1')"
    ).run()

    const result = rollbackV40(db)
    expect(result).toEqual({ events: 1, eventSlots: 1 })
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='events'").get().c
    ).toBe(0)
    expect(
      db.pragma('table_info(template_slots)').some((c) => c.name === 'event_id')
    ).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 40').get().c).toBe(0)
    db.close()
  })
})
