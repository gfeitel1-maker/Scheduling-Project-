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
import { rollbackV73 } from './rollback/v73_down.js'

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
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (73, ?)').run(new Date().toISOString())
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
    expect(CURRENT_SCHEMA_VERSION).toBe(75)
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
    expect(getSchemaVersion(db)).toBe(73)
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

  it('rejects a NULL day_id or time_block_id at the schema level, not only in the derive function', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')"
    ).run()
    expect(() =>
      db.prepare(
        "INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id) " +
        "VALUES ('snap-null-day', 'run1', 'camper1', NULL, 'block1')"
      ).run()
    ).toThrow(/NOT NULL constraint failed/)
    expect(() =>
      db.prepare(
        "INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id) " +
        "VALUES ('snap-null-block', 'run1', 'camper1', 'day1', NULL)"
      ).run()
    ).toThrow(/NOT NULL constraint failed/)
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
      "INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id) " +
      "VALUES ('snap1', 'run1', 'camper1', 'day1', 'block1')"
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

// WHY THIS BLOCK EXISTS. Every case above builds its "migrated" fixture with preV74Db, which
// starts from a database ALREADY at the current (v73) shape and strips v74's own additions back
// off — it never makes the v73 table-rebuild itself run over real rows in the SAME pass as v74.
// The composition of two migrations is a worse hiding place for a defect than either alone: v73's
// rebuild copies activities/elective_sets/etc. by EXPLICIT COLUMN NAME (not `SELECT *`), so a
// column reordered by an earlier ALTER would land in the wrong slot in a fresh-vs-migrated
// comparison without either side's schema-version check ever catching it, and a fresh-install-only
// test can't see it either (both "sides" would be built by the same code). This block instead
// walks a genuinely v72-shaped database (rollbackV73 restores that shape structurally, exercising
// its own by-name rebuild) — seeded with representative rows in the tables v73 rebuilds AND in
// elective_assignment_runs — forward through the REAL v73 rebuild body in localDb.js and then v74,
// in one initSchema() call, and compares the result against a from-zero fresh install.
describe('migration v72->v74 composition: fresh vs a genuinely-migrated database', () => {
  function v72SeededDb(tag) {
    const db = new Database(tmpFile(tag))
    db.pragma('foreign_keys = ON')
    initSchema(db) // fully migrate to current (v74), so schema.sql's tables/indexes all exist
    rollbackV74(db) // -> v73 shape
    rollbackV73(db) // -> v72 shape (real structural rebuild back down; no rows yet, so it cannot refuse)
    expect(getSchemaVersion(db)).toBe(72)

    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp-1', 'Camp One', 'sec')").run()

    // Every activities column gets a distinct, recognizable value so a positional-copy defect
    // (a value landing in its NEIGHBOUR's column) is visible on readback, not just a changed count.
    db.prepare(`
      INSERT INTO activities (
        id, camp_id, name, priority, is_locked, span_blocks, location, is_outdoor,
        max_groups_per_slot, min_per_week, max_per_week, same_tier_only, notes
      ) VALUES (
        'activity-1', 'camp-1', 'Swim', 7, 1, 2, 'Lake', 0,
        3, 4, 5, 1, 'positional-copy canary'
      )
    `).run()

    db.prepare(`
      INSERT INTO elective_sets (id, camp_id, name, sort_order, is_reusable, is_all_groups, group_ids)
      VALUES ('elset-1', 'camp-1', 'Choice A', 9, 0, 1, 'group-9,group-10')
    `).run()

    db.prepare(`
      INSERT INTO elective_assignment_runs (id, camp_id, name, status, source_filename, solver_version)
      VALUES ('run-1', 'camp-1', 'Run One', 'final', 'input.xlsx', 'solver-v1')
    `).run()

    return db
  }

  const REBUILT_TABLES = ['activities', 'elective_sets']
  const T243_TABLES = ['elective_assignment_runs', 'elective_run_outer_snapshots']

  it('lands the genuinely-migrated database at the current schema version, same as fresh', () => {
    const fresh = freshDb()
    const migrated = v72SeededDb('v72-to-74-version')
    initSchema(migrated) // runs the REAL v73 rebuild, then v74, then v75, in one pass

    // The property is "a migrated database ends up where a fresh one is", not
    // "both are at 74" — so the literal moves with every schema bump. Kept as a
    // literal rather than CURRENT_SCHEMA_VERSION on both sides, because
    // comparing two things that are both derived would pass even if the chain
    // stopped stamping entirely. v75 (T266) is the current head.
    expect(getSchemaVersion(fresh)).toBe(75)
    expect(getSchemaVersion(migrated)).toBe(75)

    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated identical table_info — name, type, notnull, dflt_value, pk, AND column order', () => {
    const fresh = freshDb()
    const migrated = v72SeededDb('v72-to-74-shape')
    initSchema(migrated)

    for (const table of [...REBUILT_TABLES, ...T243_TABLES]) {
      expect(tableInfo(migrated, table), `table_info mismatch for ${table}`).toEqual(tableInfo(fresh, table))
    }

    fresh.close()
    migrated.close()
  }, 30000)

  it('leaves the migrated database with a clean PRAGMA foreign_key_check after the composed rebuild', () => {
    const migrated = v72SeededDb('v72-to-74-fk')
    initSchema(migrated)
    expect(migrated.pragma('foreign_key_check')).toEqual([])
    migrated.close()
  }, 30000)

  // THE assertion a column-shape comparison alone would NOT catch: this reads back the actual
  // values, column by column, and checks each one still holds what it was seeded with — not a
  // neighbour's value. A positional `SELECT *`-style copy misaligned by a reordered column would
  // pass every test above (same column set, same row count, same FK graph) and only fail here.
  it('keeps every activities/elective_sets/elective_assignment_runs column value in its own column across the composed rebuild', () => {
    const migrated = v72SeededDb('v72-to-74-values')
    initSchema(migrated)

    const activity = migrated.prepare('SELECT * FROM activities WHERE id = ?').get('activity-1')
    expect(activity.camp_id).toBe('camp-1')
    expect(activity.name).toBe('Swim')
    expect(activity.priority).toBe(7)
    expect(activity.is_locked).toBe(1)
    expect(activity.span_blocks).toBe(2)
    expect(activity.location).toBe('Lake')
    expect(activity.is_outdoor).toBe(0)
    expect(activity.max_groups_per_slot).toBe(3)
    expect(activity.min_per_week).toBe(4)
    expect(activity.max_per_week).toBe(5)
    expect(activity.same_tier_only).toBe(1)
    expect(activity.notes).toBe('positional-copy canary')

    const elset = migrated.prepare('SELECT * FROM elective_sets WHERE id = ?').get('elset-1')
    expect(elset.camp_id).toBe('camp-1')
    expect(elset.name).toBe('Choice A')
    expect(elset.sort_order).toBe(9)
    expect(elset.is_reusable).toBe(0)
    expect(elset.is_all_groups).toBe(1)
    expect(elset.group_ids).toBe('group-9,group-10')

    const run = migrated.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get('run-1')
    expect(run.camp_id).toBe('camp-1')
    expect(run.name).toBe('Run One')
    expect(run.status).toBe('final')
    expect(run.source_filename).toBe('input.xlsx')
    expect(run.solver_version).toBe('solver-v1')
    // v74's own additive columns: a legacy run migrates forward with both NULL, per the ADR.
    expect(run.finalized_at).toBeNull()
    expect(run.finalized_by).toBeNull()

    migrated.close()
  }, 30000)
})
