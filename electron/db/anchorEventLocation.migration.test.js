// @vitest-environment node
//
// Migration v45 — Slice 4 engine location-contention prerequisite
// (docs/work/specs/2026-08-23-slice4-engine-location-contention.md §1/§6).
// Adds TWO additive, nullable columns in one migration version:
// anchor_activities.location_id and events.location_id, both FK-by-
// convention to locations(id) (no DB-level FOREIGN KEY), matching
// activities.location_id exactly. NULL = unconstrained, identical to
// today's behavior. Storage + projection only in this slice — no engine
// use (that's Slice 4b), no writer, no UI. Mirrors
// electron/db/recurrenceTruthStatus.migration.test.js's fresh-vs-migrated
// shape for a single-version, two-table additive change.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV45 } from './rollback/v45_down.js'

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
  return openLocalDb(tmpFile('v45-fresh'))
}

// A database migrated fully forward, then rolled back to the v44 shape (no
// anchor_activities.location_id / events.location_id columns), so v45 can
// be exercised against it.
function preV45Db(tag = 'v45-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')

  db.exec('ALTER TABLE anchor_activities RENAME TO anchor_activities_tmp')
  db.exec(`CREATE TABLE anchor_activities (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    cohort_id TEXT REFERENCES cohorts(id),
    day_id TEXT REFERENCES days_of_operation(id),
    time_block_id TEXT,
    name TEXT,
    unit_id TEXT,
    span_blocks INTEGER,
    is_all_groups INTEGER,
    group_ids TEXT,
    notes TEXT,
    schedule_week_id TEXT REFERENCES schedule_weeks(id),
    recurrence_level TEXT NOT NULL DEFAULT 'daily'
  )`)
  db.exec(`INSERT INTO anchor_activities
    (id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks, is_all_groups, group_ids, notes, schedule_week_id, recurrence_level)
    SELECT id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks, is_all_groups, group_ids, notes, schedule_week_id, recurrence_level
    FROM anchor_activities_tmp`)
  db.exec('DROP TABLE anchor_activities_tmp')

  db.exec('ALTER TABLE events RENAME TO events_tmp')
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    name TEXT NOT NULL,
    sort_order INTEGER,
    notes TEXT,
    UNIQUE(camp_id, name)
  )`)
  db.exec(`INSERT INTO events (id, camp_id, name, sort_order, notes)
    SELECT id, camp_id, name, sort_order, notes FROM events_tmp`)
  db.exec('DROP TABLE events_tmp')

  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 45').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v45: fresh vs migrated equivalence', () => {
  it('declares schema version 45 on a fresh db and gives both tables the location_id column', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(46)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 45').get().c).toBe(1)
    expect(db.pragma('table_info(anchor_activities)').map((c) => c.name)).toContain('location_id')
    expect(db.pragma('table_info(events)').map((c) => c.name)).toContain('location_id')
    db.close()
  })

  it('migrates a pre-v45 db forward to 45', () => {
    const db = preV45Db()
    expect(getSchemaVersion(db)).toBe(44)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical anchor_activities columns', () => {
    const fresh = freshDb()
    const migrated = preV45Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'anchor_activities')).toEqual(tableInfo(fresh, 'anchor_activities'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated identical events columns', () => {
    const fresh = freshDb()
    const migrated = preV45Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'events')).toEqual(tableInfo(fresh, 'events'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares anchor_activities columns in order, location_id appended last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(anchor_activities)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'unit_id', 'span_blocks',
      'is_all_groups', 'group_ids', 'notes', 'schedule_week_id', 'recurrence_level', 'location_id',
    ])
    db.close()
  })

  it('declares events columns in order, location_id appended last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(events)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'sort_order', 'notes', 'location_id',
    ])
    db.close()
  })

  it('no backfill logic — every existing anchor and event stays NULL, and no op is written', () => {
    const db = preV45Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Lunch')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev1', 'camp1', 'Color War')").run()
    initSchema(db)
    expect(db.prepare('SELECT location_id FROM anchor_activities WHERE id = ?').get('a1').location_id).toBeNull()
    expect(db.prepare('SELECT location_id FROM events WHERE id = ?').get('ev1').location_id).toBeNull()
    // No op was written for the migration — a DDL-only change, matching v33-v44's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE (entity = 'anchor_activities' OR entity = 'events') AND field = 'location_id'"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v45 does not duplicate either column or lose data', () => {
    const db = preV45Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('loc1', 'camp1', 'Dining Hall')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Lunch')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev1', 'camp1', 'Color War')").run()
    initSchema(db) // runs v45
    db.prepare("UPDATE anchor_activities SET location_id = 'loc1' WHERE id = 'a1'").run()
    db.prepare("UPDATE events SET location_id = 'loc1' WHERE id = 'ev1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 45').run()
    initSchema(db) // re-run v45
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(anchor_activities)').filter((c) => c.name === 'location_id')).toHaveLength(1)
    expect(db.pragma('table_info(events)').filter((c) => c.name === 'location_id')).toHaveLength(1)
    // Re-running the migration must not clobber a value already set.
    expect(db.prepare("SELECT location_id FROM anchor_activities WHERE id = 'a1'").get().location_id).toBe('loc1')
    expect(db.prepare("SELECT location_id FROM events WHERE id = 'ev1'").get().location_id).toBe('loc1')
    db.close()
  })

  it('schema.sql declares location_id last in the anchor_activities CREATE block', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS anchor_activities \([\s\S]*?\n\);/)
    expect(match, 'expected an anchor_activities CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain("recurrence_level TEXT NOT NULL DEFAULT 'daily',\n  location_id TEXT\n);")
  })

  it('schema.sql declares location_id last (before UNIQUE) in the events CREATE block', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS events \([\s\S]*?\n\);/)
    expect(match, 'expected an events CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain('notes TEXT,\n  location_id TEXT,\n  UNIQUE(camp_id, name)\n);')
  })
})

describe('rollbackV45', () => {
  it('drops both new columns and the schema_migrations row, reporting discarded row counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('loc1', 'camp1', 'Dining Hall')").run()
    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, location_id) VALUES ('a1', 'camp1', 'Lunch', 'loc1')"
    ).run()
    db.prepare(
      "INSERT INTO events (id, camp_id, name, location_id) VALUES ('ev1', 'camp1', 'Color War', 'loc1')"
    ).run()

    const result = rollbackV45(db)
    expect(result).toEqual({ anchorLocationId: 1, eventLocationId: 1 })
    expect(db.pragma('table_info(anchor_activities)').map((c) => c.name)).not.toContain('location_id')
    expect(db.pragma('table_info(events)').map((c) => c.name)).not.toContain('location_id')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 45').get().c).toBe(0)
    // The rows themselves and every other column survive — only location_id is lost.
    expect(db.prepare("SELECT name FROM anchor_activities WHERE id = 'a1'").get().name).toBe('Lunch')
    expect(db.prepare("SELECT name FROM events WHERE id = 'ev1'").get().name).toBe('Color War')
    db.close()
  })
})
