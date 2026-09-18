// @vitest-environment node
//
// Migration v66 — the participant data substrate (T194).
// ADR docs/adr/2026-09-17-individual-elective-scheduling.md,
// design docs/work/specs/2026-09-17-t194-participant-substrate-design.md §7.
//
// Seven new tables plus two capacity columns on the EXISTING
// elective_set_activities table. Modelled on electiveCapacity.migration.test.js.
//
// The trap this file exists for: `template_slots.elective_set_id` is a v35
// migration-added column absent from the fresh CREATE TABLE, so fresh and
// migrated databases can differ in column ORDER while having an identical
// column SET. Every parity assertion below compares the ARRAY, not a set.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

const PARTICIPANT_TABLES = [
  'campers',
  'elective_assignment_runs',
  'elective_occurrences',
  'elective_choices',
  'elective_choice_offerings',
  'elective_preferences',
  'elective_assignments',
]

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
  return openLocalDb(tmpFile('v66-fresh'))
}

// A database migrated fully forward, then reverted BY HAND to the v65 shape.
// Hand-built rather than via rollbackV66 so the forward test does not depend on
// the down path being correct — the two are proved independently.
function preV66Db(tag = 'v66-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  for (const t of [...PARTICIPANT_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${t}`)
  db.exec('ALTER TABLE elective_set_activities RENAME TO elective_set_activities_tmp')
  db.exec(`CREATE TABLE elective_set_activities (
    id TEXT PRIMARY KEY,
    elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
    activity_id TEXT NOT NULL,
    camper_headcount INTEGER,
    UNIQUE(elective_set_id, activity_id)
  )`)
  db.exec(`INSERT INTO elective_set_activities (id, elective_set_id, activity_id, camper_headcount)
    SELECT id, elective_set_id, activity_id, camper_headcount FROM elective_set_activities_tmp`)
  db.exec('DROP TABLE elective_set_activities_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 66').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid,
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt_value: c.dflt_value,
    pk: c.pk,
  }))

const colNames = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)

const seedCamp = (db) => {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
}

describe('migration v66: version and table presence', () => {
  it('declares schema version 66 on a fresh db', () => {
    const db = freshDb()
    expect(CURRENT_SCHEMA_VERSION).toBe(69)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 66').get().c).toBe(1)
    db.close()
  })

  it('creates all seven participant tables on a fresh db', () => {
    const db = freshDb()
    for (const t of PARTICIPANT_TABLES) {
      expect(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c,
        `${t} missing on fresh`
      ).toBe(1)
    }
    db.close()
  })

  it('migrates a pre-v66 db forward to 66 and creates all seven tables', () => {
    const db = preV66Db()
    expect(getSchemaVersion(db)).toBe(65)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    for (const t of PARTICIPANT_TABLES) {
      expect(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c,
        `${t} missing after migration`
      ).toBe(1)
    }
    db.close()
  })
})

describe('migration v66: fresh vs migrated equivalence', () => {
  it('gives fresh and migrated identical column ORDER for all eight tables', () => {
    const fresh = freshDb()
    const migrated = preV66Db()
    initSchema(migrated)
    for (const t of [...PARTICIPANT_TABLES, 'elective_set_activities']) {
      // .toEqual on the ARRAY — this is what makes it an order comparison.
      expect(colNames(migrated, t), `${t} column order drift`).toEqual(colNames(fresh, t))
    }
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated identical column TYPES and NOT NULL', () => {
    const fresh = freshDb()
    const migrated = preV66Db()
    initSchema(migrated)
    for (const t of [...PARTICIPANT_TABLES, 'elective_set_activities']) {
      expect(tableInfo(migrated, t), `${t} column tuple drift`).toEqual(tableInfo(fresh, t))
    }
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares the capacity columns LAST on elective_set_activities, in order', () => {
    const db = freshDb()
    expect(colNames(db, 'elective_set_activities')).toEqual([
      'id',
      'elective_set_id',
      'activity_id',
      'camper_headcount',
      'capacity_mode',
      'capacity_limit',
      'status',
    ])
    db.close()
  })

  it('keeps the CHECK constraints identical between fresh and migrated', () => {
    const fresh = freshDb()
    const migrated = preV66Db()
    initSchema(migrated)
    const ddl = (db) =>
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='elective_set_activities'")
        .get().sql
    // ALTER ADD COLUMN folds the column-level CHECK into the stored DDL. If a
    // future SQLite ever diverges here, a migrated db silently loses a
    // constraint the fresh one has, and only this assertion sees it.
    expect(ddl(migrated).replace(/\s+/g, ' ')).toContain('capacity_mode')
    expect(ddl(migrated).replace(/\s+/g, ' ')).toContain("capacity_mode IN ('unlimited', 'limited')")
    expect(ddl(fresh).replace(/\s+/g, ' ')).toContain("capacity_mode IN ('unlimited', 'limited')")
    fresh.close()
    migrated.close()
  }, 30000)

  it('keeps the UNIQUE index on elective_set_activities alive on BOTH paths (T189 guard)', () => {
    const fresh = freshDb()
    const migrated = preV66Db()
    initSchema(migrated)
    const uniques = (db) =>
      db
        .pragma('index_list(elective_set_activities)')
        .filter((i) => i.unique === 1)
        .map((i) => db.pragma(`index_info(${i.name})`).map((c) => c.name).join(','))
        .sort()
    expect(uniques(migrated)).toEqual(uniques(fresh))
    expect(uniques(fresh)).toContain('elective_set_id,activity_id')
    fresh.close()
    migrated.close()
  }, 30000)
})

describe('migration v66: capacity CHECK behaviour, pinned', () => {
  const insert = (db, mode, limit) =>
    db
      .prepare(
        `INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit)
         VALUES (?, 'set1', ?, ?, ?)`
      )
      .run(`m-${mode}-${limit}-${Math.random()}`, `act-${Math.random()}`, mode, limit)

  it('accepts and rejects exactly the designed matrix', () => {
    const db = freshDb()
    seedCamp(db)
    expect(() => insert(db, 'unlimited', null)).not.toThrow()
    expect(() => insert(db, 'limited', 0)).not.toThrow()
    expect(() => insert(db, 'limited', 12)).not.toThrow()
    expect(() => insert(db, 'limited', -1)).toThrow(/CHECK/i)
    expect(() => insert(db, 'limited', 2.5)).toThrow(/CHECK/i)
    expect(() => insert(db, 'bogus', 1)).toThrow(/CHECK/i)
    db.close()
  })

  // THE FINDING MOST LIKELY TO BE RE-BROKEN BY A WELL-MEANING REVIEWER.
  // The projection applies ONE entity/field/value triple per operation, so
  // changing an offering from unlimited to a cap of 12 is two writes in some
  // order. A cross-column pairing CHECK
  //   ((mode='unlimited' AND limit IS NULL) OR (mode='limited' AND limit IS NOT NULL))
  // is rejected BOTH ways round: mode-first traverses ('limited', NULL),
  // limit-first traverses ('unlimited', 12). It would fail on the RECEIVING
  // device during sync replay. Do not "tighten" these CHECKs into that form.
  it('allows capacity_mode and capacity_limit to be written one field at a time, in EITHER order', () => {
    const db = freshDb()
    seedCamp(db)
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('a', 'set1', 'act-a')"
    ).run()
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('b', 'set1', 'act-b')"
    ).run()

    // mode first, then limit
    expect(() =>
      db.prepare("UPDATE elective_set_activities SET capacity_mode = 'limited' WHERE id = 'a'").run()
    ).not.toThrow()
    expect(() =>
      db.prepare('UPDATE elective_set_activities SET capacity_limit = 12 WHERE id = ?').run('a')
    ).not.toThrow()

    // limit first, then mode
    expect(() =>
      db.prepare('UPDATE elective_set_activities SET capacity_limit = 12 WHERE id = ?').run('b')
    ).not.toThrow()
    expect(() =>
      db.prepare("UPDATE elective_set_activities SET capacity_mode = 'limited' WHERE id = 'b'").run()
    ).not.toThrow()

    db.close()
  })
})

describe('migration v66: how existing rows acquire a capacity meaning', () => {
  it('gives every pre-v66 row the defined meaning ADR D3 requires, via the ADD COLUMN DEFAULT', () => {
    const db = preV66Db()
    seedCamp(db)
    const seed = db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, camper_headcount) VALUES (?, ?, ?, ?)'
    )
    seed.run('m-null', 'set1', 'act-null', null)
    seed.run('m-zero', 'set1', 'act-zero', 0)
    seed.run('m-twelve', 'set1', 'act-twelve', 12)
    seed.run('m-neg', 'set1', 'act-neg', -3)

    initSchema(db)

    const row = (id) =>
      db
        .prepare(
          'SELECT camper_headcount, capacity_mode, capacity_limit FROM elective_set_activities WHERE id = ?'
        )
        .get(id)

    // THE CASE THAT EXISTS. schema.sql has always declared, in writing, that a
    // NULL camper_headcount means "no cap, never zero campers" — so
    // ('unlimited', NULL) is a translation of a stated semantic, not a guess.
    expect(row('m-null')).toEqual({
      camper_headcount: null,
      capacity_mode: 'unlimited',
      capacity_limit: null,
    })

    // THE CASES THAT DO NOT EXIST, pinned so the deferral is VISIBLE rather
    // than discovered later by someone reading the mapping table in the design
    // doc and assuming it ran.
    //
    // A conditional backfill UPDATE would have mapped these to ('limited', 0),
    // ('limited', 12) and ('limited', NULL). It was removed because both
    // capacity columns are MODELED fields, and a post-v52 migration that writes
    // a modeled field in SQLite alone diverges from the authoritative document
    // — projectAll's delete-reconcile quietly undoes it at the next merge.
    // migrationDomainState.test.js pins that rule: above v52, such a change
    // must be written THROUGH THE DOCUMENT, not by a migration.
    //
    // This is safe because ZERO such rows exist: surveyed 2026-09-17 across
    // both live databases and 41 backups with ?immutable=1,
    // elective_set_activities has never held a row, and the only
    // offering-creating path writes camper_headcount: null unconditionally.
    // And nothing is destroyed — camper_headcount is retained untouched, so the
    // translation stays available at any time.
    for (const id of ['m-zero', 'm-twelve', 'm-neg']) {
      expect(row(id).capacity_mode, `${id} mode`).toBe('unlimited')
      expect(row(id).capacity_limit, `${id} limit`).toBeNull()
    }
    // The legacy value survives IN THIS DATABASE, which is what makes the
    // deferred translation available. It is NOT a general reversibility claim
    // (round 2, M5): camper_headcount stops being a projected field at v66, so
    // applyProjection drops ops on it and a rebuild-from-document recreates
    // these rows with it NULL. The translation is available until the first
    // rebuild, not forever.
    expect(row('m-zero').camper_headcount).toBe(0)
    expect(row('m-twelve').camper_headcount).toBe(12)
    expect(row('m-neg').camper_headcount).toBe(-3)
    db.close()
  })

  it('leaves camper_headcount itself untouched — survey and report, never rewrite (D3)', () => {
    const db = preV66Db()
    seedCamp(db)
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, camper_headcount) VALUES (?, ?, ?, ?)'
    ).run('m1', 'set1', 'act1', 12)
    initSchema(db)
    expect(
      db.prepare("SELECT camper_headcount FROM elective_set_activities WHERE id='m1'").get()
        .camper_headcount
    ).toBe(12)
    db.close()
  })

  it('writes NO op-log rows — a migration is a schema change, not a user write', () => {
    const db = preV66Db()
    seedCamp(db)
    const before = db.prepare('SELECT COUNT(*) c FROM operations').get().c
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(before)
    for (const t of [...PARTICIPANT_TABLES, 'elective_set_activities']) {
      expect(
        db.prepare('SELECT COUNT(*) c FROM operations WHERE entity = ?').get(t).c,
        `${t} ops written by the migration`
      ).toBe(0)
    }
    db.close()
  })

  it('is idempotent — re-running v66 does not duplicate columns, re-backfill, or lose data', () => {
    const db = preV66Db()
    seedCamp(db)
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, camper_headcount) VALUES (?, ?, ?, ?)'
    ).run('m1', 'set1', 'act1', 12)
    initSchema(db) // runs v66

    // A director then edits the cap through the app. Re-running the migration
    // must NOT revert it to the legacy camper_headcount value.
    db.prepare("UPDATE elective_set_activities SET capacity_mode='unlimited', capacity_limit=NULL WHERE id='m1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 66').run()
    initSchema(db) // re-run v66

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      db.pragma('table_info(elective_set_activities)').filter((c) => c.name === 'capacity_mode')
    ).toHaveLength(1)
    expect(
      db
        .prepare('SELECT capacity_mode, capacity_limit FROM elective_set_activities WHERE id=?')
        .get('m1')
    ).toEqual({ capacity_mode: 'unlimited', capacity_limit: null })
    db.close()
  })
})
