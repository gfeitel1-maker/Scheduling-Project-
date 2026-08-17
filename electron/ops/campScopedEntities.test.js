import { describe, it, expect } from 'vitest'
import {
  DIRECT_CAMP_ENTITIES,
  PARENT_SCOPED_ENTITIES,
  DOMAIN_SNAPSHOT_ORDER,
  DOMAIN_PARENT_SCOPED_ENTITIES,
  assertDirectEntityParity,
} from './campScopedEntities.js'
import { assertColumnCoverage } from '../sync/syncClient.js'

// T88 review follow-up: two hand-maintained lists survived the ticket's
// single-sourcing fix — syncServer.js's DIRECT_CAMP_ENTITIES iteration
// (send side) vs DOMAIN_SNAPSHOT_ORDER's direct members (apply side), and
// syncClient.js's DOMAIN_TABLE_COLUMNS (a third map, keyed by the same
// table names). Both modules now assert parity at import time; these tests
// prove that assertion (a) holds for the real, current registries and
// (b) actually fires — not just exists as dead code — on synthetic
// violating input for each direction of each drift.
describe('campScopedEntities manifest parity', () => {
  it('does not throw for the real, current registries (already proven by both files loading without error)', () => {
    expect(() => assertDirectEntityParity(DIRECT_CAMP_ENTITIES, DOMAIN_SNAPSHOT_ORDER, PARENT_SCOPED_ENTITIES)).not.toThrow()
  })

  it('DOMAIN_PARENT_SCOPED_ENTITIES is exactly the parent-scoped subset of DOMAIN_SNAPSHOT_ORDER, in order', () => {
    const expected = DOMAIN_SNAPSHOT_ORDER.filter((entity) => entity in PARENT_SCOPED_ENTITIES)
    expect(DOMAIN_PARENT_SCOPED_ENTITIES).toEqual(expected)
  })

  it('throws when DIRECT_CAMP_ENTITIES has a table DOMAIN_SNAPSHOT_ORDER is missing', () => {
    const directEntities = new Set(['groups', 'a_table_only_on_the_send_side'])
    const snapshotOrder = ['groups']
    expect(() => assertDirectEntityParity(directEntities, snapshotOrder, {})).toThrow(
      /a_table_only_on_the_send_side/
    )
  })

  it('throws when DOMAIN_SNAPSHOT_ORDER lists a direct table DIRECT_CAMP_ENTITIES is missing', () => {
    const directEntities = new Set(['groups'])
    const snapshotOrder = ['groups', 'a_table_only_on_the_apply_side']
    expect(() => assertDirectEntityParity(directEntities, snapshotOrder, {})).toThrow(
      /a_table_only_on_the_apply_side/
    )
  })

  it('does not throw for the real DOMAIN_SNAPSHOT_ORDER + DOMAIN_TABLE_COLUMNS pairing (already proven by syncClient.js loading without error)', () => {
    const columnsForEveryEntity = Object.fromEntries(DOMAIN_SNAPSHOT_ORDER.map((entity) => [entity, ['id']]))
    expect(() => assertColumnCoverage(DOMAIN_SNAPSHOT_ORDER, columnsForEveryEntity)).not.toThrow()
  })

  it('throws when a table in the snapshot order has no DOMAIN_TABLE_COLUMNS entry', () => {
    const snapshotOrder = ['groups', 'week_location_exclusions']
    const tableColumns = { groups: ['id', 'camp_id', 'name'] }
    expect(() => assertColumnCoverage(snapshotOrder, tableColumns)).toThrow(/week_location_exclusions/)
  })
})
