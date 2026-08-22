// @vitest-environment node
//
// Migration v38 — day_overrides re-point (T108, ADR
// docs/adr/2026-08-21-day-overrides-repoint-shape.md D1/D4, design
// docs/work/specs/2026-08-21-day-overrides-repoint-design.md). Two additive
// changes:
//   1. New table `day_overrides`, keyed (schedule_week_id, day_id, group_id,
//      time_block_id), UNIQUE on that tuple.
//   2. `schedule_snapshots.day_overrides_json TEXT` — the snapshot payload
//      column for whole-week override capture (design §5.2).
// No backfill: every camp starts with zero day_overrides rows, and every
// existing snapshot gets NULL day_overrides_json. Mirrors
// specialDays.migration.test.js's fresh-vs-migrated shape (new table) plus
// specialDaysNotes.migration.test.js's shape (ALTER-added column).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV38 } from './rollback/v38_down.js'

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
  return openLocalDb(tmpFile('v38-fresh'))
}

// A database migrated fully forward, then rolled back to the v37 shape (no
// day_overrides table, no schedule_snapshots.day_overrides_json column), so
// v38 can be exercised against it.
function preV38Db(tag = 'v38-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS day_overrides')
  db.exec('ALTER TABLE schedule_snapshots RENAME TO schedule_snapshots_tmp')
  db.exec(`CREATE TABLE schedule_snapshots (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES schedule_templates(id),
    name TEXT,
    is_auto INTEGER,
    created_at TEXT NOT NULL,
    slots TEXT,
    overlays TEXT
  )`)
  db.exec(`INSERT INTO schedule_snapshots (id, template_id, name, is_auto, created_at, slots, overlays)
    SELECT id, template_id, name, is_auto, created_at, slots, overlays FROM schedule_snapshots_tmp`)
  db.exec('DROP TABLE schedule_snapshots_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 38').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v38: fresh vs migrated equivalence', () => {
  it('declares schema version 38 on a fresh db, creates day_overrides, and adds schedule_snapshots.day_overrides_json', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 38').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM day_overrides').get().c).toBe(0)
    expect(db.pragma('table_info(schedule_snapshots)').map((c) => c.name)).toContain('day_overrides_json')
    db.close()
  })

  it('migrates a pre-v38 db forward to 38', () => {
    const db = preV38Db()
    expect(getSchemaVersion(db)).toBe(37)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical day_overrides columns and DDL', () => {
    const fresh = freshDb()
    const migrated = preV38Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'day_overrides')).toEqual(tableInfo(fresh, 'day_overrides'))
    const tableSql = (db, table) =>
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql
    expect(tableSql(migrated, 'day_overrides')).toBe(tableSql(fresh, 'day_overrides'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated identical schedule_snapshots columns', () => {
    // ALTER-added column: use table_info (not raw sqlite_master DDL text),
    // matching specialDaysNotes.migration.test.js's discipline.
    const fresh = freshDb()
    const migrated = preV38Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'schedule_snapshots')).toEqual(tableInfo(fresh, 'schedule_snapshots'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares day_overrides columns in the ADR-specified order', () => {
    const db = freshDb()
    expect(db.pragma('table_info(day_overrides)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'schedule_week_id', 'day_id', 'group_id', 'time_block_id',
      'activity_id', 'kind', 'note', 'created_at',
    ])
    db.close()
  })

  it('declares schedule_snapshots columns in order, day_overrides_json last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(schedule_snapshots)').map((c) => c.name)).toEqual([
      'id', 'template_id', 'name', 'is_auto', 'created_at', 'slots', 'overlays', 'day_overrides_json',
    ])
    db.close()
  })

  it('enforces UNIQUE(schedule_week_id, day_id, group_id, time_block_id) on day_overrides', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('week1', 'camp1', 'Week 1')").run()
    db.prepare("INSERT INTO days_of_operation (id, camp_id, label) VALUES ('day1', 'camp1', 'Monday')").run()
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('grp1', 'camp1', 'Bunk 1')").run()
    db.prepare(
      "INSERT INTO day_overrides (id, camp_id, schedule_week_id, day_id, group_id, time_block_id, kind) VALUES ('ov1', 'camp1', 'week1', 'day1', 'grp1', 'block1', 'swap')"
    ).run()
    expect(() =>
      db.prepare(
        "INSERT INTO day_overrides (id, camp_id, schedule_week_id, day_id, group_id, time_block_id, kind) VALUES ('ov2', 'camp1', 'week1', 'day1', 'grp1', 'block1', 'pull')"
      ).run()
    ).toThrow(/UNIQUE/)
    db.close()
  })

  it('kind defaults to swap when omitted', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('week1', 'camp1', 'Week 1')").run()
    db.prepare("INSERT INTO days_of_operation (id, camp_id, label) VALUES ('day1', 'camp1', 'Monday')").run()
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('grp1', 'camp1', 'Bunk 1')").run()
    db.prepare(
      "INSERT INTO day_overrides (id, camp_id, schedule_week_id, day_id, group_id, time_block_id) VALUES ('ov1', 'camp1', 'week1', 'day1', 'grp1', 'block1')"
    ).run()
    expect(db.prepare("SELECT kind FROM day_overrides WHERE id = 'ov1'").get().kind).toBe('swap')
    db.close()
  })

  it('every existing snapshot gets NULL day_overrides_json — no backfill needed', () => {
    const db = preV38Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES ('t1', 'camp1', 'Manual', 'manual')").run()
    db.prepare(
      "INSERT INTO schedule_snapshots (id, template_id, created_at) VALUES ('snap1', 't1', '2026-01-01')"
    ).run()
    initSchema(db)
    expect(db.prepare("SELECT day_overrides_json FROM schedule_snapshots WHERE id = 'snap1'").get().day_overrides_json).toBeNull()
    // No op was written for the migration — a DDL-only change, matching v33-v37's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'day_overrides' OR (entity = 'schedule_snapshots' AND field = 'day_overrides_json')"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v38 does not duplicate the table, column, or lose data', () => {
    const db = preV38Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('week1', 'camp1', 'Week 1')").run()
    db.prepare("INSERT INTO days_of_operation (id, camp_id, label) VALUES ('day1', 'camp1', 'Monday')").run()
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('grp1', 'camp1', 'Bunk 1')").run()
    initSchema(db) // runs v38
    db.prepare(
      "INSERT INTO day_overrides (id, camp_id, schedule_week_id, day_id, group_id, time_block_id, kind) VALUES ('ov1', 'camp1', 'week1', 'day1', 'grp1', 'block1', 'swap')"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 38').run()
    initSchema(db) // re-run v38
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='day_overrides'").get().c
    ).toBe(1)
    expect(db.pragma('table_info(schedule_snapshots)').filter((c) => c.name === 'day_overrides_json')).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) c FROM day_overrides WHERE id = 'ov1'").get().c).toBe(1)
    db.close()
  })

  it('schema.sql and localDb.js DAY_OVERRIDES_DDL agree byte-for-byte', async () => {
    const localDbModule = await import('./localDb.js')
    const ddl = localDbModule.DAY_OVERRIDES_DDL
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS day_overrides \([\s\S]*?\n\);/)
    expect(match, 'expected a day_overrides CREATE TABLE block in schema.sql').toBeTruthy()
    const schemaDdl = match[0].replace(/;$/, '')
    expect(schemaDdl).toBe(ddl)
  })
})

describe('rollbackV38', () => {
  it('drops day_overrides and schedule_snapshots.day_overrides_json, reporting discarded counts', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('week1', 'camp1', 'Week 1')").run()
    db.prepare("INSERT INTO days_of_operation (id, camp_id, label) VALUES ('day1', 'camp1', 'Monday')").run()
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('grp1', 'camp1', 'Bunk 1')").run()
    db.prepare(
      "INSERT INTO day_overrides (id, camp_id, schedule_week_id, day_id, group_id, time_block_id, kind) VALUES ('ov1', 'camp1', 'week1', 'day1', 'grp1', 'block1', 'swap')"
    ).run()
    db.prepare("INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES ('t1', 'camp1', 'Manual', 'manual')").run()
    db.prepare(
      "INSERT INTO schedule_snapshots (id, template_id, created_at, day_overrides_json) VALUES ('snap1', 't1', '2026-01-01', '[]')"
    ).run()

    const result = rollbackV38(db)
    expect(result).toEqual({ dayOverrides: 1, snapshotsWithDayOverridesJson: 1 })
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='day_overrides'").get().c
    ).toBe(0)
    expect(
      db.pragma('table_info(schedule_snapshots)').some((c) => c.name === 'day_overrides_json')
    ).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 38').get().c).toBe(0)
    // The snapshot row and its other columns survive — only day_overrides_json is lost.
    expect(db.prepare("SELECT id FROM schedule_snapshots WHERE id = 'snap1'").get().id).toBe('snap1')
    db.close()
  })
})
