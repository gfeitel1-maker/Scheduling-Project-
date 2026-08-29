// @vitest-environment node
//
// Migration v47 — declined_two_row_splits, the host-local "director said no
// to this split suggestion" memory.
// docs/adr/2026-08-23-two-rows-multipattern-split.md
// docs/work/specs/2026-08-23-two-rows-slice2-affordance.md "Decline-memory"
//
// Same shape as sourceAliases.migration.test.js (v30): fresh-vs-migrated
// schema equivalence, an exercised rollback, and the LOCAL-ONLY guarantee
// this whole design rests on.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV47 } from './rollback/v47_down.js'
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
  return openLocalDb(tmpFile('v47-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v47-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS declined_two_row_splits')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 47').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(declined_two_row_splits)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'declined_two_row_splits'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'declined_two_row_splits'").get()?.sql

describe('migration v47: declined_two_row_splits', () => {
  it('creates the table on a fresh database and declares schema version 47', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 47').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(52)
    expect(db.prepare('SELECT COUNT(*) c FROM declined_two_row_splits').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v47 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(46)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM declined_two_row_splits').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical declined_two_row_splits columns, indexes and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    // The DDL is written twice — schema.sql and localDb.js's v47 block — and
    // the two copies can drift silently. sqlite_master stores the original
    // statement text, so this is the only assertion that catches it.
    expect(tableSql(migrated)).toBe(tableSql(fresh))

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

  it('is idempotent — re-running v47 on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM declined_two_row_splits').get().c).toBe(0)
    db.close()
  })
})

describe('declined_two_row_splits is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('declined_two_row_splits')
    expect(DIRECT_CAMP_ENTITIES.has('declined_two_row_splits')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('declined_two_row_splits')
    expect(ENTITIES).not.toContain('declined_two_row_splits')
  })

  it('is not shipped in the first-pairing full_sync snapshot', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).not.toMatch(/DOMAIN_SNAPSHOT_TABLES[\s\S]{0,600}declined_two_row_splits/)
  })

  it('is not present in syncServer.js\'s full-sync payload builder', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncServer.js'),
      'utf8'
    )
    expect(src).not.toMatch(/declined_two_row_splits/)
  })
})

describe('rollback v47', () => {
  it('drops the table and the version row, and reports what it discarded', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
    db.prepare(
      `INSERT INTO declined_two_row_splits (id, camp_id, activity_name_normalized, declined_at)
       VALUES ('d1', 'camp1', 'swim', '2026-08-23T00:00:00.000Z')`
    ).run()

    const result = rollbackV47(db)

    expect(result.discardedDeclines).toBe(1)
    expect(tableSql(db)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 47').get().c).toBe(0)
    expect(
      db.prepare('SELECT MAX(version) v FROM schema_migrations WHERE version <= 47').get().v
    ).toBe(46)
    db.close()
  })

  it('is idempotent, and re-migrating afterwards restores an identical table', () => {
    const db = freshDb()
    const before = tableSql(db)

    rollbackV47(db)
    rollbackV47(db)
    initSchema(db)

    expect(tableSql(db)).toBe(before)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('leaves the activities the declines pointed to untouched', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
    db.prepare(
      `INSERT INTO activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Swim')`
    ).run()
    db.prepare(
      `INSERT INTO declined_two_row_splits (id, camp_id, activity_name_normalized, declined_at)
       VALUES ('d1', 'camp1', 'swim', '2026-08-23T00:00:00.000Z')`
    ).run()
    rollbackV47(db)
    expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(1)
    db.close()
  })
})
