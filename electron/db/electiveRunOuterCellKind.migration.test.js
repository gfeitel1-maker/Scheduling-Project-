// @vitest-environment node
//
// Migration v76 (T197, docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md)
// adds four columns to elective_run_outer_snapshots, including
//   cell_kind TEXT NOT NULL DEFAULT 'elective' CHECK (cell_kind IN ('elective', 'inherited'))
// a NOT-NULL-with-DEFAULT column — the same shape as the columns that the v73 table-rebuild carry-
// forward fix (docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md) protects
// elsewhere. elective_run_outer_snapshots is NOT one of the nine rebuilt tables, so this is coverage
// proving the defect class is clean here, not a code change: replaying forward through v76 against a
// captured pre-v76 database must apply the DEFAULT to the new column without mangling existing rows.
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

// A fully-migrated db reshaped back to the pre-v76 elective_run_outer_snapshots (no cell_kind /
// choice_id / is_linked_choice / choice_label) and rewound below v76, so v76 can be replayed.
function preV76Db(tag = 'v76-pre') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE elective_run_outer_snapshots RENAME TO eros_tmp')
  db.exec(`CREATE TABLE elective_run_outer_snapshots (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    camper_id TEXT NOT NULL,
    day_id TEXT NOT NULL,
    time_block_id TEXT NOT NULL,
    activity_id TEXT,
    activity_name TEXT,
    location_id TEXT,
    location_name TEXT,
    span_blocks INTEGER,
    solver_generation TEXT
  )`)
  db.exec(`INSERT INTO elective_run_outer_snapshots
    (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name,
     location_id, location_name, span_blocks, solver_generation)
    SELECT id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name,
     location_id, location_name, span_blocks, solver_generation
    FROM eros_tmp`)
  db.exec('DROP TABLE eros_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 76').run()
  return db
}

describe('migration v76: elective_run_outer_snapshots.cell_kind replay', () => {
  it('applies the DEFAULT to cell_kind for a pre-v76 row without mangling its existing data', () => {
    const db = preV76Db()
    expect(getSchemaVersion(db)).toBe(75)
    expect(db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)).not.toContain(
      'cell_kind'
    )

    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, span_blocks)
        VALUES ('s1', 'run1', 'cmp1', 'd1', 'tb1', 'act1', 'Swim', 2)`
    ).run()

    initSchema(db) // replays v76..current

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    const row = db.prepare('SELECT * FROM elective_run_outer_snapshots WHERE id = ?').get('s1')
    // DEFAULT applied to the new NOT NULL column.
    expect(row.cell_kind).toBe('elective')
    expect(row.is_linked_choice).toBe(0)
    expect(row.choice_id).toBeNull()
    expect(row.choice_label).toBeNull()
    // Existing data untouched.
    expect(row.run_id).toBe('run1')
    expect(row.camper_id).toBe('cmp1')
    expect(row.activity_name).toBe('Swim')
    expect(row.span_blocks).toBe(2)
    db.close()
  })

  it('fresh and replayed dbs agree on the elective_run_outer_snapshots column set', () => {
    const fresh = openLocalDb(tmpFile('v76-fresh'))
    const replayed = preV76Db('v76-replayed')
    initSchema(replayed)
    const names = (db) => db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
    expect(names(replayed)).toEqual(names(fresh))
    fresh.close()
    replayed.close()
  }, 30000)

  it('is idempotent — a rewind-and-reopen cycle keeps cell_kind data intact', () => {
    const db = preV76Db('v76-idem')
    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, span_blocks)
        VALUES ('s1', 'run1', 'cmp1', 'd1', 'tb1', 1)`
    ).run()
    initSchema(db) // runs v76
    db.prepare("UPDATE elective_run_outer_snapshots SET cell_kind = 'inherited' WHERE id = 's1'").run()

    db.prepare('DELETE FROM schema_migrations WHERE version >= 76').run()
    initSchema(db) // re-runs v76 — column-presence guard makes it a no-op

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      db.pragma('table_info(elective_run_outer_snapshots)').filter((c) => c.name === 'cell_kind')
    ).toHaveLength(1)
    // A value already set is not clobbered by the re-run.
    expect(db.prepare('SELECT cell_kind FROM elective_run_outer_snapshots WHERE id = ?').get('s1').cell_kind).toBe(
      'inherited'
    )
    db.close()
  })
})
