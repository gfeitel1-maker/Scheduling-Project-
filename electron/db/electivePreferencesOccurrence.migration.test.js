// @vitest-environment node
//
// Migration v78 (T265, docs/adr/2026-09-26-per-cell-elective-preferences.md)
// — elective_preferences gains a NULLABLE occurrence_id, an ALTER TABLE ADD
// COLUMN (round 5 corrected round 1's NOT NULL + DROP/CREATE, which discarded
// every existing row — see localDb.js's comment on the v78 block for the
// full history and the owner ruling that forced the correction: "we are
// reading someone's data. we are not choosing how they import it"). A row
// with occurrence_id = NULL is a legitimate whole-run preference, not a
// defect, so a pre-v78 row (which by definition predates any occurrence
// concept) carries forward unchanged rather than being discarded. Modelled
// on participantSubstrate.migration.test.js's fresh-vs-migrated shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

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
  return openLocalDb(tmpFile('v78-fresh'))
}

// A database migrated fully forward, then reverted BY HAND to the pre-v78
// shape (elective_preferences with no occurrence_id column), carrying a row
// that the forward migration must now CARRY FORWARD (occurrence_id = NULL),
// not discard.
function preV78Db(tag = 'v78-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE elective_preferences')
  db.exec(`CREATE TABLE elective_preferences (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    camper_id TEXT,
    choice_id TEXT,
    rank INTEGER
  )`)
  db.pragma('foreign_keys = ON')
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare(
    "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')"
  ).run()
  db.prepare(
    "INSERT INTO elective_preferences (id, run_id, camper_id, choice_id, rank) VALUES ('pref1', 'run1', 'cam1', 'choice1', 1)"
  ).run()
  // v75-v77 are allocated to peer sessions and do not exist on this branch yet
  // (a known sequencing gap). Deleting every stamp >= 75 leaves the max at 74
  // — the actual immediately-preceding migration this branch has, and what
  // the v78 guard's lower bound (`>= 74`) is written against.
  db.prepare('DELETE FROM schema_migrations WHERE version >= 75').run()
  return db
}

const colNames = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)
const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v78: elective_preferences gains occurrence_id', () => {
  it('declares schema version 78 on a fresh db', () => {
    const db = freshDb()
    // >= 78, not === 78: v78 is no longer the newest migration (v79 landed in T279),
    // so what this test owns is 'v78 has been applied', not 'v78 is the top version'.
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(78)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 78').get().c).toBe(1)
    db.close()
  })

  it('fresh install: elective_preferences has occurrence_id TEXT (nullable) and the named index', () => {
    const db = freshDb()
    const cols = tableInfo(db, 'elective_preferences')
    const occCol = cols.find((c) => c.name === 'occurrence_id')
    expect(occCol).toBeTruthy()
    expect(occCol.notnull).toBe(0)
    const indexes = db.pragma("index_list(elective_preferences)").map((i) => i.name)
    expect(indexes).toContain('idx_elective_preferences_run_camper_occurrence')
    db.close()
  })

  it('migrates a pre-v78 db forward, CARRYING FORWARD the existing row with occurrence_id = NULL', () => {
    const db = preV78Db()
    expect(getSchemaVersion(db)).toBe(74)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c).toBe(1)
    initSchema(db)
    // >= 78, not === 78: v78 is no longer the newest migration (v79 landed in T279),
    // so what this test owns is 'v78 has been applied', not 'v78 is the top version'.
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(78)
    // The row existing before v78 had no occurrence concept at all — under
    // the round-5 ruling that IS a legitimate whole-run preference, so it
    // survives the migration rather than being discarded, and its new
    // column's value is exactly the fallback semantics: NULL.
    const rows = db.prepare('SELECT * FROM elective_preferences').all()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('pref1')
    expect(rows[0].occurrence_id).toBeNull()
    expect(rows[0].camper_id).toBe('cam1')
    expect(rows[0].choice_id).toBe('choice1')
    expect(rows[0].rank).toBe(1)
    db.close()
  })

  it('post-v78 (migrated): occurrence_id is nullable and the index exists', () => {
    const db = preV78Db()
    initSchema(db)
    const cols = tableInfo(db, 'elective_preferences')
    const occCol = cols.find((c) => c.name === 'occurrence_id')
    expect(occCol).toBeTruthy()
    expect(occCol.notnull).toBe(0)
    const indexes = db.pragma("index_list(elective_preferences)").map((i) => i.name)
    expect(indexes).toContain('idx_elective_preferences_run_camper_occurrence')
    db.close()
  })

  // Predicate 1: fresh-install schema EQUALS migrated schema for this table,
  // asserted rather than assumed — the column ARRAY (order-sensitive), not
  // just the set, per participantSubstrate.migration.test.js's own stated
  // trap (a migration-added column can land in a different position than a
  // fresh CREATE TABLE's).
  it('fresh install schema EQUALS migrated schema for elective_preferences', () => {
    const fresh = freshDb()
    const migrated = preV78Db()
    initSchema(migrated)
    expect(colNames(migrated, 'elective_preferences')).toEqual(colNames(fresh, 'elective_preferences'))
    expect(tableInfo(migrated, 'elective_preferences')).toEqual(tableInfo(fresh, 'elective_preferences'))
    fresh.close()
    migrated.close()
  })

  // Round-2 review finding: the v78 guard's lower bound is `>= 74`, not the
  // one-wide `>= 77`, because v75-v77 are allocated to peer sessions and do
  // not exist ON THIS BRANCH yet — see localDb.js's comment on the guard.
  // That comment states an ASSUMPTION (every intervening migration stamps
  // unconditionally — see bug #194 at localDb.js:1976-1981 for what happens
  // when one doesn't), not a proof, and nothing forces anyone to revisit the
  // guard once v75-v77 actually land from a rebase. This is the mechanical
  // tripwire: it fails the moment a rollback module for 75, 76, or 77 exists
  // in this tree, which is the earliest concrete signal that the migrations
  // have landed.
  it('regression pin: the v78 guard stays the one-wide house form >= 77 && < 78', () => {
    // RESOLVED 2026-09-26. All of v75, v76 and v77 have landed and the v78 guard is now the
    // house form `>= 77 && < 78` (localDb.js), so this tripwire has done its job and is kept
    // only as a regression pin: if anyone widens that guard again, this fails.
    //
    // WHAT THIS TRIPWIRE GOT WRONG, kept because the lesson outlived the bug. Its original
    // message said to narrow to `>= 77 && < 78` "once v75-v77 exist". They did not land
    // together: v75 and v76 merged while v77 stayed on a peer branch. Following the instruction
    // at that moment would have made the migration UNREACHABLE, since nothing reaches version 77
    // until v77 exists — a silently missing column behind a green gate, which is the exact
    // failure the wide lower bound existed to prevent. The rule it should have encoded: narrow
    // to the highest LANDED predecessor, not the highest ALLOCATED one.
    //
    // It had been verified non-vacuous by planting a rollback file and watching it go red. That
    // proved it FIRES. It did not prove its INSTRUCTION was right, and those are separable
    // properties that red-then-green does not distinguish.
    const guard = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), 'localDb.js'),
      'utf8'
    )
    expect(
      guard.includes('getSchemaVersion(db) >= 77 && getSchemaVersion(db) < 78'),
      'the v78 migration guard must stay the one-wide house form `>= 77 && < 78` (localDb.js:3089 states the convention)'
    ).toBe(true)
  })

  it('a fresh insert with no occurrence_id succeeds — NULL is the legitimate whole-run shape', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')"
    ).run()
    expect(() =>
      db
        .prepare('INSERT INTO elective_preferences (id, run_id, camper_id, choice_id, rank) VALUES (?, ?, ?, ?, ?)')
        .run('pref1', 'run1', 'cam1', 'choice1', 1)
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM elective_preferences WHERE id = ?').get('pref1')
    expect(row.occurrence_id).toBeNull()
    db.close()
  })
})
