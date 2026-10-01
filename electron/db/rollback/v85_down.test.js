// T321 — rollbackV85 drops camper_identity_keys. Mirrors v81_down.test.js's
// shape (the closest template: a wholly new, additive table).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV85 } from './v85_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v85-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const seed = (db) => {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare(
    "INSERT INTO campers (id, camp_id, display_name) VALUES ('camper2:abc', 'camp1', 'Ari Green')"
  ).run()
  db.prepare(
    "INSERT INTO camper_identity_keys (id, camp_id, key_mode, key_value, camper_id) " +
    "VALUES ('key1', 'camp1', 'name', 'ari green', 'camper2:abc')"
  ).run()
}

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('rollbackV85', () => {
  it('drops camper_identity_keys', () => {
    const db = migratedDb()
    seed(db)
    rollbackV85(db)
    expect(hasTable(db, 'camper_identity_keys')).toBe(false)
    db.close()
  })

  it('leaves campers untouched — this drops only the new table', () => {
    const db = migratedDb()
    seed(db)
    rollbackV85(db)
    expect(db.prepare('SELECT COUNT(*) c FROM campers').get().c).toBe(1)
    db.close()
  })

  it('reports how many rows were discarded', () => {
    const db = migratedDb()
    seed(db)
    db.prepare(
      "INSERT INTO camper_identity_keys (id, camp_id, key_mode, key_value, camper_id) " +
      "VALUES ('key2', 'camp1', 'ext', 'CM-1', 'camper2:def')"
    ).run()
    expect(rollbackV85(db).discarded).toEqual({ keys: 2 })
    db.close()
  })

  // `>= 85`, never `= 85` — a bare equality strands a HIGHER version in the
  // table (bareEqualityRollback.guard.test.js's class).
  it('clears version 85 and anything above it from schema_migrations', () => {
    const db = migratedDb()
    seed(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (86, ?)')
      .run(new Date().toISOString())
    rollbackV85(db)
    expect(getSchemaVersion(db)).toBe(84)
    db.close()
  })

  it('is a no-op on a database that has already been rolled back', () => {
    const db = migratedDb()
    seed(db)
    rollbackV85(db)
    expect(() => rollbackV85(db)).not.toThrow()
    expect(rollbackV85(db).discarded).toEqual({ keys: 0 })
    db.close()
  })

  // NOT empty, deliberately: `campers` itself is untouched by the rollback (point
  // 5 above), so re-running the v85 migration's back-fill legitimately re-derives
  // the same lookup row from the surviving camper — this is the mechanism working
  // correctly, not a leftover. A camper added fresh on this device while the table
  // was gone (no campers row above) would get nothing re-created here.
  it('lets initSchema re-create the table, re-backfilled from the surviving campers row', () => {
    const db = migratedDb()
    seed(db)
    rollbackV85(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM camper_identity_keys').get().c).toBe(1)
    expect(db.prepare('SELECT camper_id FROM camper_identity_keys').get().camper_id).toBe('camper2:abc')
    db.close()
  }, 30000)
})
