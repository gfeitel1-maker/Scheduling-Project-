// @vitest-environment node
//
// Migration v48 — tile world placement columns on `locations`.
// docs/work/specs/2026-08-25-tile-world-day-map.md §4
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
  return openLocalDb(tmpFile('v48-fresh'))
}

// A database at v47 shape: fully migrated then rolled back to just before v48.
function preV48Db(tag = 'v48-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current (v48)
  // Roll back v48 by dropping the three columns via table recreation.
  // SQLite doesn't support DROP COLUMN below v3.35, so recreate the table
  // without the new columns, preserving data.
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

describe('migration v48: tile world columns on locations', () => {
  it('fresh db at v48 has tile_type, grid_x, grid_y on locations', () => {
    const db = freshDb()
    const cols = db.pragma('table_info(locations)').map((c) => c.name)
    expect(cols).toContain('tile_type')
    expect(cols).toContain('grid_x')
    expect(cols).toContain('grid_y')
    db.close()
  })

  it('CURRENT_SCHEMA_VERSION is 48', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(48)
  })

  it('fresh db schema_migrations includes version 48', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 48').get().c).toBe(1)
    db.close()
  })

  it('migrated db from v47 has the same three columns', () => {
    const db = preV48Db()
    expect(getSchemaVersion(db)).toBe(47)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(48)
    const cols = db.pragma('table_info(locations)').map((c) => c.name)
    expect(cols).toContain('tile_type')
    expect(cols).toContain('grid_x')
    expect(cols).toContain('grid_y')
    db.close()
  })

  it('existing locations rows survive migration with NULLs in all three columns', () => {
    const db = preV48Db('v48-survive')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO locations (id, camp_id, name, capacity) VALUES ('loc1', 'c1', 'Pool', 2)"
    ).run()
    initSchema(db)
    const row = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc1')
    expect(row.tile_type).toBeNull()
    expect(row.grid_x).toBeNull()
    expect(row.grid_y).toBeNull()
    expect(row.name).toBe('Pool')
    expect(row.capacity).toBe(2)
    db.close()
  })

  it('CHECK constraint rejects tile_type values outside the enum', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    expect(() => {
      db.prepare(
        "INSERT INTO locations (id, camp_id, name, capacity, tile_type) VALUES ('loc1', 'c1', 'Pool', 1, 'swamp')"
      ).run()
    }).toThrow()
    db.close()
  })

  it('CHECK constraint allows all valid tile_type values', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    const validTypes = ['building', 'pool', 'field', 'cabin', 'court', 'nature', 'generic']
    for (let i = 0; i < validTypes.length; i++) {
      db.prepare(
        `INSERT INTO locations (id, camp_id, name, capacity, tile_type) VALUES (?, 'c1', ?, 1, ?)`
      ).run(`loc${i}`, `Loc${i}`, validTypes[i])
    }
    const count = db.prepare('SELECT COUNT(*) c FROM locations').get().c
    expect(count).toBe(validTypes.length)
    db.close()
  })

  it('CHECK constraint allows NULL tile_type', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO locations (id, camp_id, name, capacity, tile_type) VALUES ('loc1', 'c1', 'Pool', 1, NULL)"
    ).run()
    const row = db.prepare('SELECT tile_type FROM locations WHERE id = ?').get('loc1')
    expect(row.tile_type).toBeNull()
    db.close()
  })

  it('is idempotent — re-running v48 does not duplicate columns or rows', () => {
    const db = preV48Db('v48-idempotent')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    initSchema(db)
    db.prepare(
      "INSERT INTO locations (id, camp_id, name, capacity, tile_type, grid_x, grid_y) VALUES ('loc1', 'c1', 'Pool', 1, 'pool', 3, 5)"
    ).run()
    const countBefore = db.prepare('SELECT COUNT(*) c FROM locations').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 48').run()
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(48)
    expect(db.prepare('SELECT COUNT(*) c FROM locations').get().c).toBe(countBefore)
    const row = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc1')
    expect(row.tile_type).toBe('pool')
    expect(row.grid_x).toBe(3)
    expect(row.grid_y).toBe(5)
    db.close()
  })
})
