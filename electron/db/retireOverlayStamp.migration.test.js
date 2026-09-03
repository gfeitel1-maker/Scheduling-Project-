// @vitest-environment node
//
// Migration v53 — retire the overlay/stamp subsystem
// (docs/adr/2026-08-30-retire-overlay-stamp-subsystem.md). Drops the
// template_overlays table outright (no live writer — the authoring path was
// already dead) and drops schedule_snapshots.overlays (hard cutover, no
// back-compat; existing snapshot overlays JSON is discarded by design, ADR
// §2b). DDL-only, no backfill. Mirrors dayOverrideTemplatesRemoval.migration.
// test.js's fresh-vs-migrated shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV53 } from './rollback/v53_down.js'

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
  return openLocalDb(tmpFile('v53-fresh'))
}

// A database migrated fully forward, then rolled back to the v52 shape
// (template_overlays present + empty; schedule_snapshots.overlays column
// present), so v53 can be exercised against it.
function preV53Db(tag = 'v53-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current (table dropped, column dropped)
  rollbackV53(db) // recreate template_overlays + re-add overlays column, reset to v52
  return db
}

const tableExists = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

const columnsOf = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)

describe('migration v53: retire overlay/stamp subsystem', () => {
  it('declares schema version 53 on a fresh db; no template_overlays, no snapshots.overlays', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(54)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 53').get().c).toBe(1)
    expect(tableExists(db, 'template_overlays')).toBe(false)
    expect(columnsOf(db, 'schedule_snapshots')).not.toContain('overlays')
    db.close()
  })

  it('migrates a pre-v53 db forward to 53, dropping the table and the column', () => {
    const db = preV53Db()
    expect(getSchemaVersion(db)).toBe(52)
    expect(tableExists(db, 'template_overlays')).toBe(true)
    expect(columnsOf(db, 'schedule_snapshots')).toContain('overlays')

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableExists(db, 'template_overlays')).toBe(false)
    expect(columnsOf(db, 'schedule_snapshots')).not.toContain('overlays')
    db.close()
  })

  it('preserves snapshot slots/day_overrides_json while discarding overlays', () => {
    const db = preV53Db('v53-data')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES ('tpl1', 'camp1', 'T', 'generated')"
    ).run()
    db.prepare(
      `INSERT INTO schedule_snapshots (id, template_id, name, is_auto, created_at, slots, overlays, day_overrides_json)
       VALUES ('s1', 'tpl1', 'Snap', 0, '2026-08-30', '{"slots":1}', '{"overlays":1}', '{"do":1}')`
    ).run()

    initSchema(db)

    const row = db.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get('s1')
    expect(row.slots).toBe('{"slots":1}')
    expect(row.day_overrides_json).toBe('{"do":1}')
    expect(row).not.toHaveProperty('overlays')
    // day_overrides_json must remain the last column on the rebuilt table.
    const cols = columnsOf(db, 'schedule_snapshots')
    expect(cols[cols.length - 1]).toBe('day_overrides_json')
    db.close()
  })

  it('fresh-vs-migrated equivalence — same tables and same schedule_snapshots columns', () => {
    const fresh = freshDb()
    const migrated = preV53Db()
    initSchema(migrated)

    const tablesOf = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)

    expect(tablesOf(migrated)).toEqual(tablesOf(fresh))
    expect(tablesOf(fresh)).not.toContain('template_overlays')
    expect(columnsOf(migrated, 'schedule_snapshots')).toEqual(columnsOf(fresh, 'schedule_snapshots'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v53 on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableExists(db, 'template_overlays')).toBe(false)
    expect(columnsOf(db, 'schedule_snapshots')).not.toContain('overlays')
    db.close()
  })

  it('schema.sql no longer declares template_overlays or the overlays column', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    expect(schemaText).not.toMatch(/CREATE TABLE IF NOT EXISTS template_overlays\b/)
    // The schedule_snapshots block must not carry an `overlays TEXT` column line.
    expect(schemaText).not.toMatch(/^\s*overlays TEXT/m)
  })
})

describe('rollbackV53', () => {
  it('recreates template_overlays (empty) + re-adds overlays column NULL, removes migration row', () => {
    const db = freshDb()
    expect(tableExists(db, 'template_overlays')).toBe(false)
    expect(columnsOf(db, 'schedule_snapshots')).not.toContain('overlays')

    const result = rollbackV53(db)
    expect(result).toEqual({ recreated: ['template_overlays', 'schedule_snapshots.overlays'] })
    expect(tableExists(db, 'template_overlays')).toBe(true)
    expect(columnsOf(db, 'schedule_snapshots')).toContain('overlays')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 53').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM template_overlays').get().c).toBe(0)
    db.close()
  })

  it('up→down→up round-trip — reopening after a rollback re-drops cleanly', () => {
    const db = freshDb()
    rollbackV53(db)
    expect(tableExists(db, 'template_overlays')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 53').get().c).toBe(0)

    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(tableExists(db, 'template_overlays')).toBe(false)
    expect(columnsOf(db, 'schedule_snapshots')).not.toContain('overlays')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 53').get().c).toBe(1)
    db.close()
  })
})
