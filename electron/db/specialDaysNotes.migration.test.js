// @vitest-environment node
//
// Migration v37 — special_days.notes (T106, docs/adr/2026-08-20-special-days-
// authoring-and-day-override-repoint.md D2 / docs/work/tickets/
// T106-special-day-author-ui.md). Adds a single nullable-additive column,
// `notes TEXT`, to the existing special_days table (v34). Existing rows get
// NULL — no behavior change for anything created before this migration.
// Mirrors electron/db/electivesDurability.migration.test.js's fresh-vs-
// migrated shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV37 } from './rollback/v37_down.js'

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
  return openLocalDb(tmpFile('v37-fresh'))
}

// A database migrated fully forward, then rolled back to the v36 shape (no
// special_days.notes column), so v37 can be exercised against it.
function preV37Db(tag = 'v37-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE special_days RENAME TO special_days_tmp')
  db.exec(`CREATE TABLE special_days (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    name TEXT NOT NULL,
    sort_order INTEGER,
    UNIQUE(camp_id, name)
  )`)
  db.exec(`INSERT INTO special_days (id, camp_id, name, sort_order)
    SELECT id, camp_id, name, sort_order FROM special_days_tmp`)
  db.exec('DROP TABLE special_days_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 37').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v37: fresh vs migrated equivalence', () => {
  it('declares schema version 37 on a fresh db and gives special_days a notes column', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(37)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 37').get().c).toBe(1)
    expect(db.pragma('table_info(special_days)').map((c) => c.name)).toContain('notes')
    db.close()
  })

  it('migrates a pre-v37 db forward to 37', () => {
    const db = preV37Db()
    expect(getSchemaVersion(db)).toBe(36)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical special_days columns (byte-identical)', () => {
    const fresh = freshDb()
    const migrated = preV37Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'special_days')).toEqual(tableInfo(fresh, 'special_days'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares special_days columns in order, notes last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(special_days)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'name', 'sort_order', 'notes',
    ])
    db.close()
  })

  it('every existing row gets NULL notes — no backfill needed', () => {
    const db = preV37Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd1', 'camp1', 'Color War')").run()
    initSchema(db)
    expect(db.prepare("SELECT notes FROM special_days WHERE id = 'sd1'").get().notes).toBeNull()
    // No op was written for the migration — a DDL-only change.
    expect(
      db.prepare(
        "SELECT COUNT(*) c FROM operations WHERE entity = 'special_days' AND field = 'notes'"
      ).get().c
    ).toBe(0)
    db.close()
  })

  it('is idempotent — re-running v37 does not duplicate the column or lose data', () => {
    const db = preV37Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd1', 'camp1', 'Color War')").run()
    initSchema(db) // runs v37
    db.prepare("UPDATE special_days SET notes = 'Team A vs Team B' WHERE id = 'sd1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 37').run()
    initSchema(db) // re-run v37
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      db.pragma('table_info(special_days)').filter((c) => c.name === 'notes')
    ).toHaveLength(1)
    // Re-running the migration must not clobber a value a director already typed.
    expect(db.prepare("SELECT notes FROM special_days WHERE id = 'sd1'").get().notes).toBe('Team A vs Team B')
    db.close()
  })

  it('schema.sql and localDb.js SPECIAL_DAYS_DDL agree byte-for-byte', async () => {
    const localDbModule = await import('./localDb.js')
    const ddl = localDbModule.SPECIAL_DAYS_DDL
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS special_days \([\s\S]*?\n\);/)
    expect(match, 'expected a special_days CREATE TABLE block in schema.sql').toBeTruthy()
    const schemaDdl = match[0].replace(/;$/, '')
    expect(schemaDdl).toBe(ddl)
  })
})

describe('rollbackV37', () => {
  it('drops special_days.notes and the schema_migrations row, reporting the row count', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO special_days (id, camp_id, name, notes) VALUES ('sd1', 'camp1', 'Color War', 'Team A vs Team B')"
    ).run()

    const result = rollbackV37(db)
    expect(result).toEqual({ specialDaysWithNotes: 1 })
    expect(
      db.pragma('table_info(special_days)').some((c) => c.name === 'notes')
    ).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 37').get().c).toBe(0)
    // The row itself and every other column survive — only notes is lost.
    expect(db.prepare("SELECT name FROM special_days WHERE id = 'sd1'").get().name).toBe('Color War')
    db.close()
  })
})
