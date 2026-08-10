// @vitest-environment node
//
// Migration v31 — import_evidence, the host-local "why does Shoresh think
// this?" memory behind an import's inferred activity rules / fixed events.
// docs/adr/2026-08-10-ingestion-evidence-persistence.md
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
import { rollbackV31 } from './rollback/v31_down.js'
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
  return openLocalDb(tmpFile('v31-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v31-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS import_evidence')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 31').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(import_evidence)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const indexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'import_evidence'")
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_evidence'").get()?.sql

describe('migration v31: import_evidence', () => {
  it('creates the table on a fresh database and declares schema version 31', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 31').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM import_evidence').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v31 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(30)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM import_evidence').get().c).toBe(0)
    db.close()
  })

  it('is idempotent — re-running initSchema on an already-migrated db changes nothing', () => {
    const db = freshDb()
    initSchema(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM import_evidence').get().c).toBe(0)
    db.close()
  })

  it('leaves other rows untouched by the migration', () => {
    const db = migratedDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM camps').get().c).toBe(1)
    db.close()
  })

  it('gives a fresh db and a migrated db identical import_evidence columns, indexes and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    // The DDL is written twice — schema.sql and localDb.js's v31 block — and
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

describe('import_evidence is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('import_evidence')
    expect(DIRECT_CAMP_ENTITIES.has('import_evidence')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('import_evidence')
    expect(ENTITIES).not.toContain('import_evidence')
  })

  it('is not shipped in the first-pairing full_sync snapshot', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).not.toMatch(/DOMAIN_SNAPSHOT_TABLES[\s\S]{0,600}import_evidence/)
    expect(src).not.toMatch(/import_evidence/)
  })

  it('is not present in syncServer.js\'s full-sync payload builder', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncServer.js'),
      'utf8'
    )
    expect(src).not.toMatch(/import_evidence/)
  })
})

describe('rollback v31', () => {
  it('drops the table and the version row, and reports what it discarded', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
    db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run('g1', 'camp1', 'Bunk 1', 'all')
    db.prepare(
      `INSERT INTO import_evidence (id, camp_id, entity_type, entity_id, field, tag, confidence, support, import_run_id, committed_at)
       VALUES ('e1', 'camp1', 'activities', 'g1', 'min_per_week', 'inferred', 'high', '{}', 'run1', '2026-08-10T00:00:00.000Z')`
    ).run()

    const result = rollbackV31(db)

    expect(result.discardedEvidence).toBe(1)
    expect(tableSql(db)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 31').get().c).toBe(0)
    expect(
      db.prepare('SELECT MAX(version) v FROM schema_migrations WHERE version <= 31').get().v
    ).toBe(30)
    db.close()
  })

  it('is idempotent, and re-migrating afterwards restores an identical table', () => {
    const db = freshDb()
    const before = tableSql(db)

    rollbackV31(db)
    rollbackV31(db)
    initSchema(db)

    expect(tableSql(db)).toBe(before)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('leaves the entities the evidence pointed to untouched', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
    db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run('g1', 'camp1', 'Bunk 1', 'all')
    rollbackV31(db)
    expect(db.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(1)
    db.close()
  })
})
