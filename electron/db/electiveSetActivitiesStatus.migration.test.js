// @vitest-environment node
//
// Migration v68 — elective_set_activities.status (T195, offering-grid
// import). One additive column, default 'confirmed' so every existing row
// keeps today's meaning unchanged. Mirrors electiveCapacity.migration.test.js
// (v39)'s ALTER-added-column shape and rollback pairing.
//
// v67 is RESERVED by unmerged work elsewhere — this file exercises the
// migrated (not just fresh) path per the discipline the v39/v66 tests set:
// the fresh-database path is not evidence about the migrated one.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV68 } from './rollback/v68_down.js'

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
  return openLocalDb(tmpFile('v68-fresh'))
}

// A database migrated fully forward, then hand-reverted to the pre-v68 shape
// (no elective_set_activities.status column), so v68 can be exercised
// against a MIGRATED database rather than only a fresh one.
function preV68Db(tag = 'v68-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE elective_set_activities RENAME TO elective_set_activities_tmp')
  db.exec(`CREATE TABLE elective_set_activities (
    id TEXT PRIMARY KEY,
    elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
    activity_id TEXT NOT NULL,
    camper_headcount INTEGER,
    capacity_mode TEXT NOT NULL DEFAULT 'unlimited'
      CHECK (capacity_mode IN ('unlimited', 'limited')),
    capacity_limit INTEGER
      CHECK (capacity_limit IS NULL
             OR (typeof(capacity_limit) = 'integer' AND capacity_limit >= 0)),
    UNIQUE(elective_set_id, activity_id)
  )`)
  db.exec(`INSERT INTO elective_set_activities
      (id, elective_set_id, activity_id, camper_headcount, capacity_mode, capacity_limit)
    SELECT id, elective_set_id, activity_id, camper_headcount, capacity_mode, capacity_limit
    FROM elective_set_activities_tmp`)
  db.exec('DROP TABLE elective_set_activities_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 68').run()
  return db
}

describe('migration v68: fresh vs migrated equivalence', () => {
  it('declares schema version 68 on a fresh db and adds status', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(70)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 68').get().c).toBe(1)
    expect(db.pragma('table_info(elective_set_activities)').map((c) => c.name)).toContain('status')
    db.close()
  })

  it('migrates a pre-v68 MIGRATED db forward to 68, defaulting existing rows to confirmed', () => {
    const db = preV68Db()
    expect(getSchemaVersion(db)).toBe(67)
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('m1', 'set1', 'act1')"
    ).run()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      db.prepare("SELECT status FROM elective_set_activities WHERE id = 'm1'").get().status
    ).toBe('confirmed')
    db.close()
  })

  it('rejects a status value outside the closed enum', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
    expect(() =>
      db.prepare(
        "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES ('m1', 'set1', 'act1', 'bogus')"
      ).run()
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('is idempotent — re-running v68 does not duplicate the column or lose data', () => {
    const db = preV68Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
    initSchema(db) // runs v68
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES ('m1', 'set1', 'act1', 'potential')"
    ).run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 68').run()
    initSchema(db) // re-run v68
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(elective_set_activities)').filter((c) => c.name === 'status')).toHaveLength(1)
    expect(db.prepare("SELECT status FROM elective_set_activities WHERE id = 'm1'").get().status).toBe('potential')
    db.close()
  })

  it('gives fresh and migrated identical elective_set_activities columns, in the same order', () => {
    const fresh = freshDb()
    const migrated = preV68Db()
    initSchema(migrated)
    const cols = (db) => db.pragma('table_info(elective_set_activities)').map((c) => c.name)
    expect(cols(migrated)).toEqual(cols(fresh))
    expect(cols(fresh)).toEqual([
      'id', 'elective_set_id', 'activity_id', 'camper_headcount',
      'capacity_mode', 'capacity_limit', 'status',
    ])
    fresh.close()
    migrated.close()
  }, 30000)
})

describe('rollbackV68 against a fully-migrated database', () => {
  it('drops status, reporting the discarded potential count, and initSchema re-adds it cleanly', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES ('m1', 'set1', 'act1', 'potential')"
    ).run()

    const result = rollbackV68(db)
    expect(result).toEqual({ potentialOfferings: 1 })
    expect(db.pragma('table_info(elective_set_activities)').some((c) => c.name === 'status')).toBe(false)

    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    // Re-added; the potential/confirmed distinction is genuinely lost, so
    // the row lands back at the default.
    expect(db.prepare("SELECT status FROM elective_set_activities WHERE id = 'm1'").get().status).toBe('confirmed')
    db.close()
  })
})
