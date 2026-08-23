// @vitest-environment node
//
// Migration v39 — elective_set_activities.camper_headcount (Electives Slice
// 1, ADR docs/adr/2026-08-22-nested-schedules-electives-and-events.md §2,
// design docs/work/specs/2026-08-22-electives-nested-schedule-slices.md
// Slice 1). One additive, nullable column: the per-offering capacity T41
// explicitly deferred. No backfill: every existing offering gets NULL
// (no cap). Mirrors specialDaysNotes.migration.test.js's ALTER-added-column
// shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV39 } from './rollback/v39_down.js'

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
  return openLocalDb(tmpFile('v39-fresh'))
}

// A database migrated fully forward, then rolled back to the v38 shape (no
// elective_set_activities.camper_headcount column), so v39 can be exercised
// against it.
function preV39Db(tag = 'v39-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE elective_set_activities RENAME TO elective_set_activities_tmp')
  db.exec(`CREATE TABLE elective_set_activities (
    id TEXT PRIMARY KEY,
    elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
    activity_id TEXT NOT NULL,
    UNIQUE(elective_set_id, activity_id)
  )`)
  db.exec(`INSERT INTO elective_set_activities (id, elective_set_id, activity_id)
    SELECT id, elective_set_id, activity_id FROM elective_set_activities_tmp`)
  db.exec('DROP TABLE elective_set_activities_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 39').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v39: fresh vs migrated equivalence', () => {
  it('declares schema version 39 on a fresh db and adds camper_headcount', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(41)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 39').get().c).toBe(1)
    expect(db.pragma('table_info(elective_set_activities)').map((c) => c.name)).toContain('camper_headcount')
    db.close()
  })

  it('migrates a pre-v39 db forward to 39', () => {
    const db = preV39Db()
    expect(getSchemaVersion(db)).toBe(38)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical elective_set_activities columns', () => {
    const fresh = freshDb()
    const migrated = preV39Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'elective_set_activities')).toEqual(tableInfo(fresh, 'elective_set_activities'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares elective_set_activities columns in order, camper_headcount last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(elective_set_activities)').map((c) => c.name)).toEqual([
      'id', 'elective_set_id', 'activity_id', 'camper_headcount',
    ])
    db.close()
  })

  it('every existing offering gets NULL camper_headcount — no backfill needed', () => {
    const db = preV39Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('m1', 'set1', 'act1')"
    ).run()
    initSchema(db)
    expect(
      db.prepare("SELECT camper_headcount FROM elective_set_activities WHERE id = 'm1'").get().camper_headcount
    ).toBeNull()
    // No op was written for the migration — a DDL-only change, matching v33-v38's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'elective_set_activities' AND field = 'camper_headcount'"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v39 does not duplicate the column or lose data', () => {
    const db = preV39Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
    initSchema(db) // runs v39
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, camper_headcount) VALUES ('m1', 'set1', 'act1', 12)"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 39').run()
    initSchema(db) // re-run v39
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(elective_set_activities)').filter((c) => c.name === 'camper_headcount')).toHaveLength(1)
    expect(db.prepare("SELECT camper_headcount FROM elective_set_activities WHERE id = 'm1'").get().camper_headcount).toBe(12)
    db.close()
  })
})

describe('rollbackV39', () => {
  it('drops camper_headcount, reporting the discarded count', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, camper_headcount) VALUES ('m1', 'set1', 'act1', 8)"
    ).run()

    const result = rollbackV39(db)
    expect(result).toEqual({ offeringsWithCapacity: 1 })
    expect(
      db.pragma('table_info(elective_set_activities)').some((c) => c.name === 'camper_headcount')
    ).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 39').get().c).toBe(0)
    // The offering row and its other columns survive — only camper_headcount is lost.
    expect(db.prepare("SELECT id FROM elective_set_activities WHERE id = 'm1'").get().id).toBe('m1')
    db.close()
  })
})
