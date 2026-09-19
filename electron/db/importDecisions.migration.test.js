// @vitest-environment node
//
// Migration v63 — import_decisions, the host-local journal of what the
// importer asked and what the director did about it (T173 slice 1).
// docs/superpowers/specs/2026-09-15-seedlings-importer-learning-design.md
//
// Same shape as compoundCellDecisions.migration.test.js (v54): fresh-vs-
// migrated schema equivalence and the LOCAL-ONLY guarantee this design rests on.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { PROJECTIONS } from '../ops/projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { ENTITIES } from '../auth/permissions.js'
import { MODELED_ENTITIES } from '../automerge/campDocument.js'

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
  return openLocalDb(tmpFile('v63-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v63-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS import_decisions')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 63').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(import_decisions)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'import_decisions'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_decisions'").get()?.sql

describe('migration v63: import_decisions', () => {
  it('creates the table on a fresh database and declares schema version 63', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 63').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(71)
    expect(db.prepare('SELECT COUNT(*) c FROM import_decisions').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v63 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(62)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM import_decisions').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical import_decisions columns, indexes and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    // The DDL is written twice — schema.sql and localDb.js's v63 block — and
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

  it('is idempotent — re-running v63 on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM import_decisions').get().c).toBe(0)
    db.close()
  })
})

describe('import_decisions is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('import_decisions')
    expect(DIRECT_CAMP_ENTITIES.has('import_decisions')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('import_decisions')
    expect(ENTITIES).not.toContain('import_decisions')
    expect(MODELED_ENTITIES.has('import_decisions')).toBe(false)
  })
})
