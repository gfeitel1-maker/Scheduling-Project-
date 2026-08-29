// @vitest-environment node
//
// Migration v52 — open_reconciliation_decisions, the host-local journal of
// still-unresolved reconciliation decisions.
// docs/adr/2026-08-28-persisted-reconciliation-decisions.md
//
// Same shape as sourceAliases.migration.test.js (v30): fresh-vs-migrated
// schema equivalence, plus the host-local sync-absence guarantees.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { PROJECTIONS } from '../ops/projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'

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
  return openLocalDb(tmpFile('v52-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v52-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS open_reconciliation_decisions')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 52').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(open_reconciliation_decisions)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'open_reconciliation_decisions'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'open_reconciliation_decisions'").get()?.sql

describe('migration v52: open_reconciliation_decisions', () => {
  it('creates the table on a fresh database and declares schema version 52', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 52').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM open_reconciliation_decisions').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v52 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(51)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM open_reconciliation_decisions').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical columns, indexes and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    expect(indexes(migrated)).toEqual(indexes(fresh))
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

describe('open_reconciliation_decisions is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('open_reconciliation_decisions')
    expect(DIRECT_CAMP_ENTITIES.has('open_reconciliation_decisions')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('open_reconciliation_decisions')
  })

  it('is not shipped in the first-pairing full_sync snapshot', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).not.toMatch(/DOMAIN_SNAPSHOT_TABLES[\s\S]{0,600}open_reconciliation_decisions/)
  })

  it('is not present in syncServer.js\'s full-sync payload builder', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncServer.js'),
      'utf8'
    )
    expect(src).not.toMatch(/open_reconciliation_decisions/)
  })
})
