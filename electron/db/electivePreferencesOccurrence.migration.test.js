// @vitest-environment node
//
// Migration v78 (T265, docs/adr/2026-09-26-per-cell-elective-preferences.md)
// — elective_preferences gains occurrence_id TEXT NOT NULL, a TABLE REBUILD
// (DROP + CREATE), not an ALTER TABLE ADD COLUMN: a NOT NULL column has no
// valid default, and inventing one for existing rows is forbidden (pre-
// production, no live camp data — discard, don't guess). Modelled on
// participantSubstrate.migration.test.js's fresh-vs-migrated shape.
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
// shape (elective_preferences with no occurrence_id column), carrying rows
// that must be discarded by the forward migration.
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
    expect(CURRENT_SCHEMA_VERSION).toBe(78)
    expect(getSchemaVersion(db)).toBe(78)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 78').get().c).toBe(1)
    db.close()
  })

  it('fresh install: elective_preferences has occurrence_id TEXT NOT NULL and the named index', () => {
    const db = freshDb()
    const cols = tableInfo(db, 'elective_preferences')
    const occCol = cols.find((c) => c.name === 'occurrence_id')
    expect(occCol).toBeTruthy()
    expect(occCol.notnull).toBe(1)
    const indexes = db.pragma("index_list(elective_preferences)").map((i) => i.name)
    expect(indexes).toContain('idx_elective_preferences_run_camper_occurrence')
    db.close()
  })

  it('migrates a pre-v78 db forward, discarding existing rows (no valid default) and reports the count', () => {
    const db = preV78Db()
    expect(getSchemaVersion(db)).toBe(74)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c).toBe(1)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(78)
    // The row existing before v78 had no occurrence_id and could not be
    // migrated forward without inventing one — discarded, not carried over.
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c).toBe(0)
    db.close()
  })

  it('post-v78 (migrated): occurrence_id is NOT NULL and the index exists', () => {
    const db = preV78Db()
    initSchema(db)
    const cols = tableInfo(db, 'elective_preferences')
    const occCol = cols.find((c) => c.name === 'occurrence_id')
    expect(occCol).toBeTruthy()
    expect(occCol.notnull).toBe(1)
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

  it('a fresh insert without occurrence_id is refused by the NOT NULL constraint', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')"
    ).run()
    expect(() =>
      db
        .prepare('INSERT INTO elective_preferences (id, run_id, camper_id, choice_id, rank) VALUES (?, ?, ?, ?, ?)')
        .run('pref1', 'run1', 'cam1', 'choice1', 1)
    ).toThrow()
    db.close()
  })
})
