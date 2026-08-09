// @vitest-environment node
//
// Migration v30 — source_aliases, the host-local "this imported label means
// this existing entity" memory.
// docs/adr/2026-08-09-s1b-host-local-aliases.md
//
// Same shape as pendingRestores.migration.test.js (v25): fresh-vs-migrated
// schema equivalence, an exercised rollback, and the LOCAL-ONLY guarantee
// this whole design rests on.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV30 } from './rollback/v30_down.js'
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
  return openLocalDb(tmpFile('v30-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v30-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS source_aliases')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 30').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(source_aliases)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'source_aliases'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_aliases'").get()?.sql

describe('migration v30: source_aliases', () => {
  it('creates the table on a fresh database and declares schema version 30', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 30').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v30 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(29)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical source_aliases columns, indexes and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    // The DDL is written twice — schema.sql and localDb.js's v30 block — and
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
})

describe('source_aliases is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('source_aliases')
    expect(DIRECT_CAMP_ENTITIES.has('source_aliases')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('source_aliases')
    expect(ENTITIES).not.toContain('source_aliases')
  })

  it('is not shipped in the first-pairing full_sync snapshot', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).not.toMatch(/DOMAIN_SNAPSHOT_TABLES[\s\S]{0,600}source_aliases/)
  })

  it('is not present in syncServer.js\'s full-sync payload builder', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncServer.js'),
      'utf8'
    )
    expect(src).not.toMatch(/source_aliases/)
  })
})

describe('rollback v30', () => {
  it('drops the table and the version row, and reports what it discarded', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
    db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run('g1', 'camp1', 'Bunk 1', 'all')
    db.prepare(
      `INSERT INTO source_aliases (id, camp_id, entity_type, cohort_id, source_label, entity_id, status, confirmed_at)
       VALUES ('a1', 'camp1', 'groups', NULL, 'Bunk One', 'g1', 'active', '2026-08-09T00:00:00.000Z')`
    ).run()

    const result = rollbackV30(db)

    expect(result.discardedAliases).toBe(1)
    expect(tableSql(db)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 30').get().c).toBe(0)
    expect(
      db.prepare('SELECT MAX(version) v FROM schema_migrations WHERE version <= 30').get().v
    ).toBe(29)
    db.close()
  })

  it('is idempotent, and re-migrating afterwards restores an identical table', () => {
    const db = freshDb()
    const before = tableSql(db)

    rollbackV30(db)
    rollbackV30(db)
    initSchema(db)

    expect(tableSql(db)).toBe(before)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('leaves the entities the aliases pointed to untouched', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
    db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run('g1', 'camp1', 'Bunk 1', 'all')
    rollbackV30(db)
    expect(db.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(1)
    db.close()
  })
})
