// T265 / schema v80 — `elective_set_activities` gains the two-part minimum
// (min_mode, min_to_run), mirroring v66's (capacity_mode, capacity_limit).
//
// The shape is D3's, deliberately: `min_mode` is the AUTHORITY, and when it is
// 'none' the value column is ignored entirely — never coerced, never compared.
// A single nullable integer would have reproduced the live blank-capacity bug by
// construction (a blank minimum becoming 0), which is why the ticket forbids it.
//
// THE ASYMMETRY WITH capacity_limit IS THE POINT. `capacity_limit >= 0` because
// a capacity of 0 is a genuinely CLOSED offering, a meaningful state.
// `min_to_run >= 1` because a minimum of 0 means nothing — owner ruling
// 2026-09-25: "the min could be 1, cannot be 0."
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

const freshDb = () => openLocalDb(tmpFile('v80-fresh'))

const colNames = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)

const seedCamp = (db) => {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
}

// A db migrated fully forward, then reverted BY HAND to the v79 shape of this
// one table — hand-built rather than via rollbackV80 so the forward test does
// not depend on the down path being correct. The two are proved independently,
// the same discipline as participantSubstrate.migration.test.js's preV66Db.
function preV80Db(tag = 'v80-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE elective_set_activities RENAME TO esa_tmp')
  db.exec(`CREATE TABLE elective_set_activities (
    id TEXT PRIMARY KEY,
    elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
    activity_id TEXT NOT NULL,
    camper_headcount INTEGER,
    capacity_mode TEXT NOT NULL DEFAULT 'unlimited'
      CHECK (capacity_mode IN ('unlimited', 'limited')),
    capacity_limit INTEGER
      CHECK (capacity_limit IS NULL
             OR (typeof(capacity_limit) = 'integer' AND capacity_limit >= 0)),
    status TEXT NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('potential', 'confirmed')),
    UNIQUE(elective_set_id, activity_id)
  )`)
  db.exec(`INSERT INTO elective_set_activities
    (id, elective_set_id, activity_id, camper_headcount, capacity_mode, capacity_limit, status)
    SELECT id, elective_set_id, activity_id, camper_headcount, capacity_mode, capacity_limit, status
    FROM esa_tmp`)
  db.exec('DROP TABLE esa_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 80').run()
  return db
}

describe('migration v80: version and columns', () => {
  it('declares schema version 80 on a fresh db', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 80').get().c).toBe(1)
    db.close()
  })

  it('adds min_mode and min_to_run to elective_set_activities', () => {
    const db = freshDb()
    expect(colNames(db, 'elective_set_activities')).toContain('min_mode')
    expect(colNames(db, 'elective_set_activities')).toContain('min_to_run')
    db.close()
  })

  // THE COLUMN-ORDER TRAP. ALTER TABLE ADD COLUMN always APPENDS, so the fresh
  // install's declaration order must match. Bitten before on
  // elective_sets.is_reusable and activities.location_id.
  it('gives fresh and migrated identical column ORDER', () => {
    const fresh = freshDb()
    const migrated = preV80Db()
    expect(getSchemaVersion(migrated)).toBe(79)
    initSchema(migrated)
    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)
    // .toEqual on the ARRAY — that is what makes this an order comparison.
    expect(colNames(migrated, 'elective_set_activities'))
      .toEqual(colNames(fresh, 'elective_set_activities'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives every existing row min_mode = none and a NULL min_to_run', () => {
    const db = preV80Db('v80-existing')
    seedCamp(db)
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('e1', 'set1', 'act-1')"
    ).run()
    initSchema(db)
    const row = db.prepare('SELECT min_mode, min_to_run FROM elective_set_activities WHERE id = ?').get('e1')
    expect(row).toEqual({ min_mode: 'none', min_to_run: null })
    db.close()
  }, 30000)
})

describe('migration v80: the minimum CHECK matrix, pinned', () => {
  const insert = (db, mode, value) =>
    db
      .prepare(
        `INSERT INTO elective_set_activities (id, elective_set_id, activity_id, min_mode, min_to_run)
         VALUES (?, 'set1', ?, ?, ?)`
      )
      .run(`m-${mode}-${value}-${Math.random()}`, `act-${Math.random()}`, mode, value)

  it('accepts and rejects exactly the designed matrix, and 0 is REJECTED', () => {
    const db = freshDb()
    seedCamp(db)
    expect(() => insert(db, 'none', null)).not.toThrow()
    expect(() => insert(db, 'required', 1)).not.toThrow()
    expect(() => insert(db, 'required', 5)).not.toThrow()
    // Owner ruling: the min could be 1, cannot be 0.
    expect(() => insert(db, 'required', 0)).toThrow(/CHECK/i)
    expect(() => insert(db, 'required', -1)).toThrow(/CHECK/i)
    expect(() => insert(db, 'required', 2.5)).toThrow(/CHECK/i)
    expect(() => insert(db, 'bogus', 1)).toThrow(/CHECK/i)
    db.close()
  })

  // min_mode is the AUTHORITY: a leftover value under 'none' is legal storage,
  // and the reader ignores it. That is what makes clearing a minimum a
  // one-field write rather than a two-field transaction.
  it('allows a leftover min_to_run under min_mode = none', () => {
    const db = freshDb()
    seedCamp(db)
    expect(() => insert(db, 'none', 5)).not.toThrow()
    db.close()
  })

  // The SAME reasoning as v66's capacity CHECKs, and the same trap. The
  // projection applies ONE entity/field/value triple per operation, so setting a
  // minimum is two writes in some order. A cross-column pairing CHECK is
  // rejected BOTH ways round and would fail on the RECEIVING device during sync
  // replay. Do not "tighten" these into that form.
  it('allows min_mode and min_to_run to be written one field at a time, in EITHER order', () => {
    const db = freshDb()
    seedCamp(db)
    for (const id of ['a', 'b']) {
      db.prepare(
        'INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)'
      ).run(id, 'set1', `act-${id}`)
    }
    // mode first, then value
    expect(() =>
      db.prepare("UPDATE elective_set_activities SET min_mode = 'required' WHERE id = 'a'").run()
    ).not.toThrow()
    expect(() =>
      db.prepare('UPDATE elective_set_activities SET min_to_run = 5 WHERE id = ?').run('a')
    ).not.toThrow()
    // value first, then mode
    expect(() =>
      db.prepare('UPDATE elective_set_activities SET min_to_run = 5 WHERE id = ?').run('b')
    ).not.toThrow()
    expect(() =>
      db.prepare("UPDATE elective_set_activities SET min_mode = 'required' WHERE id = 'b'").run()
    ).not.toThrow()
    db.close()
  })

  it('rejects a 0 written by UPDATE, not only by INSERT', () => {
    const db = freshDb()
    seedCamp(db)
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('z', 'set1', 'act-z')"
    ).run()
    expect(() =>
      db.prepare('UPDATE elective_set_activities SET min_to_run = 0 WHERE id = ?').run('z')
    ).toThrow(/CHECK/i)
    db.close()
  })
})
