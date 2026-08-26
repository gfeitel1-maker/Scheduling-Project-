// @vitest-environment node
//
// Migration v50 — indoor/outdoor map pair per camp + locations.map_id.
// docs/adr/2026-08-26-indoor-outdoor-map-pair-and-sim-seed.md D1/D2.
//
// camp_maps: UNIQUE(camp_id) → UNIQUE(camp_id, kind) + new `kind` column, so a
// camp can hold two maps. locations: new nullable `map_id`.
// Same fresh-vs-migrated equivalence + idempotency shape as the sibling
// campMaps / tileWorld migration tests, plus the constraint-relaxation checks
// that are the whole point of this migration.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

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
  return openLocalDb(tmpFile('v50-fresh'))
}

// A database at v49 shape: fully migrated, then camp_maps rolled back to the
// pre-v50 singleton shape (no `kind`, UNIQUE(camp_id)) and locations.map_id dropped.
function preV50Db(tag = 'v50-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE camp_maps_old (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL UNIQUE REFERENCES camps(id),
      image_data TEXT,
      image_mime TEXT,
      image_width INTEGER,
      image_height INTEGER
    );
    INSERT INTO camp_maps_old (id, camp_id, image_data, image_mime, image_width, image_height)
      SELECT id, camp_id, image_data, image_mime, image_width, image_height FROM camp_maps;
    DROP TABLE camp_maps;
    ALTER TABLE camp_maps_old RENAME TO camp_maps;
  `)
  // Drop locations.map_id by rebuilding the pre-v50 locations shape (v49 columns).
  db.exec(`
    CREATE TABLE locations_old (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL REFERENCES camps(id),
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      sort_order INTEGER,
      map_geometry TEXT,
      kind TEXT,
      grid_x INTEGER,
      grid_y INTEGER,
      UNIQUE(camp_id, name)
    );
    INSERT INTO locations_old (id, camp_id, name, capacity, notes, sort_order, map_geometry, kind, grid_x, grid_y)
      SELECT id, camp_id, name, capacity, notes, sort_order, map_geometry, kind, grid_x, grid_y FROM locations;
    DROP TABLE locations;
    ALTER TABLE locations_old RENAME TO locations;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_camp_name ON locations(camp_id, name);
  `)
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 50').run()
  return db
}

describe('migration v50: indoor/outdoor map pair + locations.map_id', () => {
  it('CURRENT_SCHEMA_VERSION is 50', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(50)
  })

  it('fresh db: camp_maps has kind, locations has map_id', () => {
    const db = freshDb()
    expect(db.pragma('table_info(camp_maps)').map((c) => c.name)).toContain('kind')
    expect(db.pragma('table_info(locations)').map((c) => c.name)).toContain('map_id')
    db.close()
  })

  it('pre-v50 db migrates: camp_maps gains kind, locations gains map_id', () => {
    const db = preV50Db()
    expect(getSchemaVersion(db)).toBe(49)
    expect(db.pragma('table_info(camp_maps)').map((c) => c.name)).not.toContain('kind')
    expect(db.pragma('table_info(locations)').map((c) => c.name)).not.toContain('map_id')
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(50)
    expect(db.pragma('table_info(camp_maps)').map((c) => c.name)).toContain('kind')
    expect(db.pragma('table_info(locations)').map((c) => c.name)).toContain('map_id')
    db.close()
  })

  it('an existing single-map row survives migration with kind = NULL', () => {
    const db = preV50Db('v50-survive')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO camp_maps (id, camp_id, image_data) VALUES ('c1', 'c1', 'base64jpeg')"
    ).run()
    initSchema(db)
    const row = db.prepare('SELECT * FROM camp_maps WHERE id = ?').get('c1')
    expect(row.kind).toBeNull()
    expect(row.image_data).toBe('base64jpeg')
    expect(row.camp_id).toBe('c1')
    db.close()
  })

  it('after migration a camp can hold two maps (the whole point) — UNIQUE(camp_id) no longer blocks a second row', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO camp_maps (id, camp_id, kind) VALUES ('c1', 'c1', 'indoor')").run()
    // A second row for the same camp, different kind — was impossible under UNIQUE(camp_id).
    expect(() =>
      db.prepare("INSERT INTO camp_maps (id, camp_id, kind) VALUES ('m2', 'c1', 'outdoor')").run()
    ).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM camp_maps WHERE camp_id = ?').get('c1').c).toBe(2)
    db.close()
  })

  it('UNIQUE(camp_id, kind) still rejects two maps of the SAME kind for one camp', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO camp_maps (id, camp_id, kind) VALUES ('c1', 'c1', 'indoor')").run()
    expect(() =>
      db.prepare("INSERT INTO camp_maps (id, camp_id, kind) VALUES ('m2', 'c1', 'indoor')").run()
    ).toThrow()
    db.close()
  })

  it('locations.map_id round-trips and defaults to NULL', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('l1', 'c1', 'Room 1')").run()
    expect(db.prepare('SELECT map_id FROM locations WHERE id = ?').get('l1').map_id).toBeNull()
    db.prepare("UPDATE locations SET map_id = 'm2' WHERE id = 'l1'").run()
    expect(db.prepare('SELECT map_id FROM locations WHERE id = ?').get('l1').map_id).toBe('m2')
    db.close()
  })

  it('is idempotent — re-running v50 does not duplicate columns, rows, or tables', () => {
    const db = preV50Db('v50-idempotent')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    initSchema(db)
    db.prepare("INSERT INTO camp_maps (id, camp_id, kind, image_data) VALUES ('c1', 'c1', NULL, 'x')").run()
    const before = db.prepare('SELECT COUNT(*) c FROM camp_maps').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 50').run()
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(50)
    expect(db.prepare('SELECT COUNT(*) c FROM camp_maps').get().c).toBe(before)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='camp_maps'").get().c
    ).toBe(1)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'camp_maps_v50'").get().c
    ).toBe(0)
    db.close()
  })

  it('no op is written for the migration — DDL-only, like v33/v49', () => {
    const db = preV50Db('v50-noop')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c1', 'Camp', 'sec')").run()
    initSchema(db)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity='camp_maps'").get().c).toBe(0)
    db.close()
  })
})
