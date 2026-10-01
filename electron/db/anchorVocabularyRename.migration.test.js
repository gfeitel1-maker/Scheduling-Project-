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
    // Pin v84's OWN migration marker, not "what is the current head" — a literal
    // CURRENT_SCHEMA_VERSION comparison broke on every later schema bump (T321's v85,
    // T322 S3a's v86, ...) for a fact this test was never actually checking: whether
    // v84 itself landed. That is what the row below verifies instead.
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 84').get().c).toBe(1)
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

// ---------------------------------------------------------------------------
// schedule_snapshots.slots JSON blob rewrite.
//
// The column rename above only touches template_slots itself. A schedule_snapshots
// row holds its own INDEPENDENT copy of slot data, serialized to JSON text — every
// writer (src/screens/schedule/useSnapshots.js, electron/ops/materializeImportedVersion.js,
// the v26 orphan backfill above) has always used the snake_case DB-row shape, so an
// existing blob's elements carry `anchor_id`/`is_anchor`, not the engine's camelCase
// `type`/`anchorId` (confirmed by reading every writer; there is no `type` key in a
// snapshot blob). Once the column is renamed and nothing reads the old key names,
// restoring an old snapshot would silently lose every fixed event — the T62 shape,
// with no error and no failing test — unless the stored JSON is rewritten too.
// ---------------------------------------------------------------------------

const seedTemplate = (db, { id = 'tpl1', campId = 'camp1', kind = 'manual', name = 'Week 1' } = {}) => {
  db.prepare('INSERT INTO schedule_templates (id, camp_id, kind, name) VALUES (?, ?, ?, ?)').run(id, campId, kind, name)
  return id
}

const seedSnapshot = (db, { id, templateId, slots }) => {
  db.prepare(
    "INSERT INTO schedule_snapshots (id, template_id, created_at, slots) VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?)"
  ).run(id, templateId, slots)
}

describe('migration v84: rewrites the stored schedule_snapshots.slots JSON blob', () => {
  it('non-vacuity: the seeded pre-migration blob really contains anchor_id/is_anchor', () => {
    const raw = JSON.stringify([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: 'fe1', is_anchor: true, flags: {} },
    ])
    expect(raw).toContain('"anchor_id"')
    expect(raw).toContain('"is_anchor"')
  })

  it('renames anchor_id/is_anchor to fixed_event_id/is_fixed_event on every element, carrying values, element count unchanged', () => {
    const db = preV84Db()
    seedCamp(db)
    const templateId = seedTemplate(db)
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: 'fe1', is_anchor: true, flags: {} },
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act1', anchor_id: null, is_anchor: false, flags: {} },
      { group_id: 'g2', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: 'fe2', is_anchor: true, flags: { UNFILLABLE: true } },
    ]
    seedSnapshot(db, { id: 'snap1', templateId, slots: JSON.stringify(slots) })

    initSchema(db) // runs v84

    const row = db.prepare('SELECT slots FROM schedule_snapshots WHERE id = ?').get('snap1')
    const rewritten = JSON.parse(row.slots)
    expect(rewritten).toHaveLength(3)
    for (const el of rewritten) {
      expect(el).not.toHaveProperty('anchor_id')
      expect(el).not.toHaveProperty('is_anchor')
      expect(el).toHaveProperty('fixed_event_id')
      expect(el).toHaveProperty('is_fixed_event')
    }
    expect(rewritten[0].fixed_event_id).toBe('fe1')
    expect(rewritten[0].is_fixed_event).toBe(true)
    expect(rewritten[1].fixed_event_id).toBeNull()
    expect(rewritten[1].is_fixed_event).toBe(false)
    expect(rewritten[2].fixed_event_id).toBe('fe2')
    expect(rewritten[2].is_fixed_event).toBe(true)
    db.close()
  })

  it('KEY-TARGETED, not a text replace: values and an unrelated flags key containing the substring "anchor" survive byte-identical', () => {
    const db = preV84Db()
    seedCamp(db)
    const templateId = seedTemplate(db)
    const slots = [
      {
        group_id: 'g1', day_id: 'd1', time_block_id: 'b1',
        activity_id: 'anchor-day-activity', // substring "anchor" INSIDE a value that must not be touched
        anchor_id: 'fe1', is_anchor: true,
        flags: { note: 'moved off anchor_id manually', anchor_like_key: 'keep me' },
      },
    ]
    seedSnapshot(db, { id: 'snap2', templateId, slots: JSON.stringify(slots) })

    initSchema(db) // runs v84

    const row = db.prepare('SELECT slots FROM schedule_snapshots WHERE id = ?').get('snap2')
    const rewritten = JSON.parse(row.slots)
    expect(rewritten).toHaveLength(1)
    const el = rewritten[0]
    expect(el.activity_id).toBe('anchor-day-activity')
    expect(el.flags).toEqual({ note: 'moved off anchor_id manually', anchor_like_key: 'keep me' })
    expect(el.fixed_event_id).toBe('fe1')
    expect(el.is_fixed_event).toBe(true)
    expect(el.group_id).toBe('g1')
    expect(el.day_id).toBe('d1')
    expect(el.time_block_id).toBe('b1')
    db.close()
  })

  it('leaves every other key untouched across all elements', () => {
    const db = preV84Db()
    seedCamp(db)
    const templateId = seedTemplate(db)
    const slots = [
      { group_id: 'gX', day_id: 'dX', time_block_id: 'bX', activity_id: 'actX', anchor_id: null, is_anchor: false, flags: { UNFILLABLE: true, UNFILLABLE_reason: 'x' } },
    ]
    seedSnapshot(db, { id: 'snap3', templateId, slots: JSON.stringify(slots) })

    initSchema(db)

    const el = JSON.parse(db.prepare('SELECT slots FROM schedule_snapshots WHERE id = ?').get('snap3').slots)[0]
    expect(el.group_id).toBe('gX')
    expect(el.day_id).toBe('dX')
    expect(el.time_block_id).toBe('bX')
    expect(el.activity_id).toBe('actX')
    expect(el.flags).toEqual({ UNFILLABLE: true, UNFILLABLE_reason: 'x' })
    db.close()
  })

  it('a malformed/NULL/non-array slots value is left untouched and does not abort the migration', () => {
    const db = preV84Db()
    seedCamp(db)
    const templateId = seedTemplate(db)
    db.prepare("INSERT INTO schedule_snapshots (id, template_id, created_at, slots) VALUES ('snap-null', ?, '2026-01-01T00:00:00.000Z', NULL)").run(templateId)
    db.prepare("INSERT INTO schedule_snapshots (id, template_id, created_at, slots) VALUES ('snap-empty', ?, '2026-01-01T00:00:00.000Z', '')").run(templateId)
    db.prepare("INSERT INTO schedule_snapshots (id, template_id, created_at, slots) VALUES ('snap-badjson', ?, '2026-01-01T00:00:00.000Z', '{not json')").run(templateId)
    db.prepare(`INSERT INTO schedule_snapshots (id, template_id, created_at, slots) VALUES ('snap-notarray', ?, '2026-01-01T00:00:00.000Z', '{"a":1}')`).run(templateId)

    expect(() => initSchema(db)).not.toThrow() // runs v84

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare("SELECT slots FROM schedule_snapshots WHERE id = 'snap-null'").get().slots).toBeNull()
    expect(db.prepare("SELECT slots FROM schedule_snapshots WHERE id = 'snap-empty'").get().slots).toBe('')
    expect(db.prepare("SELECT slots FROM schedule_snapshots WHERE id = 'snap-badjson'").get().slots).toBe('{not json')
    expect(db.prepare("SELECT slots FROM schedule_snapshots WHERE id = 'snap-notarray'").get().slots).toBe('{"a":1}')
    db.close()
  })

  it('round-trips through the rollback: migrate up, roll back, blobs are back to anchor_id/is_anchor with values intact', () => {
    const db = preV84Db()
    seedCamp(db)
    const templateId = seedTemplate(db)
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: 'fe1', is_anchor: true, flags: {} },
    ]
    seedSnapshot(db, { id: 'snap-rt', templateId, slots: JSON.stringify(slots) })

    initSchema(db) // forward: anchor_id/is_anchor -> fixed_event_id/is_fixed_event
    rollbackV84(db) // back: fixed_event_id/is_fixed_event -> anchor_id/is_anchor

    const el = JSON.parse(db.prepare("SELECT slots FROM schedule_snapshots WHERE id = 'snap-rt'").get().slots)[0]
    expect(el).not.toHaveProperty('fixed_event_id')
    expect(el).not.toHaveProperty('is_fixed_event')
    expect(el.anchor_id).toBe('fe1')
    expect(el.is_anchor).toBe(true)
    db.close()
  })
})
