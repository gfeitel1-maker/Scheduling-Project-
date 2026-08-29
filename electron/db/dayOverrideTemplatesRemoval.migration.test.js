// @vitest-environment node
//
// Migration v46 — drop the confirmed-dead day_override_templates/
// day_override_template_slots pair (docs/adr/2026-08-23-override-family-
// model.md §6a; removal trigger set by 2026-08-21-day-overrides-repoint-
// shape.md §Q3). No writer ever existed for either table — day_overrides
// (schema v38) replaced the mechanism they were built for. DDL-only, no
// backfill, no engine use — mirrors anchorEventLocation.migration.test.js's
// fresh-vs-migrated shape, but for a DROP rather than an ADD.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV46 } from './rollback/v46_down.js'

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
  return openLocalDb(tmpFile('v46-fresh'))
}

// A database migrated fully forward, then rolled back to the v45 shape (both
// dead tables present, empty — matching every real device, since nothing
// ever wrote to them), so v46 can be exercised against it.
function preV46Db(tag = 'v46-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current (tables already dropped)
  db.pragma('foreign_keys = OFF')

  db.exec(`CREATE TABLE day_override_templates (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    cohort_id TEXT REFERENCES cohorts(id),
    name TEXT NOT NULL,
    frequency_mode TEXT
  )`)
  db.exec(`CREATE TABLE day_override_template_slots (
    id TEXT PRIMARY KEY,
    day_override_template_id TEXT NOT NULL REFERENCES day_override_templates(id),
    time_block_id TEXT,
    activity_id TEXT
  )`)

  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 46').run()
  return db
}

const tableExists = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

describe('migration v46: day_override_templates/day_override_template_slots removal', () => {
  it('declares schema version 46 on a fresh db and does not create either table', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(52)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 46').get().c).toBe(1)
    expect(tableExists(db, 'day_override_templates')).toBe(false)
    expect(tableExists(db, 'day_override_template_slots')).toBe(false)
    db.close()
  })

  it('migrates a pre-v46 db forward to 46, dropping both tables', () => {
    const db = preV46Db()
    expect(getSchemaVersion(db)).toBe(45)
    expect(tableExists(db, 'day_override_templates')).toBe(true)
    expect(tableExists(db, 'day_override_template_slots')).toBe(true)

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableExists(db, 'day_override_templates')).toBe(false)
    expect(tableExists(db, 'day_override_template_slots')).toBe(false)
    db.close()
  })

  it('fresh-vs-migrated table-set equivalence — neither has the dropped pair', () => {
    const fresh = freshDb()
    const migrated = preV46Db()
    initSchema(migrated)

    const tablesOf = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)

    expect(tablesOf(migrated)).toEqual(tablesOf(fresh))
    expect(tablesOf(fresh)).not.toContain('day_override_templates')
    expect(tablesOf(fresh)).not.toContain('day_override_template_slots')
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v46 on an already-dropped db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableExists(db, 'day_override_templates')).toBe(false)
    expect(tableExists(db, 'day_override_template_slots')).toBe(false)
    db.close()
  })

  it('child dropped before parent — no FK violation even under foreign_keys=ON', () => {
    const db = preV46Db()
    // Sanity: the FK is real before the drop.
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO day_override_templates (id, camp_id, name) VALUES ('dot1', 'camp1', 'Old')").run()
    db.prepare(
      "INSERT INTO day_override_template_slots (id, day_override_template_id) VALUES ('dots1', 'dot1')"
    ).run()

    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('schema.sql no longer declares either CREATE TABLE block', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    expect(schemaText).not.toMatch(/CREATE TABLE IF NOT EXISTS day_override_templates\b/)
    expect(schemaText).not.toMatch(/CREATE TABLE IF NOT EXISTS day_override_template_slots\b/)
  })
})

describe('rollbackV46', () => {
  it('recreates both tables (empty) and removes the schema_migrations row', () => {
    const db = freshDb()
    expect(tableExists(db, 'day_override_templates')).toBe(false)
    expect(tableExists(db, 'day_override_template_slots')).toBe(false)

    const result = rollbackV46(db)
    expect(result).toEqual({ recreated: ['day_override_templates', 'day_override_template_slots'] })
    expect(tableExists(db, 'day_override_templates')).toBe(true)
    expect(tableExists(db, 'day_override_template_slots')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 46').get().c).toBe(0)
    // Empty — nothing ever wrote to them, so there is nothing to restore.
    expect(db.prepare('SELECT COUNT(*) c FROM day_override_templates').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM day_override_template_slots').get().c).toBe(0)
    db.close()
  })

  it('up→down→up round-trip — reopening after a rollback re-drops both tables cleanly (Red Hat LOW)', () => {
    // The exact real-device sequence: rollback (recreates the tables, resets to
    // pre-v46), then the app reopens on a build that still ships v46 → initSchema
    // must re-run the v46 migration silently, re-dropping both and restoring the
    // migration row. This is the highest-stakes moment to discover a migration
    // bug, so it gets an explicit test rather than relying on idempotency-by-construction.
    const db = freshDb()
    rollbackV46(db)
    expect(tableExists(db, 'day_override_templates')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 46').get().c).toBe(0)

    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableExists(db, 'day_override_templates')).toBe(false)
    expect(tableExists(db, 'day_override_template_slots')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 46').get().c).toBe(1)
    db.close()
  })
})
