// @vitest-environment node
//
// Migration v76 (T197, docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-
// export.md) — four additive columns on elective_run_outer_snapshots: cell_kind, choice_id,
// is_linked_choice, choice_label. Modeled directly on electiveRunLifecycle.migration.test.js's v74 file.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV76 } from './rollback/v76_down.js'

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
  return openLocalDb(tmpFile('v76-fresh'))
}

// A database migrated fully forward, then rolled back to the v75 shape (no cell_kind, choice_id,
// is_linked_choice on elective_run_outer_snapshots).
function preV76Db(tag = 'v76-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  const cols = db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
  if (cols.includes('choice_label')) db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN choice_label')
  if (cols.includes('is_linked_choice')) db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN is_linked_choice')
  if (cols.includes('choice_id')) db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN choice_id')
  if (cols.includes('cell_kind')) db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN cell_kind')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 76').run()
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (75, ?)').run(new Date().toISOString())
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v76: fresh vs migrated equivalence', () => {
  it('declares schema version 76 on a fresh db', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(76)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 76').get().c).toBe(1)
    db.close()
  })

  it('a fresh install has exactly the declared elective_run_outer_snapshots columns', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
    expect(cols).toEqual([
      'id', 'run_id', 'camper_id', 'day_id', 'time_block_id', 'activity_id',
      'activity_name', 'location_id', 'location_name', 'span_blocks', 'solver_generation',
      'cell_kind', 'choice_id', 'is_linked_choice', 'choice_label',
    ])
    db.close()
  })

  it('migrates a pre-v76 db forward to 76', () => {
    const db = preV76Db()
    expect(getSchemaVersion(db)).toBe(75)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    const cols = db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
    expect(cols).toContain('cell_kind')
    expect(cols).toContain('choice_id')
    expect(cols).toContain('is_linked_choice')
    expect(cols).toContain('choice_label')
    db.close()
  })

  it('gives fresh and migrated identical elective_run_outer_snapshots columns AND order', () => {
    const fresh = freshDb()
    const migrated = preV76Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'elective_run_outer_snapshots')).toEqual(
      tableInfo(fresh, 'elective_run_outer_snapshots')
    )
    fresh.close()
    migrated.close()
  }, 30000)

  it('cell_kind defaults to elective and is_linked_choice defaults to 0 on insert', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')").run()
    db.prepare(
      "INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id) " +
      "VALUES ('snap1', 'run1', 'camper1', 'day1', 'block1')"
    ).run()
    const row = db.prepare('SELECT cell_kind, is_linked_choice, choice_id FROM elective_run_outer_snapshots WHERE id = ?').get('snap1')
    expect(row).toEqual({ cell_kind: 'elective', is_linked_choice: 0, choice_id: null })
    db.close()
  })

  it('rejects a cell_kind outside the CHECK constraint', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')").run()
    expect(() =>
      db.prepare(
        "INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id, cell_kind) " +
        "VALUES ('snap-bad', 'run1', 'camper1', 'day1', 'block1', 'bogus')"
      ).run()
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('rollbackV76 drops the four columns and the schema_migrations row, non-destructively to v75 shape', () => {
    const db = freshDb()
    const before = rollbackV76(db)
    expect(before).toEqual({ inheritedRows: 0, linkedChoiceRows: 0 })
    expect(getSchemaVersion(db)).toBe(75)
    const cols = db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
    expect(cols).not.toContain('cell_kind')
    expect(cols).not.toContain('choice_id')
    expect(cols).not.toContain('is_linked_choice')
    expect(cols).not.toContain('choice_label')
    db.close()
  })
})
