// @vitest-environment node
//
// Positive verification that the three v34 entities (`special_days`,
// `special_day_time_blocks`, `special_day_slots`, T40 slice 1,
// docs/work/specs/2026-08-20-special-days-data-shape-design.md) are
// registered in every place the registry checklist names — mirroring
// electron/ops/locationsRegistries.test.js for v32's locations. A table
// registered on one side of sync but not the other silently drops rows (the
// T88 bug class) — these assertions target exactly the silent-failure
// registries where an omission produces no other test failure.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECTIONS } from './projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES, DOMAIN_SNAPSHOT_ORDER } from './campScopedEntities.js'
import { RESTORE_DECISIONS } from './restore.js'
import { ENTITIES } from '../auth/permissions.js'
import { MOCK_WRITE_ALLOWLIST } from '../../src/localClient.mock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('v34 registry coverage — special_days', () => {
  it('is a projected entity (writes materialize, not silently discarded)', () => {
    expect(PROJECTIONS.special_days).toBeTruthy()
    expect(PROJECTIONS.special_days.fields).toEqual(['camp_id', 'name', 'sort_order'])
  })

  it('is a direct-camp-scoped entity (list() + first-pairing full_sync)', () => {
    expect(DIRECT_CAMP_ENTITIES.has('special_days')).toBe(true)
  })

  it('is in the client first-pairing snapshot (DOMAIN_SNAPSHOT_ORDER + columns)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('special_days')
    expect(src).toMatch(/special_days:\s*\['id', 'camp_id', 'name', 'sort_order'\]/)
  })

  it('is in permissions.ENTITIES (not silently admin-only)', () => {
    expect(ENTITIES).toContain('special_days')
  })

  it('has a restore decision and a mock write allowlist', () => {
    expect(RESTORE_DECISIONS.special_days).toBeDefined()
    expect(MOCK_WRITE_ALLOWLIST.special_days).toEqual(['camp_id', 'name', 'sort_order'])
  })
})

describe('v34 registry coverage — special_day_time_blocks', () => {
  it('is a projected, parent-scoped entity keyed by special_day_id', () => {
    expect(PROJECTIONS.special_day_time_blocks).toBeTruthy()
    expect(PROJECTIONS.special_day_time_blocks.fields).toEqual([
      'special_day_id', 'name', 'sort_order', 'start_time', 'end_time',
    ])
    expect(PARENT_SCOPED_ENTITIES.special_day_time_blocks).toEqual({
      table: 'special_day_time_blocks',
      parentTable: 'special_days',
      parentKey: 'special_day_id',
    })
  })

  it('is in permissions.ENTITIES and has a restore decision', () => {
    expect(ENTITIES).toContain('special_day_time_blocks')
    expect(RESTORE_DECISIONS.special_day_time_blocks).toBeDefined()
  })

  it('has a mock write allowlist matching its projection fields', () => {
    expect(MOCK_WRITE_ALLOWLIST.special_day_time_blocks).toEqual(
      PROJECTIONS.special_day_time_blocks.fields
    )
  })

  it('is shipped by the server first-pairing snapshot', () => {
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('special_day_time_blocks')
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    expect(src).toMatch(
      /special_day_time_blocks:\s*\['id', 'special_day_id', 'name', 'sort_order', 'start_time', 'end_time'\]/
    )
  })
})

describe('v34 registry coverage — special_day_slots', () => {
  it('is a projected, parent-scoped entity keyed by special_day_id', () => {
    expect(PROJECTIONS.special_day_slots).toBeTruthy()
    expect(PROJECTIONS.special_day_slots.fields).toEqual([
      'special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id',
    ])
    expect(PARENT_SCOPED_ENTITIES.special_day_slots).toEqual({
      table: 'special_day_slots',
      parentTable: 'special_days',
      parentKey: 'special_day_id',
    })
  })

  it('is in permissions.ENTITIES and has a restore decision', () => {
    expect(ENTITIES).toContain('special_day_slots')
    expect(RESTORE_DECISIONS.special_day_slots).toBeDefined()
  })

  it('has a mock write allowlist matching its projection fields', () => {
    expect(MOCK_WRITE_ALLOWLIST.special_day_slots).toEqual(PROJECTIONS.special_day_slots.fields)
  })

  it('is shipped by the server first-pairing snapshot', () => {
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('special_day_slots')
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    expect(src).toMatch(
      /special_day_slots:\s*\['id', 'special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id'\]/
    )
  })
})

describe('RESTORE_DECISIONS covers every projected entity (restore.test.js guard, restated)', () => {
  it('has an entry for all three new entities so the build does not fail on an unlisted projection', () => {
    for (const entity of ['special_days', 'special_day_time_blocks', 'special_day_slots']) {
      expect(RESTORE_DECISIONS[entity], `missing RESTORE_DECISIONS for ${entity}`).toBeDefined()
    }
  })
})

describe('DOMAIN_SNAPSHOT_ORDER FK ordering', () => {
  it('places special_days before its two children (parent must exist before a first-pairing Client inserts either)', () => {
    const order = DOMAIN_SNAPSHOT_ORDER
    const parentIdx = order.indexOf('special_days')
    const tbIdx = order.indexOf('special_day_time_blocks')
    const slotIdx = order.indexOf('special_day_slots')
    expect(parentIdx).toBeGreaterThanOrEqual(0)
    expect(tbIdx).toBeGreaterThan(parentIdx)
    expect(slotIdx).toBeGreaterThan(parentIdx)
  })
})
