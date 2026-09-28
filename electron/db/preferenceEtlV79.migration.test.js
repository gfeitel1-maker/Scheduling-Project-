// @vitest-environment node
//
// Migration v79 (T279, docs/adr/2026-09-27-elective-preference-etl-canonical-
// record-and-learned-axis-binding.md §12.6 + §13.3) — TWO nullable columns:
// `campers.division_label` (§12.2a, provenance: the division label as written
// on the source file, NEVER an entity reference),
// `elective_preferences.rank_kind` (§4.2/§13.3, what comparing two ranks
// means), and — ROUND 2, OWNER RULING — the COORDINATE columns
// `elective_preferences.coordinate_day_label` / `.coordinate_period_label`.
// Modelled on electivePreferencesOccurrence.migration.test.js's fresh-vs-migrated
// shape.
//
// WHY THE COORDINATE IS STORED AND NOT ONLY THE OCCURRENCE. They are facts about
// different things: the COORDINATE ("Monday, Period 3") is what the CHILD asked
// for, and it is true the moment the sheet is read; the OCCURRENCE is a cell of
// one particular candidate schedule, and it does not exist until a template
// does. Storing only the occurrence meant a spring import — before any schedule
// exists — silently discarded the coordinate, so two cells naming one activity
// merged into one row. That is the T278 defect happening inside the fix for it.
// ADR §3.1 always said the record "names a coordinate, never an occurrence_id";
// storage simply never followed the record.
//
// Both are ALTER TABLE ADD COLUMN, appended LAST, because `campers` is the
// same column-order trap special_days/elective_sets.is_reusable hit: a fresh
// install and a migrated-forward db must produce the IDENTICAL column array,
// order included.
//
// THE PROJECTION ALLOWLIST ASSERTIONS ARE NOT DECORATION. `applyProjection`
// does `if (!projection.fields.includes(op.field)) return` — silently, no
// error, no log (electron/ops/projections.js). A column added without its
// allowlist entry is populated nowhere, with a green gate, so the allowlist is
// part of the migration's contract rather than a separate concern (§13.4).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV79 } from './rollback/v79_down.js'
import { PROJECTIONS } from '../ops/projections.js'

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

const columns = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)

// A database migrated fully forward, then reverted BY HAND to the pre-v79
// shape, carrying rows the forward migration must CARRY FORWARD (both new
// columns NULL) rather than discard.
function preV79Db(tag = 'v79-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE campers')
  db.exec(`CREATE TABLE campers (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    display_name TEXT NOT NULL,
    group_id TEXT,
    external_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  )`)
  db.exec('DROP TABLE elective_preferences')
  db.exec(`CREATE TABLE elective_preferences (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    camper_id TEXT,
    choice_id TEXT,
    rank INTEGER,
    occurrence_id TEXT
  )`)
  db.pragma('foreign_keys = ON')
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare(
    "INSERT INTO campers (id, camp_id, display_name) VALUES ('cam1', 'camp1', 'A Camper')"
  ).run()
  db.prepare(
    "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')"
  ).run()
  db.prepare(
    "INSERT INTO elective_preferences (id, run_id, camper_id, choice_id, rank) VALUES ('pref1', 'run1', 'cam1', 'choice1', 1)"
  ).run()
  db.prepare('DELETE FROM schema_migrations WHERE version >= 79').run()
  return db
}

describe('migration v79 — campers.division_label and elective_preferences.rank_kind', () => {
  it('is the current schema version', () => {
    // Tripwire, per this repo's convention: a peer session taking 79 for
    // something else makes this fail rather than letting two migrations share
    // a number.
    expect(CURRENT_SCHEMA_VERSION).toBe(79)
  })

  it('a fresh database has both columns, each declared LAST on its table', () => {
    const db = openLocalDb(tmpFile('v79-fresh'))
    try {
      const camperCols = columns(db, 'campers')
      // Both v79 camper columns, in ALTER order, appended last.
      expect(camperCols.slice(-2)).toEqual(['division_label', 'is_unattributed'])

      const prefCols = columns(db, 'elective_preferences')
      // All three v79 columns, in ALTER order, appended last.
      expect(prefCols.slice(-3)).toEqual(['rank_kind', 'coordinate_day_label', 'coordinate_period_label'])
    } finally {
      db.close()
    }
  })

  it('migrating a pre-v79 database adds both columns and keeps the existing rows', () => {
    const db = preV79Db()
    try {
      expect(columns(db, 'campers')).not.toContain('division_label')
      expect(columns(db, 'campers')).not.toContain('is_unattributed')
      initSchema(db)

      expect(columns(db, 'campers')).toContain('division_label')
      expect(columns(db, 'campers')).toContain('is_unattributed')
      expect(columns(db, 'elective_preferences')).toContain('rank_kind')
      expect(columns(db, 'elective_preferences')).toContain('coordinate_day_label')
      expect(columns(db, 'elective_preferences')).toContain('coordinate_period_label')
      expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(79)

      // Carried forward, not discarded: NULL is the correct value for a row
      // that predates the concept, not a defect.
      const camper = db.prepare("SELECT * FROM campers WHERE id = 'cam1'").get()
      expect(camper.display_name).toBe('A Camper')
      expect(camper.division_label).toBeNull()
      expect(camper.is_unattributed).toBeNull()
      const pref = db.prepare("SELECT * FROM elective_preferences WHERE id = 'pref1'").get()
      expect(pref.rank).toBe(1)
      expect(pref.rank_kind).toBeNull()
      expect(pref.coordinate_day_label).toBeNull()
      expect(pref.coordinate_period_label).toBeNull()
    } finally {
      db.close()
    }
  })

  it('a migrated database has the IDENTICAL column array to a fresh one, order included', () => {
    const fresh = openLocalDb(tmpFile('v79-fresh-cmp'))
    const migrated = preV79Db('v79-migrated-cmp')
    try {
      initSchema(migrated)
      expect(columns(migrated, 'campers')).toEqual(columns(fresh, 'campers'))
      expect(columns(migrated, 'elective_preferences')).toEqual(columns(fresh, 'elective_preferences'))
    } finally {
      fresh.close()
      migrated.close()
    }
  })

  it('the projection allowlists carry both fields, or every write is silently discarded', () => {
    // §13.4 — this is the assertion that makes the ALTER load-bearing.
    expect(PROJECTIONS.campers.fields).toContain('division_label')
    expect(PROJECTIONS.campers.fields).toContain('is_unattributed')
    expect(PROJECTIONS.elective_preferences.fields).toContain('rank_kind')
    expect(PROJECTIONS.elective_preferences.fields).toContain('coordinate_day_label')
    expect(PROJECTIONS.elective_preferences.fields).toContain('coordinate_period_label')
  })

  it('rollbackV79 removes both columns and un-stamps the version', () => {
    const db = openLocalDb(tmpFile('v79-rollback'))
    try {
      db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
      db.prepare(
        "INSERT INTO campers (id, camp_id, display_name, division_label) VALUES ('cam1', 'camp1', 'A Camper', 'Grades 7-8')"
      ).run()

      // Give every one of the five columns a value, so `discarded` has something to
      // under-report if it goes back to counting two of them.
      db.prepare(
        "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')"
      ).run()
      db.prepare(
        `INSERT INTO elective_preferences
           (id, run_id, camper_id, choice_id, rank, rank_kind, coordinate_day_label, coordinate_period_label)
         VALUES ('p1', 'run1', 'cam1', 'c1', 1, 'cell-choice', 'Monday', 'Period 3')`
      ).run()
      db.prepare("UPDATE campers SET is_unattributed = 1 WHERE id = 'cam1'").run()

      const result = rollbackV79(db)
      expect(result.ok).toBe(true)

      // ASSERTED, because this test used to check `ok` and nothing else while
      // `discarded` silently counted only two of the five columns — and the two it
      // omitted are the ones the module's own header calls "the LOSSIEST part of the
      // rollback". A count that under-reports reads as a complete accounting.
      expect(result.discarded).toEqual({
        divisionLabels: 1,
        unattributedSubjects: 1,
        rankKinds: 1,
        coordinateDayLabels: 1,
        coordinatePeriodLabels: 1,
      })

      expect(columns(db, 'campers')).not.toContain('division_label')
      expect(columns(db, 'elective_preferences')).not.toContain('rank_kind')
      expect(columns(db, 'elective_preferences')).not.toContain('coordinate_day_label')
      expect(columns(db, 'elective_preferences')).not.toContain('coordinate_period_label')
      // The camper survives the rollback — only the column goes.
      expect(db.prepare("SELECT display_name FROM campers WHERE id = 'cam1'").get().display_name).toBe('A Camper')
      expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version >= 79').get().c).toBe(0)
    } finally {
      db.close()
    }
  })
})
