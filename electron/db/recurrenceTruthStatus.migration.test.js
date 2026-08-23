// @vitest-environment node
//
// Migration v44 — truth-status x binding-vector activity ontology
// (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md §3.2/§3.5).
// Adds ONE additive, nullable column to activities: recurrence_truth_status
// ('asserted' | 'obligation' | 'permission' | NULL). NULL = not-yet-
// classified/mixed; no backfill. Storage + projection only in this slice —
// no writer, no engine use, no UI. Mirrors
// electron/db/electiveSetsBinding.migration.test.js's fresh-vs-migrated shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV44 } from './rollback/v44_down.js'

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
  return openLocalDb(tmpFile('v44-fresh'))
}

// A database migrated fully forward, then rolled back to the v43 shape (no
// recurrence_truth_status column), so v44 can be exercised against it.
function preV44Db(tag = 'v44-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE activities RENAME TO activities_tmp')
  db.exec(`CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    name TEXT NOT NULL,
    priority INTEGER,
    is_locked INTEGER,
    span_blocks INTEGER,
    location TEXT,
    is_outdoor INTEGER,
    max_groups_per_slot INTEGER,
    min_per_week INTEGER,
    max_per_week INTEGER,
    same_tier_only INTEGER,
    eligible_tier_ids TEXT,
    eligible_group_ids TEXT,
    prefer_before_day INTEGER,
    prefer_before_day_min INTEGER,
    weather_alternative_id TEXT,
    notes TEXT,
    location_id TEXT,
    UNIQUE(camp_id, name)
  )`)
  db.exec(`INSERT INTO activities
    (id, camp_id, name, priority, is_locked, span_blocks, location, is_outdoor,
     max_groups_per_slot, min_per_week, max_per_week, same_tier_only, eligible_tier_ids,
     eligible_group_ids, prefer_before_day, prefer_before_day_min, weather_alternative_id,
     notes, location_id)
    SELECT id, camp_id, name, priority, is_locked, span_blocks, location, is_outdoor,
     max_groups_per_slot, min_per_week, max_per_week, same_tier_only, eligible_tier_ids,
     eligible_group_ids, prefer_before_day, prefer_before_day_min, weather_alternative_id,
     notes, location_id
    FROM activities_tmp`)
  db.exec('DROP TABLE activities_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 44').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v44: fresh vs migrated equivalence', () => {
  it('declares schema version 44 on a fresh db and gives activities the recurrence_truth_status column', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(44)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 44').get().c).toBe(1)
    const cols = db.pragma('table_info(activities)').map((c) => c.name)
    expect(cols).toContain('recurrence_truth_status')
    db.close()
  })

  it('migrates a pre-v44 db forward to 44', () => {
    const db = preV44Db()
    expect(getSchemaVersion(db)).toBe(43)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical activities columns', () => {
    const fresh = freshDb()
    const migrated = preV44Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'activities')).toEqual(tableInfo(fresh, 'activities'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares activities columns in order, recurrence_truth_status appended last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(activities)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'priority', 'is_locked', 'span_blocks', 'location', 'is_outdoor',
      'max_groups_per_slot', 'min_per_week', 'max_per_week', 'same_tier_only', 'eligible_tier_ids',
      'eligible_group_ids', 'prefer_before_day', 'prefer_before_day_min', 'weather_alternative_id',
      'notes', 'location_id', 'recurrence_truth_status',
    ])
    db.close()
  })

  it('no backfill logic — every existing activity stays NULL, and no op is written', () => {
    const db = preV44Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Swim')").run()
    initSchema(db)
    const row = db.prepare('SELECT recurrence_truth_status FROM activities WHERE id = ?').get('a1')
    expect(row.recurrence_truth_status).toBeNull()
    // No op was written for the migration — a DDL-only change, matching v33-v43's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'activities' AND field = 'recurrence_truth_status'"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v44 does not duplicate the column or lose data', () => {
    const db = preV44Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Swim')").run()
    initSchema(db) // runs v44
    db.prepare("UPDATE activities SET recurrence_truth_status = 'obligation' WHERE id = 'a1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 44').run()
    initSchema(db) // re-run v44
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(activities)').filter((c) => c.name === 'recurrence_truth_status')).toHaveLength(1)
    // Re-running the migration must not clobber a value already set.
    const row = db.prepare('SELECT recurrence_truth_status FROM activities WHERE id = ?').get('a1')
    expect(row.recurrence_truth_status).toBe('obligation')
    db.close()
  })

  it('schema.sql declares recurrence_truth_status last in the activities CREATE block', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS activities \([\s\S]*?\n\);/)
    expect(match, 'expected an activities CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain('recurrence_truth_status TEXT,\n  UNIQUE(camp_id, name)\n);')
  })
})

describe('rollbackV44', () => {
  it('drops the new column and the schema_migrations row, reporting the discarded row count', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO activities (id, camp_id, name, recurrence_truth_status) VALUES ('a1', 'camp1', 'Swim', 'asserted')"
    ).run()

    const result = rollbackV44(db)
    expect(result).toEqual({ recurrenceTruthStatus: 1 })
    const cols = db.pragma('table_info(activities)').map((c) => c.name)
    expect(cols).not.toContain('recurrence_truth_status')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 44').get().c).toBe(0)
    // The row itself and every other column survive — only the new column is lost.
    expect(db.prepare("SELECT name FROM activities WHERE id = 'a1'").get().name).toBe('Swim')
    db.close()
  })
})
