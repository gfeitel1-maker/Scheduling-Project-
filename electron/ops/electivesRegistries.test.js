// @vitest-environment node
//
// Positive verification that the v35 entities (`elective_sets`,
// `elective_set_activities`, T41 slice 1,
// docs/work/specs/2026-08-20-group-electives-design.md) are registered in
// every place the registry checklist names — mirroring
// electron/ops/specialDaysRegistries.test.js for v34's special_days. A table
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

describe('v35 registry coverage — elective_sets', () => {
  it('is a projected entity (writes materialize, not silently discarded)', () => {
    expect(PROJECTIONS.elective_sets).toBeTruthy()
    // is_reusable added v36 (T110, docs/adr/2026-08-20-electives-authoring.md D2).
    // day_id/time_block_id/is_all_groups/group_ids/schedule_week_id/
    // recurrence_level added v43 (unified-schedule-overlay Slice 3a,
    // docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md).
    expect(PROJECTIONS.elective_sets.fields).toEqual([
      'camp_id', 'name', 'sort_order', 'is_reusable',
      'day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id', 'recurrence_level',
    ])
  })

  it('is a direct-camp-scoped entity (list() + first-pairing full_sync)', () => {
    expect(DIRECT_CAMP_ENTITIES.has('elective_sets')).toBe(true)
  })

  it('is in the client first-pairing snapshot (DOMAIN_SNAPSHOT_ORDER + columns)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('elective_sets')
    expect(src).toMatch(
      /elective_sets:\s*\[\s*'id', 'camp_id', 'name', 'sort_order', 'is_reusable',\s*'day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id', 'recurrence_level',\s*\]/
    )
  })

  it('is in permissions.ENTITIES (not silently admin-only)', () => {
    expect(ENTITIES).toContain('elective_sets')
  })

  it('has a restore decision and a mock write allowlist', () => {
    expect(RESTORE_DECISIONS.elective_sets).toBeDefined()
    expect(MOCK_WRITE_ALLOWLIST.elective_sets).toEqual([
      'camp_id', 'name', 'sort_order', 'is_reusable',
      'day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id', 'recurrence_level',
    ])
  })
})

describe('v35 registry coverage — elective_set_activities', () => {
  it('is a projected, parent-scoped entity keyed by elective_set_id', () => {
    expect(PROJECTIONS.elective_set_activities).toBeTruthy()
    expect(PROJECTIONS.elective_set_activities.fields).toEqual(['elective_set_id', 'activity_id', 'camper_headcount'])
    expect(PARENT_SCOPED_ENTITIES.elective_set_activities).toEqual({
      table: 'elective_set_activities',
      parentTable: 'elective_sets',
      parentKey: 'elective_set_id',
    })
  })

  it('is in permissions.ENTITIES and has a restore decision', () => {
    expect(ENTITIES).toContain('elective_set_activities')
    expect(RESTORE_DECISIONS.elective_set_activities).toBeDefined()
  })

  it('has a mock write allowlist matching its projection fields', () => {
    expect(MOCK_WRITE_ALLOWLIST.elective_set_activities).toEqual(
      PROJECTIONS.elective_set_activities.fields
    )
  })

  it('is shipped by the server first-pairing snapshot', () => {
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('elective_set_activities')
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    expect(src).toMatch(
      /elective_set_activities:\s*\['id', 'elective_set_id', 'activity_id', 'camper_headcount'\]/
    )
  })
})

describe('v35 registry coverage — template_slots.elective_set_id', () => {
  it('is a writable field on the template_slots projection', () => {
    expect(PROJECTIONS.template_slots.fields).toContain('elective_set_id')
  })

  it('is in the client first-pairing snapshot column list', () => {
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    expect(src).toMatch(
      /template_slots:\s*\[[^\]]*'elective_set_id'[^\]]*\]/
    )
  })
})

describe('RESTORE_DECISIONS covers every projected entity (restore.test.js guard, restated)', () => {
  it('has an entry for both new entities so the build does not fail on an unlisted projection', () => {
    for (const entity of ['elective_sets', 'elective_set_activities']) {
      expect(RESTORE_DECISIONS[entity], `missing RESTORE_DECISIONS for ${entity}`).toBeDefined()
    }
  })
})

describe('DOMAIN_SNAPSHOT_ORDER FK ordering', () => {
  it('places elective_sets before its child (parent must exist before a first-pairing Client inserts either)', () => {
    const order = DOMAIN_SNAPSHOT_ORDER
    const parentIdx = order.indexOf('elective_sets')
    const childIdx = order.indexOf('elective_set_activities')
    expect(parentIdx).toBeGreaterThanOrEqual(0)
    expect(childIdx).toBeGreaterThan(parentIdx)
  })
})
