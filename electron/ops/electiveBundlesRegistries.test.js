// @vitest-environment node
//
// T301 (docs/adr/2026-09-29-linked-elective-bundles.md) registry coverage —
// mirroring electivesRegistries.test.js for v35's elective_sets/
// elective_set_activities. A table registered on one side of a registry but
// not the other silently drops rows or resolves to admin-only (the T88 bug
// class) — these assertions target exactly the silent-failure registries
// where an omission produces no other test failure.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROJECTIONS } from './projections.js'
import { PARENT_SCOPED_ENTITIES, DOMAIN_SNAPSHOT_ORDER } from './campScopedEntities.js'
import { RESTORE_DECISIONS } from './restore.js'
import { ENTITIES } from '../auth/permissions.js'
import { MOCK_WRITE_ALLOWLIST } from '../../src/localClient.mock.js'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'

const ENTITY_NAMES = ['elective_bundles', 'elective_bundle_periods', 'elective_bundle_tiers']

describe.each(ENTITY_NAMES)('v81 registry coverage — %s', (entity) => {
  it('is a projected entity (writes materialize, not silently discarded)', () => {
    expect(PROJECTIONS[entity]).toBeTruthy()
  })

  it('is a parent-scoped entity', () => {
    expect(PARENT_SCOPED_ENTITIES[entity]).toBeTruthy()
  })

  it('is in permissions.ENTITIES — ordinary staff read/write, not admin-only (ADR Consequences: no camper/PII data)', () => {
    expect(ENTITIES).toContain(entity)
  })

  it('has a restore decision', () => {
    expect(RESTORE_DECISIONS[entity]).toBeDefined()
  })

  it('has a mock write allowlist matching its projection fields exactly', () => {
    expect(MOCK_WRITE_ALLOWLIST[entity]).toEqual(PROJECTIONS[entity].fields)
  })

  it('is present in DOMAIN_SNAPSHOT_ORDER', () => {
    expect(DOMAIN_SNAPSHOT_ORDER).toContain(entity)
  })
})

describe('v81 registry coverage — field lists', () => {
  it('elective_bundles projects exactly the non-key columns', () => {
    expect(PROJECTIONS.elective_bundles.fields).toEqual([
      'elective_set_id', 'activity_id', 'name', 'scope_mode', 'sort_order',
    ])
  })

  it('elective_bundle_periods projects exactly the non-key columns', () => {
    expect(PROJECTIONS.elective_bundle_periods.fields).toEqual(['bundle_id', 'day_id', 'time_block_id'])
  })

  it('elective_bundle_tiers projects exactly the non-key columns', () => {
    expect(PROJECTIONS.elective_bundle_tiers.fields).toEqual(['bundle_id', 'tier_id'])
  })

  it('elective_bundles is parent-scoped by elective_set_id, under elective_sets', () => {
    expect(PARENT_SCOPED_ENTITIES.elective_bundles).toEqual({
      table: 'elective_bundles',
      parentTable: 'elective_sets',
      parentKey: 'elective_set_id',
    })
  })

  // ROUND-2 FINDING 5: the describe.each block above only checks these two are
  // TRUTHY, so a wrong-but-existing column name (e.g. 'day_id' where
  // 'bundle_id' belongs — they sit adjacent on the same elective_bundle_periods
  // row) would not throw; it would silently return wrong or empty rows from
  // the listByScope filter these values build (electron/ops/read.js,
  // electron/main.js). Exact-value, matching the elective_bundles case above.
  it('elective_bundle_periods is parent-scoped by bundle_id, under elective_bundles (soft pointer, D1)', () => {
    expect(PARENT_SCOPED_ENTITIES.elective_bundle_periods).toEqual({
      table: 'elective_bundle_periods',
      parentTable: 'elective_bundles',
      parentKey: 'bundle_id',
    })
  })

  it('elective_bundle_tiers is parent-scoped by bundle_id, under elective_bundles (soft pointer, D1)', () => {
    expect(PARENT_SCOPED_ENTITIES.elective_bundle_tiers).toEqual({
      table: 'elective_bundle_tiers',
      parentTable: 'elective_bundles',
      parentKey: 'bundle_id',
    })
  })
})

describe('DOMAIN_SNAPSHOT_ORDER FK ordering', () => {
  it('places elective_sets before elective_bundles (parent must exist before a first-pairing Client inserts either)', () => {
    const order = DOMAIN_SNAPSHOT_ORDER
    expect(order.indexOf('elective_sets')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('elective_bundles')).toBeGreaterThan(order.indexOf('elective_sets'))
  })

  it('places elective_bundles before elective_bundle_periods and elective_bundle_tiers', () => {
    const order = DOMAIN_SNAPSHOT_ORDER
    expect(order.indexOf('elective_bundle_periods')).toBeGreaterThan(order.indexOf('elective_bundles'))
    expect(order.indexOf('elective_bundle_tiers')).toBeGreaterThan(order.indexOf('elective_bundles'))
  })
})

describe('RESTORE_DECISIONS covers every projected entity (restore.test.js guard, restated)', () => {
  it('has an entry for all three new entities so the build does not fail on an unlisted projection', () => {
    for (const entity of ENTITY_NAMES) {
      expect(RESTORE_DECISIONS[entity], `missing RESTORE_DECISIONS for ${entity}`).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// "A new entity absent from PROJECTIONS means its writes silently never
// materialize" (CLAUDE.md). These assert the ROW, not that applyProjection
// returned without throwing — a call that succeeds and writes nothing would
// pass a weaker assertion.
// ---------------------------------------------------------------------------
describe('a write materializes a real row for each of the three new entities', () => {
  let db
  let tmpFile

  afterEach(() => {
    db?.close()
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  })

  function freshDb() {
    tmpFile = path.join(os.tmpdir(), `shoresh-elective-bundles-proj-${Date.now()}-${Math.random()}.sqlite`)
    db = openLocalDb(tmpFile)
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    // operations.device_id is NOT NULL REFERENCES devices(id).
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
    return db
  }

  // Through appendOp (the real write path: write() IPC -> appendOp ->
  // applyProjection), not applyProjection directly — ensureExists's
  // reconstruct-prior-fields fallback reads the `operations` table, which
  // only appendOp populates (it writes the op row BEFORE projecting, per
  // this module's own header comment). Calling applyProjection directly
  // would test a path no real write ever takes. author_user_id is nullable
  // (operations.test.js's own precedent) — this test is not about who wrote
  // it, so it is omitted rather than seeding a full signed user row.
  const write = (entity, entity_id, field, value) =>
    appendOp(db, { entity, entity_id, field, value, author_user_id: null, device_id: 'device-1' })

  it('elective_bundles: writing elective_set_id, activity_id and name (in that order) materializes a complete row, stub-seeding its elective_sets parent', () => {
    freshDb()
    write('elective_bundles', 'bundle-1', 'elective_set_id', 'set-1')
    write('elective_bundles', 'bundle-1', 'activity_id', 'act-1')
    write('elective_bundles', 'bundle-1', 'name', 'Woodworking')

    const row = db.prepare('SELECT * FROM elective_bundles WHERE id = ?').get('bundle-1')
    expect(row).toBeTruthy()
    expect(row).toMatchObject({
      id: 'bundle-1',
      elective_set_id: 'set-1',
      activity_id: 'act-1',
      name: 'Woodworking',
      scope_mode: 'all',
    })
    // The parent stub — elective_bundles.elective_set_id is a real FK, so
    // under foreign_keys=ON the row above could not exist at all unless the
    // parent was stub-seeded first.
    expect(db.prepare('SELECT id FROM elective_sets WHERE id = ?').get('set-1')).toBeTruthy()
  })

  it('elective_bundles: does NOT materialize the row until elective_set_id, activity_id AND name are all known', () => {
    freshDb()
    write('elective_bundles', 'bundle-2', 'elective_set_id', 'set-1')
    expect(db.prepare('SELECT * FROM elective_bundles WHERE id = ?').get('bundle-2')).toBeUndefined()
    write('elective_bundles', 'bundle-2', 'activity_id', 'act-1')
    expect(db.prepare('SELECT * FROM elective_bundles WHERE id = ?').get('bundle-2')).toBeUndefined()
    write('elective_bundles', 'bundle-2', 'name', 'Ceramics')
    expect(db.prepare('SELECT * FROM elective_bundles WHERE id = ?').get('bundle-2')).toBeTruthy()
  })

  it('elective_bundle_periods: writing bundle_id, day_id and time_block_id materializes a row, with NO parent stub (soft pointer, D1)', () => {
    freshDb()
    write('elective_bundle_periods', 'period-1', 'bundle_id', 'bundle-does-not-exist')
    write('elective_bundle_periods', 'period-1', 'day_id', 'day-1')
    write('elective_bundle_periods', 'period-1', 'time_block_id', 'tb-1')

    const row = db.prepare('SELECT * FROM elective_bundle_periods WHERE id = ?').get('period-1')
    expect(row).toEqual({ id: 'period-1', bundle_id: 'bundle-does-not-exist', day_id: 'day-1', time_block_id: 'tb-1' })
    // No stub-seeded elective_bundles row — bundle_id is a soft pointer.
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c).toBe(0)
  })

  it('elective_bundle_tiers: writing bundle_id and tier_id materializes a row, with NO parent stub', () => {
    freshDb()
    write('elective_bundle_tiers', 'tierrow-1', 'bundle_id', 'bundle-does-not-exist')
    write('elective_bundle_tiers', 'tierrow-1', 'tier_id', 'tier-1')

    const row = db.prepare('SELECT * FROM elective_bundle_tiers WHERE id = ?').get('tierrow-1')
    expect(row).toEqual({ id: 'tierrow-1', bundle_id: 'bundle-does-not-exist', tier_id: 'tier-1' })
    expect(db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c).toBe(0)
  })
})
