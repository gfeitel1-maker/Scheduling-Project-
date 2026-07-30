// @vitest-environment node
//
// Migration v25 — pending_restores, the Client's durable restore queue.
// docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md
//
// Database/sync task class, so this file carries the two things that class
// requires beyond ordinary unit tests: a fresh-vs-migrated schema equivalence
// check, and an exercised rollback. It also guards the property the whole
// design rests on — that this table is LOCAL ONLY and can never replicate.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV25 } from './rollback/v25_down.js'
import { PROJECTIONS } from '../ops/projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { ENTITIES } from '../auth/permissions.js'

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
  return openLocalDb(tmpFile('v25-fresh'))
}

// A database that reached v25 by MIGRATION rather than by being created at
// it: initSchema first, then hand-regress to the pre-v25 shape, then migrate
// forward. Same method as scheduleKind.migration.test.js's equivalence check.
function migratedDb() {
  const db = new Database(tmpFile('v25-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS pending_restores')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 25').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(pending_restores)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_restores'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_restores'").get()?.sql

describe('migration v25: pending_restores', () => {
  it('creates the table on a fresh database and declares schema version 25', () => {
    const db = freshDb()
    // v25 is applied, whatever the current version has since moved on to.
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 25').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM pending_restores').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v25 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(24)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM pending_restores').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical pending_restores columns, indexes and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    // The DDL is written twice — schema.sql and localDb.js's v25 block — and
    // the two copies can drift silently. sqlite_master stores the original
    // statement text, so this is the only assertion that catches it.
    expect(tableSql(migrated)).toBe(tableSql(fresh))

    // Two implicit indexes: the TEXT primary key and UNIQUE(entity, entity_id).
    // The unique constraint must survive both paths — it is the cheap half of
    // drain idempotency (three offline presses, one intent).
    expect(indexes(fresh).map((i) => i.name)).toEqual([
      'sqlite_autoindex_pending_restores_1',
      'sqlite_autoindex_pending_restores_2',
    ])

    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)
    expect(getSchemaVersion(fresh)).toBe(CURRENT_SCHEMA_VERSION)
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives a fresh db and a migrated db the same whole table set', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    const tables = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)
    expect(tables(migrated)).toEqual(tables(fresh))
    fresh.close()
    migrated.close()
  }, 30000)

  it('collapses repeated requests for the same record into one intent', () => {
    const db = freshDb()
    const insert = () =>
      db
        .prepare(
          `INSERT OR IGNORE INTO pending_restores (pending_id, entity, entity_id, requested_by, requested_at)
           VALUES (?, 'groups', 'g1', 'user1', '2026-07-30T00:00:00.000Z')`
        )
        .run(Math.random().toString())
    insert()
    insert()
    insert()
    expect(db.prepare('SELECT COUNT(*) c FROM pending_restores').get().c).toBe(1)
    db.close()
  })
})

describe('pending_restores is local-only and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    // Three independent mechanisms, each named rather than assumed. Any ONE
    // of these edits would silently turn a local queue into a replicated
    // op-log entity, so each is asserted separately.
    expect(Object.keys(PROJECTIONS)).not.toContain('pending_restores')
    expect(DIRECT_CAMP_ENTITIES.has('pending_restores')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('pending_restores')
    expect(ENTITIES).not.toContain('pending_restores')
  })

  it('is not shipped in the first-pairing full_sync snapshot', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).not.toMatch(/DOMAIN_SNAPSHOT_TABLES[\s\S]{0,600}pending_restores/)
  })
})

describe('rollback v25', () => {
  it('drops the table and the version row, and reports what it discarded', () => {
    const db = freshDb()
    db.prepare(
      `INSERT INTO pending_restores (pending_id, entity, entity_id, requested_by, requested_at)
       VALUES ('p1', 'groups', 'g1', 'user1', '2026-07-30T00:00:00.000Z')`
    ).run()

    const result = rollbackV25(db)

    expect(result.discardedRequests).toBe(1)
    expect(tableSql(db)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 25').get().c).toBe(0)
    // Rolling back v25 leaves later migrations' rows alone, so MAX(version) is
    // not 24 — what this asserts is that nothing at or below 25 survived it.
    expect(
      db.prepare('SELECT MAX(version) v FROM schema_migrations WHERE version <= 25').get().v
    ).toBe(24)
    db.close()
  })

  it('is idempotent, and re-migrating afterwards restores an identical table', () => {
    const db = freshDb()
    const before = tableSql(db)

    rollbackV25(db)
    rollbackV25(db)
    initSchema(db)

    expect(tableSql(db)).toBe(before)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('leaves the op log — where the deleted records actually live — untouched', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device1', 'Device')
    db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, device_id, timestamp)
       VALUES ('op1', 'groups', 'g1', '__deleted__', '1', 'device1', '2026-07-30T00:00:00.000Z')`
    ).run()

    rollbackV25(db)

    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(1)
    db.close()
  })
})
