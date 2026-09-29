// T301 (docs/adr/2026-09-29-linked-elective-bundles.md D9) — schema v81:
// elective_bundles, elective_bundle_periods, elective_bundle_tiers. Three
// wholly new tables, additive only (no ALTER), so there is no pre-v81 SHAPE
// of any of these tables to hand-build — fresh install and migrated-forward
// both run the exact same CREATE TABLE text (mirroring the v67
// device_identity_key precedent this migration's own comment cites), unlike
// an ALTER-appended column where a hand-built pre-migration shape is needed.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema, openLocalDb } from './localDb.js'

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

const freshDb = () => openLocalDb(tmpFile('v81-fresh'))
const colNames = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

// A db migrated to v80, then reverted BY HAND to a pre-v81 shape (the three
// tables simply do not exist yet) — hand-built rather than via rollbackV81
// so the forward test does not depend on the down path being correct, the
// same discipline as electiveMinimumToRun.migration.test.js's preV80Db.
function preV81Db(tag = 'v81-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS elective_bundle_periods')
  db.exec('DROP TABLE IF EXISTS elective_bundle_tiers')
  db.exec('DROP TABLE IF EXISTS elective_bundles')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 81').run()
  return db
}

const seedCamp = (db) => {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
}

describe('migration v81: version and table presence', () => {
  it('declares schema version 81 on a fresh db', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 81').get().c).toBe(1)
    db.close()
  })

  it('creates all three tables on a fresh db', () => {
    const db = freshDb()
    for (const table of ['elective_bundles', 'elective_bundle_periods', 'elective_bundle_tiers']) {
      expect(hasTable(db, table), `expected table ${table} to exist`).toBe(true)
    }
    db.close()
  })

  it('migrates a pre-v81 db forward, creating all three tables', () => {
    const db = preV81Db()
    expect(getSchemaVersion(db)).toBe(80)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    for (const table of ['elective_bundles', 'elective_bundle_periods', 'elective_bundle_tiers']) {
      expect(hasTable(db, table), `expected table ${table} to exist after migrating forward`).toBe(true)
    }
    db.close()
  }, 30000)

  // FRESH-VS-MIGRATED COLUMN PARITY (GOVERNANCE_INDEX's mandatory check).
  // Lower risk here than an ALTER-appended column (no column-order trap is
  // even possible for a wholly new CREATE TABLE), but still asserted rather
  // than assumed — D9 asks for it explicitly.
  it('gives fresh and migrated identical column sets AND order, for all three tables', () => {
    const fresh = freshDb()
    const migrated = preV81Db()
    initSchema(migrated)
    for (const table of ['elective_bundles', 'elective_bundle_periods', 'elective_bundle_tiers']) {
      expect(colNames(migrated, table)).toEqual(colNames(fresh, table))
    }
    fresh.close()
    migrated.close()
  }, 30000)

  it('elective_bundles has the expected columns, in order', () => {
    const db = freshDb()
    expect(colNames(db, 'elective_bundles')).toEqual([
      'id', 'elective_set_id', 'activity_id', 'name', 'scope_mode', 'sort_order',
    ])
    db.close()
  })

  it('elective_bundle_periods has the expected columns, in order', () => {
    const db = freshDb()
    expect(colNames(db, 'elective_bundle_periods')).toEqual(['id', 'bundle_id', 'day_id', 'time_block_id'])
    db.close()
  })

  it('elective_bundle_tiers has the expected columns, in order', () => {
    const db = freshDb()
    expect(colNames(db, 'elective_bundle_tiers')).toEqual(['id', 'bundle_id', 'tier_id'])
    db.close()
  })
})

describe('migration v81: elective_bundles.scope_mode CHECK', () => {
  const insert = (db, scopeMode) =>
    db.prepare(
      `INSERT INTO elective_bundles (id, elective_set_id, activity_id, name, scope_mode)
       VALUES (?, 'set1', 'act-1', 'Woodworking', ?)`
    ).run(`b-${scopeMode}-${Math.random()}`, scopeMode)

  it('accepts exactly the three designed values', () => {
    const db = freshDb()
    seedCamp(db)
    expect(() => insert(db, 'all')).not.toThrow()
    expect(() => insert(db, 'only')).not.toThrow()
    expect(() => insert(db, 'except')).not.toThrow()
    db.close()
  })

  // Column-order parity above cannot see this — a fourth value is a
  // distinct failure mode the CHECK constraint itself must reject.
  it('rejects a fourth value', () => {
    const db = freshDb()
    seedCamp(db)
    expect(() => insert(db, 'sometimes')).toThrow(/CHECK/i)
    db.close()
  })

  it('defaults to "all" when omitted', () => {
    const db = freshDb()
    seedCamp(db)
    db.prepare(
      "INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES ('b-default', 'set1', 'act-1', 'Woodworking')"
    ).run()
    expect(db.prepare('SELECT scope_mode FROM elective_bundles WHERE id = ?').get('b-default').scope_mode).toBe('all')
    db.close()
  })
})

describe('migration v81: elective_bundles.elective_set_id is a real FK', () => {
  it('rejects a bundle naming a non-existent elective set, under foreign_keys=ON', () => {
    const db = freshDb()
    seedCamp(db)
    expect(() =>
      db.prepare(
        "INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES ('b1', 'no-such-set', 'act-1', 'X')"
      ).run()
    ).toThrow(/FOREIGN KEY/i)
    db.close()
  })
})

describe('migration v81: no UNIQUE on elective_bundles.name (D7) or (elective_set_id, activity_id) (D1)', () => {
  it('allows two bundles of the SAME activity in the SAME elective set', () => {
    const db = freshDb()
    seedCamp(db)
    const insert = (id) =>
      db.prepare(
        "INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES (?, 'set1', 'act-1', 'Woodworking')"
      ).run(id)
    expect(() => insert('b1')).not.toThrow()
    expect(() => insert('b2')).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c).toBe(2)
    db.close()
  })
})

describe('migration v81: elective_bundle_periods / elective_bundle_tiers accept duplicate rows (D1 — no UNIQUE, offline-concurrent authoring)', () => {
  function insertBundle(db) {
    db.prepare(
      "INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES ('b1', 'set1', 'act-1', 'Woodworking')"
    ).run()
  }

  it('elective_bundle_periods allows two rows naming the same (bundle_id, day_id, time_block_id)', () => {
    const db = freshDb()
    seedCamp(db)
    insertBundle(db)
    const insert = (id) =>
      db.prepare(
        'INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)'
      ).run(id, 'b1', 'day-1', 'tb-1')
    expect(() => insert('p1')).not.toThrow()
    expect(() => insert('p2')).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundle_periods').get().c).toBe(2)
    db.close()
  })

  it('elective_bundle_tiers allows two rows naming the same (bundle_id, tier_id)', () => {
    const db = freshDb()
    seedCamp(db)
    insertBundle(db)
    const insert = (id) =>
      db.prepare('INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES (?, ?, ?)').run(id, 'b1', 'tier-1')
    expect(() => insert('t1')).not.toThrow()
    expect(() => insert('t2')).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundle_tiers').get().c).toBe(2)
    db.close()
  })
})
