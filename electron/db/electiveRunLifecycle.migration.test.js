// @vitest-environment node
//
// Migration v74 (T243, docs/adr/2026-09-23-elective-run-lifecycle-and-
// remaining-slices.md) — two additive, nullable columns on
// elective_assignment_runs (finalized_at, finalized_by) plus a new table,
// elective_run_outer_snapshots. Modeled on electiveCapacity.migration.test.js.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV74 } from './rollback/v74_down.js'

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
  return openLocalDb(tmpFile('v74-fresh'))
}

// A database migrated fully forward, then rolled back to the v73 shape (no
// finalized_at/finalized_by, no elective_run_outer_snapshots table).
function preV74Db(tag = 'v74-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS elective_run_outer_snapshots')
  const cols = db.pragma('table_info(elective_assignment_runs)').map((c) => c.name)
  if (cols.includes('finalized_by')) db.exec('ALTER TABLE elective_assignment_runs DROP COLUMN finalized_by')
  if (cols.includes('finalized_at')) db.exec('ALTER TABLE elective_assignment_runs DROP COLUMN finalized_at')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 74').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v74: fresh vs migrated equivalence', () => {
  it('declares schema version 74 on a fresh db', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(74)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 74').get().c).toBe(1)
    db.close()
  })

  it('a fresh install has finalized_at/finalized_by on elective_assignment_runs', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(elective_assignment_runs)').map((c) => c.name)
    expect(cols).toContain('finalized_at')
    expect(cols).toContain('finalized_by')
    db.close()
  })

  it('a fresh install has elective_run_outer_snapshots with exactly the declared columns', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
    expect(cols).toEqual([
      'id', 'run_id', 'camper_id', 'day_id', 'time_block_id', 'activity_id',
      'activity_name', 'location_id', 'location_name', 'span_blocks', 'solver_generation',
    ])
    db.close()
  })

  it('migrates a pre-v74 db forward to 74', () => {
    const db = preV74Db()
    expect(getSchemaVersion(db)).toBe(72)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    const runCols = db.pragma('table_info(elective_assignment_runs)').map((c) => c.name)
    expect(runCols).toContain('finalized_at')
    expect(runCols).toContain('finalized_by')
    const snapCols = db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
    expect(snapCols).toContain('id')
    db.close()
  })

  it('gives fresh and migrated identical elective_run_outer_snapshots columns AND order', () => {
    const fresh = freshDb()
    const migrated = preV74Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'elective_run_outer_snapshots')).toEqual(
      tableInfo(fresh, 'elective_run_outer_snapshots')
    )
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated identical elective_assignment_runs column SETS (order may differ: ALTER appends)', () => {
    const fresh = freshDb()
    const migrated = preV74Db()
    initSchema(migrated)
    const freshCols = new Set(tableInfo(fresh, 'elective_assignment_runs').map((c) => c.name))
    const migratedCols = new Set(tableInfo(migrated, 'elective_assignment_runs').map((c) => c.name))
    expect(migratedCols).toEqual(freshCols)
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares elective_assignment_runs columns in order, the ALTER-added ones last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(elective_assignment_runs)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'schedule_week_id', 'schedule_template_id', 'tier_id', 'name', 'status',
      'source_filename', 'source_sha256', 'solver_version', 'solver_generation',
      'finalized_at', 'finalized_by',
    ])
    db.close()
  })

  it('is idempotent — re-running v74 does not duplicate columns or the table', () => {
    const db = preV74Db()
    initSchema(db) // runs v74
    db.prepare('DELETE FROM schema_migrations WHERE version >= 74').run()
    initSchema(db) // re-run v74
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      db.pragma('table_info(elective_assignment_runs)').filter((c) => c.name === 'finalized_at')
    ).toHaveLength(1)
    db.close()
  })

  it('every existing run gets NULL finalized_at/finalized_by — no backfill needed', () => {
    const db = preV74Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')"
    ).run()
    initSchema(db)
    const row = db.prepare('SELECT finalized_at, finalized_by FROM elective_assignment_runs WHERE id = ?').get('run1')
    expect(row.finalized_at).toBeNull()
    expect(row.finalized_by).toBeNull()
    db.close()
  })
})

describe('rollbackV74', () => {
  it('is non-destructive — drops the new table/columns only, reports counts, and re-running up restores the same shape', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name, finalized_at, finalized_by) VALUES ('run1', 'camp1', 'Run', '2026-09-23T00:00:00Z', 'user1')"
    ).run()
    db.prepare(
      "INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id) VALUES ('snap1', 'run1', 'camper1')"
    ).run()

    const result = rollbackV74(db)
    expect(result).toEqual({ snapshots: 1, finalizedRuns: 1 })

    expect(db.pragma('table_info(elective_assignment_runs)').some((c) => c.name === 'finalized_at')).toBe(false)
    expect(db.pragma('table_info(elective_assignment_runs)').some((c) => c.name === 'finalized_by')).toBe(false)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='elective_run_outer_snapshots'").get().c
    ).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 74').get().c).toBe(0)
    // The run row itself survives — only the two new columns are lost.
    expect(db.prepare("SELECT id FROM elective_assignment_runs WHERE id = 'run1'").get().id).toBe('run1')

    // Re-running up (initSchema) lands back in the same shape.
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(elective_assignment_runs)').some((c) => c.name === 'finalized_at')).toBe(true)
    db.close()
  })
})
