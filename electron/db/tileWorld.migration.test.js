// @vitest-environment node
//
// Migration v49 — rename tile_type → kind on `locations` + expand vocabulary.
// v48 added tile_type/grid_x/grid_y; v49 renames tile_type to kind.
//
// Same shape as campMaps.migration.test.js: fresh-vs-migrated equivalence +
// idempotency + column-level assertions + CURRENT_SCHEMA_VERSION canary.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

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
  return openLocalDb(tmpFile('v49-fresh'))
}

// A database at v47 shape (before tile_type/grid_x/grid_y existed).
// When initSchema runs it will apply v48 (add tile_type) then v49 (rename → kind).
function preV48Db(tag = 'v49-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  // Roll back to v47 by recreating locations without the tile-world columns.
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE locations_v47 (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL REFERENCES camps(id),
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      sort_order INTEGER,
      map_geometry TEXT,
      UNIQUE(camp_id, name)
    );
    INSERT INTO locations_v47 SELECT id, camp_id, name, capacity, notes, sort_order, map_geometry FROM locations;
    DROP TABLE locations;
    ALTER TABLE locations_v47 RENAME TO locations;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_camp_name ON locations(camp_id, name);
  `)
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 48').run()
  return db
}

describe('migration v49: kind column on locations', () => {
  it('fresh db at v49 has kind, grid_x, grid_y on locations (no tile_type)', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(locations)').map((c) => c.name)
    expect(cols).toContain('kind')
    expect(cols).toContain('grid_x')
    expect(cols).toContain('grid_y')
    expect(cols).not.toContain('tile_type')
    db.close()
  })

  it('CURRENT_SCHEMA_VERSION is 49', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(50)
  })

  it('fresh db schema_migrations includes version 49', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 49').get().c).toBe(1)
    db.close()
  })

  it('migrated db from v47 ends up with kind, grid_x, grid_y', () => {
    const db = preV48Db()
    expect(getSchemaVersion(db)).toBe(47)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(50)
    const cols = db.pragma('table_info(locations)').map((c) => c.name)
    expect(cols).toContain('kind')
    expect(cols).toContain('grid_x')
    expect(cols).toContain('grid_y')
    expect(cols).not.toContain('tile_type')
    db.close()
  })

  it('existing locations rows survive migration with NULLs in kind, grid_x, grid_y', () => {
    const db = preV48Db('v49-survive')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO locations (id, camp_id, name, capacity) VALUES ('loc1', 'c1', 'Pool', 2)"
    ).run()
    initSchema(db)
    const row = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc1')
    expect(row.kind).toBeNull()
    expect(row.grid_x).toBeNull()
    expect(row.grid_y).toBeNull()
    expect(row.name).toBe('Pool')
    expect(row.capacity).toBe(2)
    db.close()
  })

  it('CHECK constraint rejects kind values outside the enum', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    expect(() => {
      db.prepare(
        "INSERT INTO locations (id, camp_id, name, capacity, kind) VALUES ('loc1', 'c1', 'Pool', 1, 'swamp')"
      ).run()
    }).toThrow()
    db.close()
  })

  it('CHECK constraint allows all valid kind values including classroom and office', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    const validKinds = ['building', 'classroom', 'pool', 'field', 'cabin', 'court', 'nature', 'office', 'generic']
    for (let i = 0; i < validKinds.length; i++) {
      db.prepare(
        `INSERT INTO locations (id, camp_id, name, capacity, kind) VALUES (?, 'c1', ?, 1, ?)`
      ).run(`loc${i}`, `Loc${i}`, validKinds[i])
    }
    const count = db.prepare('SELECT COUNT(*) c FROM locations').get().c
    expect(count).toBe(validKinds.length)
    db.close()
  })

  it('CHECK constraint allows NULL kind', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO locations (id, camp_id, name, capacity, kind) VALUES ('loc1', 'c1', 'Pool', 1, NULL)"
    ).run()
    const row = db.prepare('SELECT kind FROM locations WHERE id = ?').get('loc1')
    expect(row.kind).toBeNull()
    db.close()
  })

  it('is idempotent — re-running v49 does not duplicate columns or rows', () => {
    const db = preV48Db('v49-idempotent')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    initSchema(db)
    db.prepare(
      "INSERT INTO locations (id, camp_id, name, capacity, kind, grid_x, grid_y) VALUES ('loc1', 'c1', 'Pool', 1, 'pool', 3, 5)"
    ).run()
    const countBefore = db.prepare('SELECT COUNT(*) c FROM locations').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 49').run()
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(50)
    expect(db.prepare('SELECT COUNT(*) c FROM locations').get().c).toBe(countBefore)
    const row = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc1')
    expect(row.kind).toBe('pool')
    expect(row.grid_x).toBe(3)
    expect(row.grid_y).toBe(5)
    db.close()
  })
})
