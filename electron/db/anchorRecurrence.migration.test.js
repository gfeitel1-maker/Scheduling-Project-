// @vitest-environment node
//
// Migration v42 — recurrence-axis storage on anchor_activities (unified-
// schedule-overlay Slice 1, docs/work/specs/2026-08-23-unified-schedule-
// overlay-slices.md). Adds two additive columns,
// `schedule_week_id TEXT REFERENCES schedule_weeks(id)` (nullable) and
// `recurrence_level TEXT NOT NULL DEFAULT 'daily'`, to the existing
// anchor_activities table (v17). schedule_week_id NULL preserves today's
// implicit meaning exactly (all-weeks). recurrence_level's DEFAULT 'daily'
// labels every pre-existing anchor concretely (they ARE daily-recurring) —
// SQLite's ADD COLUMN ... NOT NULL DEFAULT populates existing rows for free,
// so this is still zero backfill logic — no behavior change for anything
// created before this migration. Storage + projection only in this slice: no
// UI, no engine use. Mirrors electron/db/electivesDurability.migration.test.js's
// fresh-vs-migrated shape for an ALTER-added column pair.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV42 } from './rollback/v42_down.js'

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
  return openLocalDb(tmpFile('v42-fresh'))
}

// A database migrated fully forward, then rolled back to the v41 shape (no
// anchor_activities.schedule_week_id/recurrence_level columns), so v42 can
// be exercised against it.
function preV42Db(tag = 'v42-migrated') {
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
    notes TEXT
  )`)
  db.exec(`INSERT INTO anchor_activities
    (id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks, is_all_groups, group_ids, notes)
    SELECT id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks, is_all_groups, group_ids, notes
    FROM anchor_activities_tmp`)
  db.exec('DROP TABLE anchor_activities_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 42').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v42: fresh vs migrated equivalence', () => {
  it('declares schema version 42 on a fresh db and gives anchor_activities both new columns', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(46)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 42').get().c).toBe(1)
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    expect(cols).toContain('schedule_week_id')
    expect(cols).toContain('recurrence_level')
    db.close()
  })

  it('migrates a pre-v42 db forward to 42', () => {
    const db = preV42Db()
    expect(getSchemaVersion(db)).toBe(41)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical anchor_activities columns', () => {
    // Same rationale as electivesDurability's equivalent check: these columns
    // arrive via ALTER TABLE ADD COLUMN on the migrated path, so table_info
    // (actual column set, types, defaults) is the meaningful equivalence
    // check, not raw sqlite_master DDL text.
    const fresh = freshDb()
    const migrated = preV42Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'anchor_activities')).toEqual(tableInfo(fresh, 'anchor_activities'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares anchor_activities columns in order, schedule_week_id and recurrence_level last (before v45\'s location_id)', () => {
    const db = freshDb()
    expect(db.pragma('table_info(anchor_activities)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'unit_id', 'span_blocks',
      'is_all_groups', 'group_ids', 'notes', 'schedule_week_id', 'recurrence_level', 'location_id',
    ])
    db.close()
  })

  it('no backfill logic — schedule_week_id stays NULL, recurrence_level reads the DEFAULT for every existing anchor', () => {
    const db = preV42Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Flag Raising')").run()
    initSchema(db)
    const row = db.prepare('SELECT schedule_week_id, recurrence_level FROM anchor_activities WHERE id = ?').get('a1')
    expect(row.schedule_week_id).toBeNull()
    expect(row.recurrence_level).toBe('daily')
    // No op was written for the migration — a DDL-only change, matching v35/v36's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'anchor_activities' AND field IN ('schedule_week_id', 'recurrence_level')"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v42 does not duplicate either column or lose data', () => {
    const db = preV42Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('wk1', 'camp1', 'Week 1')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Flag Raising')").run()
    initSchema(db) // runs v42
    db.prepare("UPDATE anchor_activities SET schedule_week_id = 'wk1', recurrence_level = 'weekly' WHERE id = 'a1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 42').run()
    initSchema(db) // re-run v42
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    for (const column of ['schedule_week_id', 'recurrence_level']) {
      expect(db.pragma('table_info(anchor_activities)').filter((c) => c.name === column)).toHaveLength(1)
    }
    // Re-running the migration must not clobber a value already set.
    const row = db.prepare('SELECT schedule_week_id, recurrence_level FROM anchor_activities WHERE id = ?').get('a1')
    expect(row.schedule_week_id).toBe('wk1')
    expect(row.recurrence_level).toBe('weekly')
    db.close()
  })

  it('schema.sql and localDb.js ANCHOR_ACTIVITIES_DDL usage agree on final column order', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS anchor_activities \([\s\S]*?\n\);/)
    expect(match, 'expected an anchor_activities CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain(
      "notes TEXT,\n  schedule_week_id TEXT REFERENCES schedule_weeks(id),\n  recurrence_level TEXT NOT NULL DEFAULT 'daily',\n  location_id TEXT\n);"
    )
  })
})

describe('rollbackV42', () => {
  it('drops both new columns and the schema_migrations row, reporting discarded row counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('wk1', 'camp1', 'Week 1')").run()
    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, schedule_week_id, recurrence_level) VALUES ('a1', 'camp1', 'Flag Raising', 'wk1', 'weekly')"
    ).run()

    const result = rollbackV42(db)
    expect(result).toEqual({ scheduleWeekId: 1, recurrenceLevel: 1 })
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    expect(cols).not.toContain('schedule_week_id')
    expect(cols).not.toContain('recurrence_level')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 42').get().c).toBe(0)
    // The row itself and every other column survive — only the two columns are lost.
    expect(db.prepare("SELECT name FROM anchor_activities WHERE id = 'a1'").get().name).toBe('Flag Raising')
    db.close()
  })
})
