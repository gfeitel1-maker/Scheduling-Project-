// @vitest-environment node
//
// Migration v54 — compound_cell_decisions, the host-local per-camp memory of
// a director's confirmed interpretation of a compound schedule cell.
// docs/adr/2026-09-03-compound-cell-interpretation.md
//
// Same shape as declinedTwoRowSplits.migration.test.js (v47): fresh-vs-migrated
// schema equivalence and the LOCAL-ONLY guarantee this whole design rests on.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
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
  return openLocalDb(tmpFile('v54-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v54-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS compound_cell_decisions')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 54').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(compound_cell_decisions)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'compound_cell_decisions'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compound_cell_decisions'").get()?.sql

describe('migration v54: compound_cell_decisions', () => {
  it('creates the table on a fresh database and declares schema version 54', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 54').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(54)
    expect(db.prepare('SELECT COUNT(*) c FROM compound_cell_decisions').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v54 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(53)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM compound_cell_decisions').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical compound_cell_decisions columns, indexes and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    // The DDL is written twice — schema.sql and localDb.js's v54 block — and
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

  it('is idempotent — re-running v54 on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM compound_cell_decisions').get().c).toBe(0)
    db.close()
  })
})

describe('compound_cell_decisions is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('compound_cell_decisions')
    expect(DIRECT_CAMP_ENTITIES.has('compound_cell_decisions')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('compound_cell_decisions')
    expect(ENTITIES).not.toContain('compound_cell_decisions')
  })

  it('is not shipped in the first-pairing full_sync snapshot', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).not.toMatch(/DOMAIN_SNAPSHOT_TABLES[\s\S]{0,600}compound_cell_decisions/)
  })

  it('is not present in syncServer.js\'s full-sync payload builder', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncServer.js'),
      'utf8'
    )
    expect(src).not.toMatch(/compound_cell_decisions/)
  })
})
