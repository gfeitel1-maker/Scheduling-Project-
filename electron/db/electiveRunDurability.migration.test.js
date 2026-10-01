// T320 (docs/adr/2026-09-30-elective-run-durability.md) — schema v83: two
// additive columns on elective_assignment_runs (snapshot_expected_rows,
// snapshot_digest) and one wholly new table, elective_run_findings.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema, openLocalDb } from './localDb.js'
import { rollbackV83 } from './rollback/v83_down.js'

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

const freshDb = () => openLocalDb(tmpFile('v83-fresh'))
const colNames = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

// Hand-built pre-v83 shape, same discipline as electiveBundles.migration.test.js's
// preV81Db — the forward-migration test must not depend on the down path.
function preV83Db(tag = 'v83-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS elective_run_findings')
  // Recreate elective_assignment_runs without the two v83 columns (SQLite has
  // no DROP COLUMN pre-3.35 semantics this codebase relies on elsewhere, so a
  // recreate-and-copy is the standing pattern for un-adding a column in a test
  // fixture — mirrors v80_down's own concern, applied here to go backward).
  db.exec(`
    CREATE TABLE elective_assignment_runs_old AS SELECT
      id, camp_id, schedule_week_id, schedule_template_id, tier_id, name, status,
      source_filename, source_sha256, solver_version, solver_generation,
      finalized_at, finalized_by
    FROM elective_assignment_runs
  `)
  db.exec('DROP TABLE elective_assignment_runs')
  db.exec('ALTER TABLE elective_assignment_runs_old RENAME TO elective_assignment_runs')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 83').run()
  return db
}

describe('migration v83: version and table/column presence', () => {
  it('declares schema version 83 on a fresh db', () => {
    const db = freshDb()
    // T293 (v84) landed after this file was written. CURRENT_SCHEMA_VERSION/getSchemaVersion
    // track the real current head, same reasoning as electiveRunLifecycle.migration.test.js's
    // "lands at the current schema version" test. The v83-specific row count below is unaffected
    // by that — it is checking that v83's OWN migration landed, not that v83 is the current head.
    expect(CURRENT_SCHEMA_VERSION).toBe(84)
    expect(getSchemaVersion(db)).toBe(84)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 83').get().c).toBe(1)
    db.close()
  })

  it('creates elective_run_findings on a fresh db', () => {
    const db = freshDb()
    expect(hasTable(db, 'elective_run_findings')).toBe(true)
    db.close()
  })

  it('adds the two columns to elective_assignment_runs on a fresh db', () => {
    const db = freshDb()
    expect(colNames(db, 'elective_assignment_runs')).toEqual(
      expect.arrayContaining(['snapshot_expected_rows', 'snapshot_digest'])
    )
    db.close()
  })

  it('migrates a pre-v83 db forward, adding the table and columns', () => {
    const db = preV83Db()
    expect(getSchemaVersion(db)).toBe(82)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasTable(db, 'elective_run_findings')).toBe(true)
    expect(colNames(db, 'elective_assignment_runs')).toEqual(
      expect.arrayContaining(['snapshot_expected_rows', 'snapshot_digest'])
    )
    db.close()
  }, 30000)

  it('gives fresh and migrated identical column sets for elective_run_findings', () => {
    const fresh = freshDb()
    const migrated = preV83Db()
    initSchema(migrated)
    expect(colNames(migrated, 'elective_run_findings')).toEqual(colNames(fresh, 'elective_run_findings'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('elective_run_findings has the expected columns, in order', () => {
    const db = freshDb()
    expect(colNames(db, 'elective_run_findings')).toEqual([
      'id', 'run_id', 'solver_generation', 'kind', 'camper_id', 'choice_id', 'occurrence_id', 'message',
    ])
    db.close()
  })
})

describe('migration v83: rollback round-trip', () => {
  it('rollbackV83 drops elective_run_findings and lowers schema_migrations below 83', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      `INSERT INTO elective_assignment_runs (id, camp_id, name, status)
       VALUES ('run1', 'camp1', 'Run', 'final')`
    ).run()
    db.prepare(
      `INSERT INTO elective_run_findings (id, run_id, solver_generation, kind, message)
       VALUES ('f1', 'run1', 'gen1', 'UNSUPPORTED_LINKED_CHOICE', 'msg')`
    ).run()

    const result = rollbackV83(db)
    expect(result.ok).toBe(true)
    expect(result.discarded.findings).toBe(1)
    expect(hasTable(db, 'elective_run_findings')).toBe(false)
    expect(getSchemaVersion(db)).toBe(82)
    // The two columns stay in place (not dropped) — see v83_down.js's own comment.
    expect(colNames(db, 'elective_assignment_runs')).toEqual(
      expect.arrayContaining(['snapshot_expected_rows', 'snapshot_digest'])
    )
    db.close()
  })
})
