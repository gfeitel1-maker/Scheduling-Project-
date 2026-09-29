// T301 — rollbackV81 drops the three linked-elective-bundle tables entirely.
// Mirrors v80_down.test.js's shape (named in the ADR's own D9), adapted for
// three wholly new tables dropped outright rather than two columns dropped
// from an existing table.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV81 } from './v81_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v81-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const seed = (db) => {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1', 'camp1', 'Chugim')").run()
  db.prepare(
    "INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES ('bundle1', 'set1', 'act-1', 'Woodworking')"
  ).run()
  db.prepare(
    "INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES ('p1', 'bundle1', 'day-1', 'tb-1')"
  ).run()
  db.prepare(
    "INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES ('t1', 'bundle1', 'tier-1')"
  ).run()
}

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('rollbackV81', () => {
  it('drops all three tables', () => {
    const db = migratedDb()
    seed(db)
    rollbackV81(db)
    expect(hasTable(db, 'elective_bundles')).toBe(false)
    expect(hasTable(db, 'elective_bundle_periods')).toBe(false)
    expect(hasTable(db, 'elective_bundle_tiers')).toBe(false)
    db.close()
  })

  it('leaves elective_sets and its OTHER child (elective_set_activities) untouched — this drops only the three new tables', () => {
    const db = migratedDb()
    seed(db)
    db.prepare(
      "INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES ('esa1', 'set1', 'act-2')"
    ).run()
    rollbackV81(db)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities').get().c).toBe(1)
    db.close()
  })

  // THREE DIFFERENT NUMBERS, so an implementation returning one count for
  // all three (or a hardcoded 1) fails here — mirrors v80_down.test.js's own
  // "the two counts are different numbers" discipline.
  it('reports how many rows of each table were discarded', () => {
    const db = migratedDb()
    seed(db)
    db.prepare(
      "INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES ('bundle2', 'set1', 'act-2', 'Ceramics')"
    ).run()
    expect(rollbackV81(db).discarded).toEqual({ bundles: 2, periods: 1, tierExceptions: 1 })
    db.close()
  })

  // `>= 81`, never `= 81` — a bare equality strands a HIGHER version in the
  // table, leaving getSchemaVersion() reporting it while v81's tables are
  // gone (T220's convention, restated in v81_down.js's own comment).
  it('clears version 81 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (82, ?)')
      .run(new Date().toISOString())
    rollbackV81(db)
    expect(getSchemaVersion(db)).toBe(80)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db)
    rollbackV81(db)
    expect(() => rollbackV81(db)).not.toThrow()
    expect(rollbackV81(db).discarded).toEqual({ bundles: 0, periods: 0, tierExceptions: 0 })
    db.close()
  })

  // Reopening the app re-creates all three tables, empty — the claim the CLI
  // message makes, checked rather than asserted in prose.
  it('lets initSchema re-create all three tables cleanly, empty', () => {
    const db = migratedDb()
    seed(db)
    rollbackV81(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundle_periods').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundle_tiers').get().c).toBe(0)
    db.close()
  }, 30000)
})
