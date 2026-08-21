// @vitest-environment node
//
// Migration v36 — durability marker on elective_sets (T110,
// docs/adr/2026-08-20-electives-authoring.md D2 / docs/work/tickets/
// T110-electives-sets-crud-and-durability-marker.md). Adds a single
// nullable-additive column, `is_reusable INTEGER NOT NULL DEFAULT 1`, to the
// existing elective_sets table (v35). Existing rows default to reusable
// (durable) — no behavior change for anything created before this migration.
// Mirrors electron/db/electives.migration.test.js's fresh-vs-migrated shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV36 } from './rollback/v36_down.js'

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
  return openLocalDb(tmpFile('v36-fresh'))
}

// A database migrated fully forward, then rolled back to the v35 shape (no
// elective_sets.is_reusable column), so v36 can be exercised against it.
function preV36Db(tag = 'v36-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE elective_sets RENAME TO elective_sets_tmp')
  db.exec(`CREATE TABLE elective_sets (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    name TEXT NOT NULL,
    sort_order INTEGER,
    UNIQUE(camp_id, name)
  )`)
  db.exec(`INSERT INTO elective_sets (id, camp_id, name, sort_order)
    SELECT id, camp_id, name, sort_order FROM elective_sets_tmp`)
  db.exec('DROP TABLE elective_sets_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 36').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v36: fresh vs migrated equivalence', () => {
  it('declares schema version 36 on a fresh db and gives elective_sets an is_reusable column', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(36)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 36').get().c).toBe(1)
    expect(db.pragma('table_info(elective_sets)').map((c) => c.name)).toContain('is_reusable')
    db.close()
  })

  it('migrates a pre-v36 db forward to 36', () => {
    const db = preV36Db()
    expect(getSchemaVersion(db)).toBe(35)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical elective_sets columns', () => {
    // Unlike v35's new-table case, this column arrives via ALTER TABLE ADD
    // COLUMN on the migrated path — sqlite_master's stored DDL text for an
    // ALTER-modified table is not byte-identical to a fresh CREATE TABLE's
    // (whitespace/formatting differs), so table_info (actual column set,
    // types, defaults) is the meaningful equivalence check here, not raw SQL.
    const fresh = freshDb()
    const migrated = preV36Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'elective_sets')).toEqual(tableInfo(fresh, 'elective_sets'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares elective_sets columns in order, is_reusable last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(elective_sets)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'sort_order', 'is_reusable',
    ])
    db.close()
  })

  it('every existing row defaults to reusable (durable) — no backfill needed, DEFAULT 1 covers it', () => {
    const db = preV36Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Chugim')").run()
    initSchema(db)
    expect(db.prepare("SELECT is_reusable FROM elective_sets WHERE id = 'es1'").get().is_reusable).toBe(1)
    // No op was written for the migration — a DDL-only change, matching v35's posture.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'elective_sets' AND field = 'is_reusable'"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v36 does not duplicate the column or lose data', () => {
    const db = preV36Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('es1', 'camp1', 'Chugim')").run()
    initSchema(db) // runs v36
    db.prepare("UPDATE elective_sets SET is_reusable = 0 WHERE id = 'es1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 36').run()
    initSchema(db) // re-run v36
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      db.pragma('table_info(elective_sets)').filter((c) => c.name === 'is_reusable')
    ).toHaveLength(1)
    // Re-running the migration must not clobber a value a director already set.
    expect(db.prepare("SELECT is_reusable FROM elective_sets WHERE id = 'es1'").get().is_reusable).toBe(0)
    db.close()
  })

  it('schema.sql and localDb.js ELECTIVE_SETS_DDL agree byte-for-byte', async () => {
    const localDbModule = await import('./localDb.js')
    const ddl = localDbModule.ELECTIVE_SETS_DDL
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS elective_sets \([\s\S]*?\n\);/)
    expect(match, 'expected an elective_sets CREATE TABLE block in schema.sql').toBeTruthy()
    const schemaDdl = match[0].replace(/;$/, '')
    expect(schemaDdl).toBe(ddl)
  })
})

describe('rollbackV36', () => {
  it('drops elective_sets.is_reusable and the schema_migrations row, reporting the row count', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO elective_sets (id, camp_id, name, is_reusable) VALUES ('es1', 'camp1', 'Chugim', 0)"
    ).run()

    const result = rollbackV36(db)
    expect(result).toEqual({ electiveSets: 1 })
    expect(
      db.pragma('table_info(elective_sets)').some((c) => c.name === 'is_reusable')
    ).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 36').get().c).toBe(0)
    // The row itself and every other column survive — only the marker is lost.
    expect(db.prepare("SELECT name FROM elective_sets WHERE id = 'es1'").get().name).toBe('Chugim')
    db.close()
  })
})
