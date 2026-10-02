// q-elective-finding-id-collision-rekey-safe — rollbackV87 drops
// elective_run_findings.label_key. Mirrors v79_down.test.js's shape (the
// closest template: a plain single-column ALTER DROP COLUMN, no table rebuild).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV87 } from './v87_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v87-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const hasColumn = (db, table, column) =>
  db.pragma(`table_info(${table})`).some((c) => c.name === column)

const seed = (db, labelKey) => {
  db.prepare(
    `INSERT INTO elective_run_findings (id, run_id, solver_generation, kind, camper_id, choice_id, occurrence_id, message, label_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('finding-1', 'run-1', 'gen-1', 'BUNDLE_TIER_NOT_COVERED', 'camper-1', null, null, 'msg', labelKey)
}

describe('rollbackV87', () => {
  it('drops elective_run_findings.label_key', () => {
    const db = migratedDb()
    seed(db, 'archery')
    rollbackV87(db)
    expect(hasColumn(db, 'elective_run_findings', 'label_key')).toBe(false)
    db.close()
  })

  it('reports how many non-null label_key values were discarded', () => {
    const db = migratedDb()
    seed(db, 'archery')
    db.prepare(
      `INSERT INTO elective_run_findings (id, run_id, solver_generation, kind, camper_id, choice_id, occurrence_id, message, label_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('finding-2', 'run-1', 'gen-1', 'BUNDLE_TIER_NOT_COVERED', 'camper-1', null, null, 'msg', 'gaga')
    db.prepare(
      `INSERT INTO elective_run_findings (id, run_id, solver_generation, kind, camper_id, choice_id, occurrence_id, message, label_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('finding-3', 'run-1', 'gen-1', 'SHEET_CAMPER_WITHOUT_PREFERENCE', 'camper-2', null, null, 'msg', null)
    expect(rollbackV87(db).discarded).toEqual({ labelKeys: 2 })
    db.close()
  })

  // `>= 87`, never `= 87` — a bare equality strands a HIGHER version in the
  // table (bareEqualityRollback.guard.test.js's class).
  it('clears version 87 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db, 'archery')
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (88, ?)')
      .run(new Date().toISOString())
    rollbackV87(db)
    expect(getSchemaVersion(db)).toBe(86)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db, 'archery')
    rollbackV87(db)
    expect(() => rollbackV87(db)).not.toThrow()
    expect(rollbackV87(db).discarded).toEqual({ labelKeys: 0 })
    db.close()
  })

  it('lets initSchema re-create the column, empty', () => {
    const db = migratedDb()
    seed(db, 'archery')
    rollbackV87(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasColumn(db, 'elective_run_findings', 'label_key')).toBe(true)
    db.close()
  }, 30000)
})
