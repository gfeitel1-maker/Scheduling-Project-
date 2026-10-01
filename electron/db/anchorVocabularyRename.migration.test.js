// @vitest-environment node
//
// Migration v84 (T293, docs/adr/2026-10-01-anchors-become-fixed-and-recurring-events.md). Pure
// vocabulary rename — no new shape. Renames three columns:
//   template_slots.anchor_id -> fixed_event_id
//   template_slots.is_anchor -> is_fixed_event
//   cohorts.anchor_model -> fixed_event_model
// plus, filed in the same migration for mechanical convenience, an unrelated-domain rename:
//   compound_cell_decisions.anchor_name -> base_name
//
// Pins that the rename CARRIES row values, not just renames the column (ADR success predicate 4):
// build a db at v83 with rows in the old columns, migrate, and assert the new names exist, the old
// ones don't, and the values survived.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV84 } from './rollback/v84_down.js'

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
  return openLocalDb(tmpFile('v84-fresh'))
}

// A database migrated fully forward, then rolled back to the pre-v84 shape (old column names
// restored), so v84 can be exercised against it — mirroring preV77Db()'s shape in
// fixedEventIdentity.migration.test.js.
function preV84Db(tag = 'v84-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  rollbackV84(db)
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => c.name)

const seedCamp = (db, campId = 'camp1') =>
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES (?, 'Camp', 'sec')").run(campId)

describe('migration v84: fresh install declares the renamed columns', () => {
  it('declares schema version 84', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(84)
    db.close()
  })

  it('template_slots has fixed_event_id/is_fixed_event, not anchor_id/is_anchor', () => {
    const db = freshDb()
    const cols = tableInfo(db, 'template_slots')
    expect(cols).toContain('fixed_event_id')
    expect(cols).toContain('is_fixed_event')
    expect(cols).not.toContain('anchor_id')
    expect(cols).not.toContain('is_anchor')
    db.close()
  })

  it('cohorts has fixed_event_model, not anchor_model', () => {
    const db = freshDb()
    const cols = tableInfo(db, 'cohorts')
    expect(cols).toContain('fixed_event_model')
    expect(cols).not.toContain('anchor_model')
    db.close()
  })

  it('compound_cell_decisions has base_name, not anchor_name', () => {
    const db = freshDb()
    const cols = tableInfo(db, 'compound_cell_decisions')
    expect(cols).toContain('base_name')
    expect(cols).not.toContain('anchor_name')
    db.close()
  })
})

describe('migration v84: fresh vs migrated column parity', () => {
  it('gives fresh and migrated identical template_slots columns, in the same order', () => {
    const fresh = freshDb()
    const migrated = preV84Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'template_slots')).toEqual(tableInfo(fresh, 'template_slots'))
    fresh.close()
    migrated.close()
  })

  it('gives fresh and migrated identical cohorts columns, in the same order', () => {
    const fresh = freshDb()
    const migrated = preV84Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'cohorts')).toEqual(tableInfo(fresh, 'cohorts'))
    fresh.close()
    migrated.close()
  })

  it('gives fresh and migrated identical compound_cell_decisions columns, in the same order', () => {
    const fresh = freshDb()
    const migrated = preV84Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'compound_cell_decisions')).toEqual(tableInfo(fresh, 'compound_cell_decisions'))
    fresh.close()
    migrated.close()
  })
})

describe('migration v84: the rename CARRIES row values, not just the column', () => {
  it('template_slots.anchor_id/is_anchor values survive under their new names', () => {
    const db = preV84Db()
    seedCamp(db)
    db.prepare(
      `INSERT INTO schedule_templates (id, camp_id, kind, name) VALUES ('tpl1', 'camp1', 'manual', 'Week 1')`
    ).run()
    db.prepare(
      `INSERT INTO template_slots (id, template_id, day_id, time_block_id, anchor_id, is_anchor)
       VALUES ('slot1', 'tpl1', 'd1', 'b1', 'fe-123', 1)`
    ).run()

    initSchema(db) // runs v84

    const row = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot1')
    expect(row.fixed_event_id).toBe('fe-123')
    expect(row.is_fixed_event).toBe(1)
    expect(row.anchor_id).toBeUndefined()
    expect(row.is_anchor).toBeUndefined()
    db.close()
  })

  it('cohorts.anchor_model values survive under fixed_event_model', () => {
    const db = preV84Db()
    seedCamp(db)
    db.prepare(
      `INSERT INTO cohorts (id, camp_id, name, anchor_model) VALUES ('c1', 'camp1', 'Cohort A', 'fixed')`
    ).run()

    initSchema(db) // runs v84

    const row = db.prepare('SELECT * FROM cohorts WHERE id = ?').get('c1')
    expect(row.fixed_event_model).toBe('fixed')
    expect(row.anchor_model).toBeUndefined()
    db.close()
  })

  it('compound_cell_decisions.anchor_name values survive under base_name', () => {
    const db = preV84Db()
    seedCamp(db)
    db.prepare(
      `INSERT INTO compound_cell_decisions (id, camp_id, pattern, interpretation, anchor_name, wrapper_name, confirmed_at)
       VALUES ('d1', 'camp1', 'Lunch + Leave', 'wrapper', 'Lunch', 'Leave', '2026-01-01T00:00:00.000Z')`
    ).run()

    initSchema(db) // runs v84

    const row = db.prepare('SELECT * FROM compound_cell_decisions WHERE id = ?').get('d1')
    expect(row.base_name).toBe('Lunch')
    expect(row.anchor_name).toBeUndefined()
    db.close()
  })

  it('is idempotent — re-running v84 does not throw on an already-renamed column', () => {
    const db = preV84Db()
    seedCamp(db)
    initSchema(db) // runs v84
    db.prepare('DELETE FROM schema_migrations WHERE version >= 84').run()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})
