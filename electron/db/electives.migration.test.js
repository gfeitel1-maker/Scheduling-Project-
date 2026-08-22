// @vitest-environment node
//
// Migration v35 — group-level electives data shape (T41 slice 1).
// docs/work/specs/2026-08-20-group-electives-design.md
//
// Unlike v34 (three brand-new tables), v35 ALSO extends the EXISTING
// template_slots table with a nullable elective_set_id column, so this file
// covers both: the two new tables (fresh-vs-migrated equivalence, no
// backfill) AND the ALTER-added column on template_slots.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV35 } from './rollback/v35_down.js'

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
  return openLocalDb(tmpFile('v35-fresh'))
}

// A database rolled back to the v34 shape: no elective_sets/
// elective_set_activities tables and no template_slots.elective_set_id
// column, so v35 can be exercised against it.
function preV35Db(tag = 'v35-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS elective_set_activities')
  db.exec('DROP TABLE IF EXISTS elective_sets')
  // Recreate template_slots without elective_set_id (SQLite has no DROP-safe
  // in-place column removal pre-3.35 rebuild style; use the RENAME dance the
  // repo's own migration tests already use for this table).
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
    is_anchor INTEGER
  )`)
  db.exec(`INSERT INTO template_slots
    (id, template_id, group_id, activity_id, day_id, time_block_id, flags, is_released, is_span_head, anchor_id, is_anchor)
    SELECT id, template_id, group_id, activity_id, day_id, time_block_id, flags, is_released, is_span_head, anchor_id, is_anchor
    FROM template_slots_tmp`)
  db.exec('DROP TABLE template_slots_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 35').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql

describe('migration v35: fresh vs migrated equivalence', () => {
  it('creates the two elective tables and the template_slots column on a fresh db, declares schema version 35', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 35').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities').get().c).toBe(0)
    expect(db.pragma('table_info(template_slots)').map((c) => c.name)).toContain('elective_set_id')
    db.close()
  })

  it('migrates a pre-v35 db forward to 35', () => {
    const db = preV35Db()
    expect(getSchemaVersion(db)).toBe(34)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical columns and DDL for both new tables', () => {
    const fresh = freshDb()
    const migrated = preV35Db()
    initSchema(migrated)

    for (const table of ['elective_sets', 'elective_set_activities']) {
      expect(tableInfo(migrated, table)).toEqual(tableInfo(fresh, table))
      expect(tableSql(migrated, table)).toBe(tableSql(fresh, table))
    }
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated the same template_slots column set', () => {
    const fresh = freshDb()
    const migrated = preV35Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'template_slots').map((c) => c.name)).toEqual(
      tableInfo(fresh, 'template_slots').map((c) => c.name)
    )
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares every column for elective_sets and elective_set_activities — no column-order trap', () => {
    const db = freshDb()
    // is_reusable arrived in v36 (docs/adr/2026-08-20-electives-authoring.md
    // D2, electron/db/electivesDurability.migration.test.js) — this v35 test
    // runs against the CURRENT schema (freshDb migrates all the way up), so
    // it must expect the column too.
    expect(db.pragma('table_info(elective_sets)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'sort_order', 'is_reusable',
    ])
    // camper_headcount arrived in v39 (Electives Slice 1,
    // docs/work/specs/2026-08-22-electives-nested-schedule-slices.md) — this
    // v35 test runs against the CURRENT schema too, so it must expect it.
    expect(db.pragma('table_info(elective_set_activities)').map((c) => c.name)).toEqual([
      'id', 'elective_set_id', 'activity_id', 'camper_headcount',
    ])
    db.close()
  })

  it('template_slots gains elective_set_id as its 11th column', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(template_slots)').map((c) => c.name)
    expect(cols).toEqual([
      'id', 'template_id', 'group_id', 'activity_id', 'day_id', 'time_block_id',
      'flags', 'is_released', 'is_span_head', 'anchor_id', 'is_anchor', 'elective_set_id',
    ])
    db.close()
  })

  it('gives fresh and migrated the same whole table set', () => {
    const fresh = freshDb()
    const migrated = preV35Db()
    initSchema(migrated)
    const tables = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    expect(tables(migrated)).toEqual(tables(fresh))
    expect(tables(fresh)).toEqual(
      expect.arrayContaining(['elective_sets', 'elective_set_activities'])
    )
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v35 does not duplicate any table, column, or rows', () => {
    const db = preV35Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    initSchema(db) // runs v35
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Chugim')").run()
    const firstCount = db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 35').run()
    initSchema(db) // re-run v35
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(firstCount)
    for (const table of ['elective_sets', 'elective_set_activities']) {
      expect(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(table).c
      ).toBe(1)
    }
    expect(
      db.pragma('table_info(template_slots)').filter((c) => c.name === 'elective_set_id')
    ).toHaveLength(1)
    db.close()
  })

  it('no backfill — every camp starts with zero elective sets, every existing slot keeps elective_set_id NULL', () => {
    const db = preV35Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO template_slots (id, template_id) VALUES ('ts1', 'tpl1')"
    ).run()
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(0)
    expect(db.prepare("SELECT elective_set_id FROM template_slots WHERE id = 'ts1'").get().elective_set_id).toBeNull()
    // No op was written for the migration — a DDL-only change.
    expect(
      db.prepare("SELECT COUNT(*) c FROM operations WHERE entity IN ('elective_sets','elective_set_activities')").get().c
    ).toBe(0)
    db.close()
  })

  it('enforces UNIQUE(camp_id, name) on elective_sets', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Chugim')").run()
    expect(() =>
      db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es2', 'camp1', 'Chugim')").run()
    ).toThrow(/UNIQUE/)
    db.close()
  })

  it('enforces UNIQUE(elective_set_id, activity_id) on elective_set_activities', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Chugim')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act1', 'camp1', 'Swim')").run()
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('esa1', 'es1', 'act1')"
    ).run()
    expect(() =>
      db.prepare(
        "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('esa2', 'es1', 'act1')"
      ).run()
    ).toThrow(/UNIQUE/)
    db.close()
  })

  for (const [table, schemaConst] of [
    ['elective_sets', 'ELECTIVE_SETS_DDL'],
    ['elective_set_activities', 'ELECTIVE_SET_ACTIVITIES_DDL'],
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

describe('rollbackV35', () => {
  it('drops both elective tables, removes template_slots.elective_set_id, and the schema_migrations row, reporting discarded row counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Chugim')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act1', 'camp1', 'Swim')").run()
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('esa1', 'es1', 'act1')"
    ).run()
    db.prepare(
      "INSERT INTO template_slots (id, template_id, elective_set_id) VALUES ('ts1', 'tpl1', 'es1')"
    ).run()

    const result = rollbackV35(db)
    expect(result).toEqual({ electiveSets: 1, electiveSetActivities: 1, electiveSlots: 1 })
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='elective_sets'").get().c
    ).toBe(0)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='elective_set_activities'").get().c
    ).toBe(0)
    expect(
      db.pragma('table_info(template_slots)').some((c) => c.name === 'elective_set_id')
    ).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 35').get().c).toBe(0)
    db.close()
  })
})
