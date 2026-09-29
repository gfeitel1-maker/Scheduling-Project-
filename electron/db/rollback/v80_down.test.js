// T265 — rollbackV80 drops the two minimum-headcount columns.
//
// WHY THIS FILE EXISTS AT ALL, when v75/v76/v77/v79_down have no test: the
// COUNTING is the part that went wrong last time. v78_down counted collisions
// with `COUNT(DISTINCT occurrence_id) > 1`, and because SQLite never counts NULL
// in COUNT(DISTINCT), a fallback row plus a scoped row evaluated to 1 and the
// rollback would have silently collapsed two legitimately distinct rows. The
// report a director reads is load-bearing, so the two counts here are pinned
// against rows that distinguish them.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV80 } from './v80_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v80-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const seed = (db) => {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
  const add = (id, mode, value) =>
    db.prepare(
      `INSERT INTO elective_set_activities (id, elective_set_id, activity_id, min_mode, min_to_run)
       VALUES (?, 'set1', ?, ?, ?)`
    ).run(id, `act-${id}`, mode, value)
  add('enforced-a', 'required', 5)
  add('enforced-b', 'required', 2)
  // A leftover value under mode 'none' — a minimum a director set and cleared.
  // It is a STATED value but not an ENFORCED one, which is what separates the
  // two counts the report gives.
  add('inert', 'none', 9)
  add('plain', 'none', null)
}

describe('rollbackV80', () => {
  it('drops both minimum columns and leaves every earlier column intact', () => {
    const db = migratedDb()
    seed(db)
    rollbackV80(db)
    // status (v68) and the v66 capacity pair are EARLIER migrations' columns,
    // untouched — rollbackV80 only ever claimed to undo v80's own two.
    expect(db.pragma('table_info(elective_set_activities)').map((c) => c.name)).toEqual([
      'id', 'elective_set_id', 'activity_id', 'camper_headcount',
      'capacity_mode', 'capacity_limit', 'status',
    ])
    db.close()
  })

  // THE TWO COUNTS ARE DIFFERENT NUMBERS, and the fixture is built so that an
  // implementation reporting one of them for both fails here. Two rows enforce a
  // minimum; three hold a non-NULL value (one of them inert under mode 'none').
  it('reports the enforced minimums and the stated values separately', () => {
    const db = migratedDb()
    seed(db)
    expect(rollbackV80(db).discarded).toEqual({ requiredMinimums: 2, statedValues: 3 })
    db.close()
  })

  it('keeps the offerings themselves — this drops columns, not rows', () => {
    const db = migratedDb()
    seed(db)
    rollbackV80(db)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities').get().c).toBe(4)
    db.close()
  })

  // `>= 80`, never `= 80`. A bare equality strands a HIGHER version in the table,
  // leaving getSchemaVersion() reporting it while v80's columns are gone — a
  // shape no migration path can produce and none will repair.
  it('clears version 80 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (81, ?)')
      .run(new Date().toISOString())
    rollbackV80(db)
    expect(getSchemaVersion(db)).toBe(79)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db)
    rollbackV80(db)
    expect(() => rollbackV80(db)).not.toThrow()
    expect(rollbackV80(db).discarded).toEqual({ requiredMinimums: 0, statedValues: 0 })
    db.close()
  })

  // Reopening the app re-adds both columns, empty — the claim the CLI message
  // makes, checked rather than asserted in prose.
  it('lets initSchema re-add both columns cleanly, with no minimum set', () => {
    const db = migratedDb()
    seed(db)
    rollbackV80(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(80)
    const rows = db.prepare('SELECT min_mode, min_to_run FROM elective_set_activities').all()
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.min_mode === 'none' && r.min_to_run === null)).toBe(true)
    db.close()
  }, 30000)
})
