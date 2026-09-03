// @vitest-environment node
//
// Migration v43 — recurring-event binding shape on elective_sets (unified-
// schedule-overlay Slice 3a, docs/work/specs/2026-08-23-unified-schedule-
// overlay-slices.md). Adds six additive columns mirroring anchor_activities'
// binding shape exactly: day_id (nullable FK to days_of_operation),
// time_block_id (nullable, no REFERENCES clause — matches
// anchor_activities.time_block_id), is_all_groups (nullable INTEGER),
// group_ids (nullable TEXT), schedule_week_id (nullable FK to
// schedule_weeks — NULL = all weeks), recurrence_level (NOT NULL DEFAULT
// 'daily' — electives are recurring, and the DEFAULT labels every existing
// hand-filled set concretely with zero backfill logic, same rationale as
// v42's anchor_activities.recurrence_level). Storage + projection only in
// this slice: no UI, no engine use. Mirrors
// electron/db/anchorRecurrence.migration.test.js's fresh-vs-migrated shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV43 } from './rollback/v43_down.js'

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
  return openLocalDb(tmpFile('v43-fresh'))
}

// A database migrated fully forward, then rolled back to the v42 shape (no
// elective_sets binding columns), so v43 can be exercised against it.
function preV43Db(tag = 'v43-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE elective_sets RENAME TO elective_sets_tmp')
  db.exec(`CREATE TABLE elective_sets (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    name TEXT NOT NULL,
    sort_order INTEGER,
    is_reusable INTEGER NOT NULL DEFAULT 1,
    UNIQUE(camp_id, name)
  )`)
  db.exec(`INSERT INTO elective_sets
    (id, camp_id, name, sort_order, is_reusable)
    SELECT id, camp_id, name, sort_order, is_reusable
    FROM elective_sets_tmp`)
  db.exec('DROP TABLE elective_sets_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 43').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v43: fresh vs migrated equivalence', () => {
  it('declares schema version 43 on a fresh db and gives elective_sets all six binding columns', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(54)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 43').get().c).toBe(1)
    const cols = db.pragma('table_info(elective_sets)').map((c) => c.name)
    expect(cols).toContain('day_id')
    expect(cols).toContain('time_block_id')
    expect(cols).toContain('is_all_groups')
    expect(cols).toContain('group_ids')
    expect(cols).toContain('schedule_week_id')
    expect(cols).toContain('recurrence_level')
    db.close()
  })

  it('migrates a pre-v43 db forward to 43', () => {
    const db = preV43Db()
    expect(getSchemaVersion(db)).toBe(42)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical elective_sets columns', () => {
    const fresh = freshDb()
    const migrated = preV43Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'elective_sets')).toEqual(tableInfo(fresh, 'elective_sets'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares elective_sets columns in order, the six binding columns appended last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(elective_sets)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'sort_order', 'is_reusable',
      'day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id', 'recurrence_level',
    ])
    db.close()
  })

  it('no backfill logic — the five nullable columns stay NULL, recurrence_level reads the DEFAULT for every existing set', () => {
    const db = preV43Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Afternoon Electives')").run()
    initSchema(db)
    const row = db
      .prepare('SELECT day_id, time_block_id, is_all_groups, group_ids, schedule_week_id, recurrence_level FROM elective_sets WHERE id = ?')
      .get('es1')
    expect(row.day_id).toBeNull()
    expect(row.time_block_id).toBeNull()
    expect(row.is_all_groups).toBeNull()
    expect(row.group_ids).toBeNull()
    expect(row.schedule_week_id).toBeNull()
    expect(row.recurrence_level).toBe('daily')
    // No op was written for the migration — a DDL-only change, matching v42's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'elective_sets' AND field IN ('day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id', 'recurrence_level')"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v43 does not duplicate any column or lose data', () => {
    const db = preV43Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('wk1', 'camp1', 'Week 1')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Afternoon Electives')").run()
    initSchema(db) // runs v43
    db.prepare(
      "UPDATE elective_sets SET schedule_week_id = 'wk1', recurrence_level = 'weekly' WHERE id = 'es1'"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 43').run()
    initSchema(db) // re-run v43
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    for (const column of ['day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id', 'recurrence_level']) {
      expect(db.pragma('table_info(elective_sets)').filter((c) => c.name === column)).toHaveLength(1)
    }
    // Re-running the migration must not clobber a value already set.
    const row = db.prepare('SELECT schedule_week_id, recurrence_level FROM elective_sets WHERE id = ?').get('es1')
    expect(row.schedule_week_id).toBe('wk1')
    expect(row.recurrence_level).toBe('weekly')
    db.close()
  })

  it('schema.sql and localDb.js ELECTIVE_SETS_DDL usage agree on final column order', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS elective_sets \([\s\S]*?\n\);/)
    expect(match, 'expected an elective_sets CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain(
      "is_reusable INTEGER NOT NULL DEFAULT 1,\n  day_id TEXT REFERENCES days_of_operation(id),\n  time_block_id TEXT,\n  is_all_groups INTEGER,\n  group_ids TEXT,\n  schedule_week_id TEXT REFERENCES schedule_weeks(id),\n  recurrence_level TEXT NOT NULL DEFAULT 'daily',\n  UNIQUE(camp_id, name)\n);"
    )
  })
})

describe('rollbackV43', () => {
  it('drops all six new columns and the schema_migrations row, reporting discarded row counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('wk1', 'camp1', 'Week 1')").run()
    db.prepare(
      "INSERT INTO elective_sets (id, camp_id, name, day_id, schedule_week_id, recurrence_level) VALUES ('es1', 'camp1', 'Afternoon Electives', NULL, 'wk1', 'weekly')"
    ).run()

    const result = rollbackV43(db)
    expect(result).toEqual({
      dayId: 0, timeBlockId: 0, isAllGroups: 0, groupIds: 0, scheduleWeekId: 1, recurrenceLevel: 1,
    })
    const cols = db.pragma('table_info(elective_sets)').map((c) => c.name)
    expect(cols).not.toContain('day_id')
    expect(cols).not.toContain('time_block_id')
    expect(cols).not.toContain('is_all_groups')
    expect(cols).not.toContain('group_ids')
    expect(cols).not.toContain('schedule_week_id')
    expect(cols).not.toContain('recurrence_level')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 43').get().c).toBe(0)
    // The row itself and every other column survive — only the six columns are lost.
    expect(db.prepare("SELECT name FROM elective_sets WHERE id = 'es1'").get().name).toBe('Afternoon Electives')
    db.close()
  })
})
