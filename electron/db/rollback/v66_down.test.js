// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV66 } from './v66_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v66down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

const TABLES = [
  'campers',
  'elective_assignment_runs',
  'elective_occurrences',
  'elective_choices',
  'elective_choice_offerings',
  'elective_preferences',
  'elective_assignments',
]

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

function seed(db) {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1','camp1','Chugim')").run()
  db.prepare(
    "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, camper_headcount, capacity_mode, capacity_limit) VALUES ('m1','set1','act1',12,'limited',12)"
  ).run()
  db.prepare(
    "INSERT INTO campers (id, camp_id, display_name) VALUES ('c1','camp1','A Child')"
  ).run()
  db.prepare(
    "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('r1','camp1','Week 1')"
  ).run()
  db.prepare("INSERT INTO elective_occurrences (id, run_id) VALUES ('o1','r1')").run()
  db.prepare("INSERT INTO elective_choices (id, run_id, label) VALUES ('ch1','r1','Swim')").run()
  db.prepare(
    "INSERT INTO elective_choice_offerings (id, choice_id, occurrence_id) VALUES ('co1','ch1','o1')"
  ).run()
  db.prepare(
    "INSERT INTO elective_preferences (id, run_id, camper_id, choice_id, rank) VALUES ('p1','r1','c1','ch1',1)"
  ).run()
  db.prepare(
    "INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id) VALUES ('a1','r1','o1','c1')"
  ).run()
}

describe('rollbackV66', () => {
  it('drops all seven tables under foreign_keys = ON', () => {
    const db = freshDb()
    seed(db)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    rollbackV66(db)
    for (const t of TABLES) expect(hasTable(db, t), `${t} survived rollback`).toBe(false)
    db.close()
  })

  it('reports the discarded PII counts BEFORE destroying them', () => {
    const db = freshDb()
    seed(db)
    expect(rollbackV66(db)).toEqual({
      campers: 1,
      electivePreferences: 1,
      electiveAssignments: 1,
    })
    db.close()
  })

  it('drops the two capacity columns and leaves camper_headcount and status intact', () => {
    const db = freshDb()
    seed(db)
    rollbackV66(db)
    // status (v68, T195) is a LATER migration's column, untouched by rolling
    // back v66 — rollbackV66 only ever claimed to undo v66's own two
    // capacity columns.
    const cols = db.pragma('table_info(elective_set_activities)').map((c) => c.name)
    expect(cols).toEqual(['id', 'elective_set_id', 'activity_id', 'camper_headcount', 'status'])
    // The one piece of good news: authored capacity is re-derivable.
    expect(
      db.prepare("SELECT camper_headcount FROM elective_set_activities WHERE id='m1'").get()
        .camper_headcount
    ).toBe(12)
    db.close()
  })

  // v68 (T195) now sits on top of v66 on a fresh db, which is what first
  // exercised rollbackV66's CASCADING contract. `v66_down.js:87` deletes
  // `WHERE version >= 66`, not `= 66` — this repo's convention since v46_down
  // and stated in PLATFORM_STATE. A bare equality would strand every HIGHER
  // version in the table, leaving getSchemaVersion() reporting 68 while v66's
  // tables are gone: a shape no migration path can produce and none will
  // repair.
  //
  // Re-migrating afterwards is safe because both stacked migrations are
  // idempotent — v67 guards with CREATE TABLE IF NOT EXISTS (so the device's
  // identity key survives; only the TOFU peer bindings re-null), and v68
  // guards with a `hasStatus` pragma check before ADD COLUMN.
  //
  // This test previously asserted the OPPOSITE — that the v68 row survived —
  // while also asserting the resulting version was 65. Those cannot both be
  // true, and its comment stated as fact that rollbackV66 deletes only
  // `= 66`. It was written against semantics this file has not had since
  // v46_down, and is corrected here rather than flipped, so the convention is
  // not quietly reversed by whoever last ran the suite.
  it('cascades: its own row AND every higher version row are removed', () => {
    const db = freshDb()
    seed(db)
    rollbackV66(db)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 66').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 68').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version >= 66').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(65)
    db.close()
  })

  it('is idempotent', () => {
    const db = freshDb()
    seed(db)
    rollbackV66(db)
    expect(() => rollbackV66(db)).not.toThrow()
    expect(rollbackV66(db)).toEqual({ campers: 0, electivePreferences: 0, electiveAssignments: 0 })
    expect(getSchemaVersion(db)).toBe(65)
    db.close()
  })

  it('does NOT touch the op-log — a rollback is not a purge', () => {
    const db = freshDb()
    seed(db)
    const before = db.prepare('SELECT COUNT(*) c FROM operations').get().c
    rollbackV66(db)
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(before)
    db.close()
  })
})
