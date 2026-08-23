// @vitest-environment node
//
// Migration v32 — camp locations become a first-class entity.
// docs/adr/2026-08-15-camp-locations-entity.md
//
// Same shape as sourceAliases.migration.test.js / exclusionTables.migration.test.js:
// fresh-vs-migrated schema equivalence (columns, indexes, DDL text), an
// idempotency twin, and an exercised rollback. PLUS the two invariants that are
// unique to this slice:
//   - INV-1: the two-db cross-device backfill determinism test (non-negotiable).
//   - backfill correctness: capacity seeding, TRIM-only dedupe, review items.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV32 } from './rollback/v32_down.js'
import { deriveLocationId } from '../ops/locationId.js'

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
  return openLocalDb(tmpFile('v32-fresh'))
}

// A database rolled back to the v31 shape: no locations / week_location_exclusions
// / location_migration_reviews tables, and no activities.location_id column, so
// v32 can be exercised against it. (schema.sql re-creates the two both-places
// tables on the next open, exactly as a real v31->v32 upgrade does; the ALTER
// column and the backfill are what v32 itself must add.)
function preV32Db(tag = 'v32-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('DROP TABLE IF EXISTS location_migration_reviews')
  db.exec('DROP INDEX IF EXISTS idx_week_location_exclusions_week_location')
  db.exec('DROP TABLE IF EXISTS week_location_exclusions')
  db.exec('DROP TABLE IF EXISTS locations')
  if (db.pragma('table_info(activities)').some((c) => c.name === 'location_id')) {
    db.exec('ALTER TABLE activities DROP COLUMN location_id')
  }
  // A genuine pre-v32 activities table has NONE of the columns later migrations
  // append. location_id (v32) is dropped above; any column added by a migration
  // AFTER v32 must also be stripped here, or re-running the migrations re-adds
  // location_id (v32) *after* that leftover column and the fresh-vs-migrated
  // column order diverges. recurrence_truth_status arrived at v44 (ADR
  // 2026-08-23-activity-recurrence-tiers-ingestion).
  if (db.pragma('table_info(activities)').some((c) => c.name === 'recurrence_truth_status')) {
    db.exec('ALTER TABLE activities DROP COLUMN recurrence_truth_status')
  }
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 32').run()
  return db
}

function seedCamp(db, campId) {
  db.prepare('INSERT OR IGNORE INTO camps (id, name) VALUES (?, ?)').run(campId, `Camp ${campId}`)
}

function seedActivity(db, id, campId, location, cap) {
  db.prepare(
    'INSERT INTO activities (id, camp_id, name, location, max_groups_per_slot) VALUES (?, ?, ?, ?, ?)'
  ).run(id, campId, id, location, cap)
}

const activitiesInfo = (db) =>
  db.pragma('table_info(activities)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql

const indexesFor = (db, table) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all(table)
    .sort((a, b) => a.name.localeCompare(b.name))

describe('migration v32: fresh vs migrated equivalence', () => {
  it('creates the entity on a fresh db and declares schema version 32', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 32').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM locations').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM week_location_exclusions').get().c).toBe(0)
    expect(db.pragma('table_info(activities)').some((c) => c.name === 'location_id')).toBe(true)
    db.close()
  })

  it('migrates a pre-v32 db forward to 32', () => {
    const db = preV32Db()
    expect(getSchemaVersion(db)).toBe(31)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  for (const table of ['locations', 'week_location_exclusions']) {
    it(`gives fresh and migrated identical ${table} columns, indexes and DDL`, () => {
      const fresh = freshDb()
      const migrated = preV32Db()
      initSchema(migrated)

      expect(tableInfo(migrated, table)).toEqual(tableInfo(fresh, table))
      expect(indexesFor(migrated, table)).toEqual(indexesFor(fresh, table))
      // sqlite_master stores the original CREATE TABLE text — the only check
      // that catches a byte-level drift between schema.sql and localDb.js.
      expect(tableSql(migrated, table)).toBe(tableSql(fresh, table))
      fresh.close()
      migrated.close()
    }, 30000)
  }

  it('places activities.location_id at its v32 append point, identically on fresh and migrated (column-order trap)', () => {
    const fresh = freshDb()
    const migrated = preV32Db()
    initSchema(migrated)

    expect(activitiesInfo(migrated)).toEqual(activitiesInfo(fresh))
    const cols = fresh.pragma('table_info(activities)').map((c) => c.name)
    // v32 appended location_id last; later migrations append after it (v44 added
    // recurrence_truth_status), so it is no longer the absolute final column —
    // but it must stay at its v32 append point, immediately before the next
    // appended column, and identical fresh-vs-migrated (the equivalence above is
    // the real trap check). This relative-order assertion survives future appends.
    expect(cols[cols.indexOf('location_id') + 1]).toBe('recurrence_truth_status')
    fresh.close()
    migrated.close()
  }, 30000)

  it('gives fresh and migrated the same whole table set (incl. the local review journal)', () => {
    const fresh = freshDb()
    const migrated = preV32Db()
    initSchema(migrated)
    const tables = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    expect(tables(migrated)).toEqual(tables(fresh))
    expect(tables(fresh)).toContain('location_migration_reviews')
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v32 does not duplicate tables or rows', () => {
    const db = preV32Db()
    seedCamp(db, 'c1')
    seedActivity(db, 'a1', 'c1', 'Pool', 1)
    initSchema(db) // runs v32
    const firstCount = db.prepare('SELECT COUNT(*) c FROM locations').get().c
    db.prepare('DELETE FROM schema_migrations WHERE version >= 32').run()
    initSchema(db) // re-run v32
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM locations').get().c).toBe(firstCount)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='locations'").get().c
    ).toBe(1)
    db.close()
  })
})

describe('migration v32: INV-1 — deterministic, device-identical backfill', () => {
  // The single most important test in this slice. Two INDEPENDENT databases with
  // identical pre-v32 state must produce byte-identical locations.id AND
  // activities.location_id after each runs v32 on its own. A green single-db
  // test would not prove this.
  const CAMP = 'camp-shared-across-devices'
  const seed = [
    ['a1', 'Pool', 1],
    ['a2', 'Pool', 3], // disagreement with a1
    ['a3', 'pool', null], // TRIM-equal-but-case-different + all-null cap
    ['a4', '  Gym  ', 0], // leading/trailing space + 0 cap
    ['a5', 'Gym', 2], // trims to same as a4
    ['a6', null, 1], // no location — contributes nothing
  ]

  function buildAndMigrate(tag) {
    const db = preV32Db(tag)
    seedCamp(db, CAMP)
    for (const [id, loc, cap] of seed) seedActivity(db, id, CAMP, loc, cap)
    initSchema(db) // runs v32 on this device
    return db
  }

  it('mints byte-identical locations.id and activities.location_id on two devices', () => {
    const deviceA = buildAndMigrate('v32-devA')
    const deviceB = buildAndMigrate('v32-devB')

    const locsA = deviceA.prepare('SELECT id, camp_id, name, capacity, sort_order FROM locations ORDER BY id').all()
    const locsB = deviceB.prepare('SELECT id, camp_id, name, capacity, sort_order FROM locations ORDER BY id').all()
    expect(locsA).toEqual(locsB)

    const actA = deviceA.prepare('SELECT id, location, location_id FROM activities ORDER BY id').all()
    const actB = deviceB.prepare('SELECT id, location, location_id FROM activities ORDER BY id').all()
    expect(actA).toEqual(actB)

    // The ids are the pure function of camp_id + trimmed name, not a UUID.
    expect(locsA.map((l) => l.id)).toContain(deriveLocationId(CAMP, 'Pool'))
    expect(locsA.map((l) => l.id)).toContain(deriveLocationId(CAMP, 'pool'))
    expect(locsA.map((l) => l.id)).toContain(deriveLocationId(CAMP, 'Gym'))

    // The backfill emits NO op on either device — it is a DDL-time side effect.
    expect(deviceA.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(0)
    expect(deviceB.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(0)

    deviceA.close()
    deviceB.close()
  })
})

describe('migration v32: backfill correctness', () => {
  const CAMP = 'c1'
  function migrated() {
    const db = preV32Db('v32-backfill')
    seedCamp(db, CAMP)
    seedActivity(db, 'a1', CAMP, 'Pool', 1)
    seedActivity(db, 'a2', CAMP, 'Pool', 3)
    seedActivity(db, 'a3', CAMP, 'pool', null)
    seedActivity(db, 'a4', CAMP, '  Gym  ', 0)
    initSchema(db)
    return db
  }

  it('seeds capacity to MAX(COALESCE(NULLIF(cap,0),1)) — permissive declared value', () => {
    const db = migrated()
    expect(db.prepare('SELECT capacity FROM locations WHERE name = ?').get('Pool').capacity).toBe(3)
    expect(db.prepare('SELECT capacity FROM locations WHERE name = ?').get('pool').capacity).toBe(1)
    expect(db.prepare('SELECT capacity FROM locations WHERE name = ?').get('Gym').capacity).toBe(1)
    db.close()
  })

  it('floors a negative declared cap to 1 — capacity is never < 1', () => {
    const db = preV32Db('v32-negcap')
    seedCamp(db, CAMP)
    seedActivity(db, 'a1', CAMP, 'Court', -5)
    initSchema(db)
    // A negative max_groups_per_slot must not leak into capacity — M2's
    // occupancy check would corrupt. As the only contributor it floors to 1.
    expect(db.prepare('SELECT capacity FROM locations WHERE name = ?').get('Court').capacity).toBe(1)
    db.close()
  })

  it('dedupes on TRIM only, case-sensitive — Pool and pool stay two rows, Gym is trimmed', () => {
    const db = migrated()
    const names = db.prepare('SELECT name FROM locations ORDER BY name').all().map((r) => r.name)
    expect(names).toEqual(['Gym', 'Pool', 'pool'])
    // The trimmed name is stored, and the id matches the trimmed key.
    expect(db.prepare('SELECT id FROM locations WHERE name = ?').get('Gym').id).toBe(
      deriveLocationId(CAMP, 'Gym')
    )
    db.close()
  })

  it('binds every activity by its trimmed key, leaving location-less activities NULL', () => {
    const db = preV32Db('v32-bind')
    seedCamp(db, CAMP)
    seedActivity(db, 'a4', CAMP, '  Gym  ', 0)
    seedActivity(db, 'a7', CAMP, null, 1)
    initSchema(db)
    expect(db.prepare('SELECT location_id FROM activities WHERE id = ?').get('a4').location_id).toBe(
      deriveLocationId(CAMP, 'Gym')
    )
    expect(db.prepare('SELECT location_id FROM activities WHERE id = ?').get('a7').location_id).toBeNull()
    db.close()
  })

  it('records the three review kinds (disagreement, was_unlimited, near_duplicate)', () => {
    const db = migrated()
    const reviews = db
      .prepare('SELECT name, kind, detail FROM location_migration_reviews ORDER BY name, kind')
      .all()

    const disagreement = reviews.find((r) => r.kind === 'capacity_disagreement')
    expect(disagreement.name).toBe('Pool')
    expect(JSON.parse(disagreement.detail)).toEqual({ declaredCaps: [1, 3], seededCapacity: 3 })

    const wasUnlimited = reviews.filter((r) => r.kind === 'was_unlimited').map((r) => r.name).sort()
    expect(wasUnlimited).toEqual(['Gym', 'pool'])

    const nearDup = reviews.filter((r) => r.kind === 'near_duplicate').map((r) => r.name).sort()
    expect(nearDup).toEqual(['Pool', 'pool'])
    db.close()
  })
})

describe('migration v32: frozen activities.location', () => {
  it('leaves the frozen location string untouched (migration reads it, never writes it)', () => {
    const db = preV32Db('v32-frozen')
    seedCamp(db, 'c1')
    seedActivity(db, 'a1', 'c1', 'Pool', 1)
    seedActivity(db, 'a4', 'c1', '  Gym  ', 0)
    initSchema(db)
    // The stored strings are byte-for-byte what they were — including the
    // untrimmed '  Gym  ' — because the migration only reads them.
    expect(db.prepare('SELECT location FROM activities WHERE id = ?').get('a1').location).toBe('Pool')
    expect(db.prepare('SELECT location FROM activities WHERE id = ?').get('a4').location).toBe('  Gym  ')
    // No op was written for activities.location (the migration writes no ops).
    expect(
      db.prepare("SELECT COUNT(*) c FROM operations WHERE entity='activities' AND field='location'").get().c
    ).toBe(0)
    db.close()
  })

  it('schema.sql marks activities.location FROZEN (D5 documentation enforcement)', () => {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    // The frozen marker sits immediately above the `location TEXT,` column.
    expect(schema).toMatch(/FROZEN from schema v32[\s\S]*?\n {2}location TEXT,/)
  })
})

describe('rollback v32', () => {
  it('repopulates activities.location from the entity (lossless for names) and drops the structure', () => {
    const db = preV32Db('v32-rollback')
    seedCamp(db, 'c1')
    seedActivity(db, 'a1', 'c1', 'Pool', 1)
    initSchema(db)
    // Simulate a rename after upgrade: the entity name diverges from the frozen
    // string, and rollback must restore the CURRENT name.
    db.prepare('UPDATE locations SET name = ? WHERE name = ?').run('Swimming Pool', 'Pool')

    const result = rollbackV32(db)
    expect(result.discardedLocations).toBe(1)

    // location repopulated from the (renamed) entity — lossless for names.
    expect(db.prepare('SELECT location FROM activities WHERE id = ?').get('a1').location).toBe('Swimming Pool')
    // structure gone
    expect(tableSql(db, 'locations')).toBeUndefined()
    expect(tableSql(db, 'week_location_exclusions')).toBeUndefined()
    expect(db.pragma('table_info(activities)').some((c) => c.name === 'location_id')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 32').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(31)
    db.close()
  })

  it('leaves the frozen location string intact when location_id dangles (no data loss)', () => {
    const db = preV32Db('v32-rollback-dangle')
    seedCamp(db, 'c1')
    seedActivity(db, 'a1', 'c1', 'Pool', 1)
    initSchema(db)
    // The locations row disappears (e.g. deleted post-upgrade) but the activity
    // still points at its now-dangling id — nothing at the DB level clears the FK.
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM locations WHERE name = ?').run('Pool')

    rollbackV32(db)

    // The subquery finds no row, so COALESCE keeps the frozen anchor string —
    // it must NOT be overwritten with NULL.
    expect(db.prepare('SELECT location FROM activities WHERE id = ?').get('a1').location).toBe('Pool')
    db.close()
  })

  it('is reversible — re-migrating after rollback restores identical tables and re-backfills', () => {
    const db = preV32Db('v32-rollback-fwd')
    seedCamp(db, 'c1')
    seedActivity(db, 'a1', 'c1', 'Pool', 2)
    initSchema(db)
    const beforeSql = tableSql(db, 'locations')

    rollbackV32(db)
    initSchema(db) // roll forward again

    expect(tableSql(db, 'locations')).toBe(beforeSql)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    // The deterministic backfill re-ran and re-bound the activity.
    expect(db.prepare('SELECT location_id FROM activities WHERE id = ?').get('a1').location_id).toBe(
      deriveLocationId('c1', 'Pool')
    )
    db.close()
  })
})
