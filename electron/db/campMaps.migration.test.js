// @vitest-environment node
//
// Migration v33 — the optional camp map (M6).
// docs/adr/2026-08-16-locations-optional-map.md
//
// Same shape as locations.migration.test.js's fresh-vs-migrated section: no
// backfill here (camp_maps starts empty on every camp, INV-4 — "optional in
// every respect"), so this file is fresh-vs-migrated equivalence + an
// idempotency twin, not a backfill-correctness suite.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV32 } from './rollback/v32_down.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
  return openLocalDb(tmpFile('v33-fresh'))
}

// A database rolled back to the v32 shape: no camp_maps table, so v33 can be
// exercised against it.
function preV33Db(tag = 'v33-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS camp_maps')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 33').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql

describe('migration v33: fresh vs migrated equivalence', () => {
  it('creates camp_maps on a fresh db and declares schema version 33', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 33').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM camp_maps').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v33 db forward to 33', () => {
    const db = preV33Db()
    expect(getSchemaVersion(db)).toBe(32)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical camp_maps columns and DDL', () => {
    const fresh = freshDb()
    const migrated = preV33Db()
    initSchema(migrated)

    expect(tableInfo(migrated, 'camp_maps')).toEqual(tableInfo(fresh, 'camp_maps'))
    // sqlite_master stores the original CREATE TABLE text — the only check
    // that catches a byte-level drift between schema.sql and localDb.js.
    expect(tableSql(migrated, 'camp_maps')).toBe(tableSql(fresh, 'camp_maps'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares every camp_maps column from the CREATE TABLE — no ALTER-added column, no column-order trap', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(camp_maps)').map((c) => c.name)
    expect(cols).toEqual(['id', 'camp_id', 'image_data', 'image_mime', 'image_width', 'image_height', 'kind'])
    db.close()
  })

  it('gives fresh and migrated the same whole table set', () => {
    const fresh = freshDb()
    const migrated = preV33Db()
    initSchema(migrated)
    const tables = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    expect(tables(migrated)).toEqual(tables(fresh))
    expect(tables(fresh)).toContain('camp_maps')
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v33 does not duplicate the table or rows', () => {
    const db = preV33Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    initSchema(db) // runs v33
    db.prepare("INSERT INTO camp_maps (id, camp_id) VALUES ('camp1', 'camp1')").run()
    const firstCount = db.prepare('SELECT COUNT(*) c FROM camp_maps').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 33').run()
    initSchema(db) // re-run v33
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM camp_maps').get().c).toBe(firstCount)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='camp_maps'").get().c
    ).toBe(1)
    db.close()
  })

  it('no backfill — camp_maps starts empty on every existing camp (INV-4, optional in every respect)', () => {
    const db = preV33Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM camp_maps').get().c).toBe(0)
    // No op was written for the migration — a DDL-only change.
    expect(
      db.prepare("SELECT COUNT(*) c FROM operations WHERE entity='camp_maps'").get().c
    ).toBe(0)
    db.close()
  })

  it('schema.sql and localDb.js CAMP_MAPS_DDL agree byte-for-byte (guarded independently of the DB check above)', async () => {
    const { CAMP_MAPS_DDL } = await import('./localDb.js')
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    // Extract the CREATE TABLE camp_maps (...) block from schema.sql and
    // normalize trailing semicolon/whitespace so the comparison is purely
    // about the DDL body, matching CAMP_MAPS_DDL's own un-terminated form.
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS camp_maps \([\s\S]*?\n\);/)
    expect(match, 'expected a camp_maps CREATE TABLE block in schema.sql').toBeTruthy()
    const schemaDdl = match[0].replace(/;$/, '')
    expect(schemaDdl).toBe(CAMP_MAPS_DDL)
  })
})

// Code Reviewer LOW (M6 fix round): v32_down.js's own comment claims a
// locations-only rollback leaves camp_maps' data untouched (it FKs to camps
// only, has no structural dependency on locations, and the script never
// drops the camp_maps table) — nothing pinned that claim. This asserts it
// against a camp_maps row carrying REAL image_data, not just an empty
// singleton row (an empty row surviving would prove far less).
describe('rollback v32 does not touch camp_maps (M6, v33 is independent of locations)', () => {
  it('a camp_maps row with real image_data survives rollbackV32() untouched', () => {
    const db = preV33Db('v33-rollback-untouched')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    initSchema(db) // runs v33, creating camp_maps
    db.prepare(
      'INSERT INTO camp_maps (id, camp_id, image_data, image_mime, image_width, image_height) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('camp1', 'camp1', 'fake-base64-jpeg-bytes', 'image/jpeg', 800, 600)

    rollbackV32(db)

    expect(tableSql(db, 'camp_maps')).toBeTruthy()
    const row = db.prepare('SELECT * FROM camp_maps WHERE id = ?').get('camp1')
    expect(row).toEqual({
      id: 'camp1', camp_id: 'camp1', image_data: 'fake-base64-jpeg-bytes',
      image_mime: 'image/jpeg', image_width: 800, image_height: 600, kind: null,
    })
    db.close()
  })
})
