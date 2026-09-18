// @vitest-environment node
//
// Migration v66 (round 7) — drop the op_id -> operations(id) foreign key from
// projection_failures. schema.sql was edited in place (CREATE TABLE IF NOT
// EXISTS is a no-op on any database that already has the table, i.e. every
// database at v55+), so the FK only actually disappears if the v66 migration
// carries a table-rebuild step. This file proves the MIGRATED path, not just
// the fresh one.
//
// Modelled on participantSubstrate.migration.test.js's preV66Db pattern.
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

function freshDb() {
  return openLocalDb(tmpFile('pf-fresh'))
}

// A database migrated fully forward, then reverted BY HAND to the pre-round-7
// v55 shape of projection_failures: op_id REFERENCES operations(id).
function preRound7Db(tag = 'pf-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current, including v66 as it now stands
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE projection_failures RENAME TO projection_failures_old')
  db.exec(`CREATE TABLE projection_failures (
    op_id TEXT PRIMARY KEY REFERENCES operations(id),
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field TEXT NOT NULL,
    error_message TEXT NOT NULL,
    failed_at TEXT NOT NULL,
    resolved_at TEXT,
    store TEXT NOT NULL DEFAULT 'projection'
  )`)
  db.exec(`INSERT INTO projection_failures
    SELECT op_id, entity, entity_id, field, error_message, failed_at, resolved_at, store
    FROM projection_failures_old`)
  db.exec('DROP TABLE projection_failures_old')
  db.pragma('foreign_keys = ON')
  // Undo the round-7 stamp state: schema_migrations still says 66 (this repo
  // has no separate row per in-place edit), but re-running the v66 block is
  // what the round-7 fix must do on databases that already hold 66. Simulate
  // that by rewinding the stamp so initSchema's guard fires again. Rewinds
  // every version >= 66 (not just 66 itself) — v68 (T195) now sits on top,
  // and its guard is `>= 66 && < 68`, so leaving its stamp in place would
  // make getSchemaVersion report 68 and skip BOTH the v66 rebuild and the
  // v68 block below it.
  db.prepare('DELETE FROM schema_migrations WHERE version >= 66').run()
  return db
}

const colNames = (db, table) => db.pragma(`table_info(${table})`).map((c) => c.name)

const fkList = (db, table) => db.pragma(`foreign_key_list(${table})`)

describe('projection_failures op_id FK removal (round 7, v66 rebuild)', () => {
  it('has no op_id FK on a fresh database', () => {
    const db = freshDb()
    expect(fkList(db, 'projection_failures')).toEqual([])
    db.close()
  })

  it('removes the op_id FK from a database migrated forward from the old shape', () => {
    const db = preRound7Db()
    expect(getSchemaVersion(db)).toBe(65)
    // Sanity: the FK is really there before migrating.
    expect(fkList(db, 'projection_failures').length).toBe(1)

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(fkList(db, 'projection_failures')).toEqual([])
    db.close()
  })

  it('lets a document-replay row with an op_id matching no operations row insert after migration', () => {
    const db = preRound7Db()
    initSchema(db)

    expect(() =>
      db
        .prepare(
          `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, store)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'replay:campers:c1:name',
          'campers',
          'c1',
          'name',
          'dropped during full-document replay',
          new Date().toISOString(),
          'document-replay'
        )
    ).not.toThrow()
    db.close()
  })

  it('preserves every pre-existing row, including an unresolved row and a non-default store', () => {
    const db = preRound7Db()
    // Seed pre-migration rows directly, bypassing the old FK: what is under
    // test here is row preservation across the rebuild, not the old FK's
    // enforcement (that's proven by the tests above).
    db.pragma('foreign_keys = OFF')
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, resolved_at, store)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('op-1', 'campers', 'c1', 'name', 'boom', '2026-09-01T00:00:00.000Z', null, 'projection')
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, resolved_at, store)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('op-2', 'campers', 'c2', 'group_id', 'bang', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 'document')
    db.pragma('foreign_keys = ON')

    const before = db.prepare('SELECT * FROM projection_failures ORDER BY op_id').all()
    expect(before.length).toBe(2)

    initSchema(db)

    const after = db.prepare('SELECT * FROM projection_failures ORDER BY op_id').all()
    expect(after).toEqual(before)
    db.close()
  })

  it('gives fresh and migrated identical column order and shape', () => {
    const fresh = freshDb()
    const migrated = preRound7Db()
    initSchema(migrated)
    expect(colNames(migrated, 'projection_failures')).toEqual(colNames(fresh, 'projection_failures'))
    fresh.close()
    migrated.close()
  })

  it('keeps the unresolved index alive after migration (T189 guard)', () => {
    const fresh = freshDb()
    const migrated = preRound7Db()
    initSchema(migrated)
    const indexNames = (db) =>
      db.pragma('index_list(projection_failures)').map((i) => i.name).sort()
    expect(indexNames(migrated)).toEqual(indexNames(fresh))
    expect(indexNames(fresh)).toContain('idx_projection_failures_unresolved')
    fresh.close()
    migrated.close()
  })
})
