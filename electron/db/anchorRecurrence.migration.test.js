// @vitest-environment node
//
// Migration v42 — recurrence-axis storage on fixed_events (unified-
// schedule-overlay Slice 1, docs/work/specs/2026-08-23-unified-schedule-
// overlay-slices.md). Adds two additive columns,
// `schedule_week_id TEXT REFERENCES schedule_weeks(id)` (nullable) and
// `recurrence_level TEXT NOT NULL DEFAULT 'daily'`, to the existing
// fixed_events table (v17). schedule_week_id NULL preserves today's
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
import { rollbackV77 } from './rollback/v77_down.js'

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
// fixed_events.schedule_week_id/recurrence_level columns), so v42 can
// be exercised against it.
function preV42Db(tag = 'v42-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE fixed_events RENAME TO fixed_events_tmp')
  db.exec(`CREATE TABLE fixed_events (
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
  db.exec(`INSERT INTO fixed_events
    (id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks, is_all_groups, group_ids, notes)
    SELECT id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks, is_all_groups, group_ids, notes
    FROM fixed_events_tmp`)
  db.exec('DROP TABLE fixed_events_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 42').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v42: fresh vs migrated equivalence', () => {
  it('declares schema version 42 on a fresh db and gives fixed_events its surviving new column', () => {
    // v42 added two columns; recurrence_level (the second) was dropped in
    // v71/T181 — dead data, superseded by kind/day_id/schedule_week_id. A
    // fresh (head) db therefore carries schedule_week_id only.
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(79)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 42').get().c).toBe(1)
    const cols = db.pragma('table_info(fixed_events)').map((c) => c.name)
    expect(cols).toContain('schedule_week_id')
    expect(cols).not.toContain('recurrence_level')
    db.close()
  })

  it('migrates a pre-v42 db forward to 42', () => {
    const db = preV42Db()
    expect(getSchemaVersion(db)).toBe(41)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical fixed_events columns', () => {
    // Same rationale as electivesDurability's equivalent check: these columns
    // arrive via ALTER TABLE ADD COLUMN on the migrated path, so table_info
    // (actual column set, types, defaults) is the meaningful equivalence
    // check, not raw sqlite_master DDL text.
    const fresh = freshDb()
    const migrated = preV42Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'fixed_events')).toEqual(tableInfo(fresh, 'fixed_events'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares fixed_events columns in order, schedule_week_id before v45\'s location_id and v51\'s kind', () => {
    const db = freshDb()
    expect(db.pragma('table_info(fixed_events)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'unit_id', 'span_blocks',
      'is_all_groups', 'group_ids', 'notes', 'schedule_week_id', 'location_id', 'kind', 'unit_ids',
      'activity_id',
    ])
    db.close()
  })

  it('no backfill logic — schedule_week_id stays NULL for every existing anchor', () => {
    const db = preV42Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO fixed_events (id, camp_id, name) VALUES ('a1', 'camp1', 'Flag Raising')").run()
    initSchema(db)
    const row = db.prepare('SELECT schedule_week_id FROM fixed_events WHERE id = ?').get('a1')
    expect(row.schedule_week_id).toBeNull()
    // No op was written for the migration — a DDL-only change, matching v35/v36's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'fixed_events' AND field IN ('schedule_week_id', 'recurrence_level')"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v42 does not duplicate the column or lose data', () => {
    const db = preV42Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('wk1', 'camp1', 'Week 1')").run()
    db.prepare("INSERT INTO fixed_events (id, camp_id, name) VALUES ('a1', 'camp1', 'Flag Raising')").run()
    initSchema(db) // runs v42
    db.prepare("UPDATE fixed_events SET schedule_week_id = 'wk1' WHERE id = 'a1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 42').run()
    initSchema(db) // re-run v42
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(fixed_events)').filter((c) => c.name === 'schedule_week_id')).toHaveLength(1)
    // Re-running the migration must not clobber a value already set.
    const row = db.prepare('SELECT schedule_week_id FROM fixed_events WHERE id = ?').get('a1')
    expect(row.schedule_week_id).toBe('wk1')
    db.close()
  })

  it('schema.sql and localDb.js ANCHOR_ACTIVITIES_DDL usage agree on final column order', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS fixed_events \([\s\S]*?\n\);/)
    expect(match, 'expected an fixed_events CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain(
      "notes TEXT,\n  schedule_week_id TEXT REFERENCES schedule_weeks(id),\n  location_id TEXT,"
    )
  })
})

describe('rollbackV42', () => {
  it('drops both original columns and the schema_migrations row, reporting discarded row counts', () => {
    // recurrence_level (the second v42 column) was dropped forward in
    // v71/T181, so a head db no longer has it. Re-add it here (mirroring how
    // v42 itself added it) to exercise rollbackV42's full original behavior —
    // it still guards on column presence, so this proves that guard still
    // does the right thing against a genuine pre-v71 shape, not just a no-op.
    const db = freshDb()
    db.exec("ALTER TABLE fixed_events ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'")
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('wk1', 'camp1', 'Week 1')").run()
    db.prepare(
      "INSERT INTO fixed_events (id, camp_id, name, schedule_week_id, recurrence_level) VALUES ('a1', 'camp1', 'Flag Raising', 'wk1', 'weekly')"
    ).run()

    // v77 (T267) renamed anchor_activities -> fixed_events; rollbackV42 operates on the table's
    // pre-v77 name, so undo the rename first — the real descending-rollback order (highest version
    // first) — before exercising v42's own rollback in isolation.
    rollbackV77(db)
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
