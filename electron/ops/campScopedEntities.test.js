import { describe, it, expect } from 'vitest'
import {
  DIRECT_CAMP_ENTITIES,
  PARENT_SCOPED_ENTITIES,
  DOMAIN_SNAPSHOT_ORDER,
  DOMAIN_PARENT_SCOPED_ENTITIES,
  assertDirectEntityParity,
  resolveParentJoinChain,
} from './campScopedEntities.js'

// The registry keeps the same entity set in two shapes — DIRECT_CAMP_ENTITIES (a
// Set, for membership tests) and DOMAIN_SNAPSHOT_ORDER's direct members (an array,
// for FK-safe apply order) — and asserts their parity at import time. These tests
// prove the assertion (a) holds for the real, current registries and (b) actually
// fires, rather than existing as dead code, on synthetic violating input for each
// direction of the drift.
//
// _Prior (T88 review follow-up): the two drifting lists were named as
// "syncServer.js's DIRECT_CAMP_ENTITIES iteration (send side) vs
// DOMAIN_SNAPSHOT_ORDER's direct members (apply side)" — a sentence that had also
// become garbled, naming syncServer.js's iteration twice. That file was deleted at
// the Stage 6c cutover; the two shapes still exist and can still drift, but their
// consumers are now main.js's read path and electron/automerge/._
//
// Stage 6c note: a third map, syncClient.js's DOMAIN_TABLE_COLUMNS, was checked
// here too. It existed only to build the WebSocket first-pairing snapshot, and
// it went with that transport — CRDT sync replicates the document itself, so
// there is no column list to keep in step. The equivalent drift guard for the
// document model lives in electron/automerge/campDocument.test.js.
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

})

// T301 (v81): elective_bundle_periods/elective_bundle_tiers are the first
// PARENT_SCOPED_ENTITIES members whose own parent (elective_bundles) is
// ALSO only parent-scoped, not camp-direct — a hardcoded single JOIN
// (`JOIN parentTable p ON ... WHERE p.camp_id = ?`) produced "no such
// column: p.camp_id" for both, caught by electron/main.test.js's whole-
// schema sweep. resolveParentJoinChain replaced that hardcoded single hop
// with a walk, so these tests pin the walk's shape directly rather than
// relying only on the slow, indirect DB-backed sweep to notice a regression.
describe('resolveParentJoinChain', () => {
  it('a one-hop entity (unchanged shape): exactly one JOIN, straight to its camp-direct parent', () => {
    const { joinSql, campAlias } = resolveParentJoinChain('template_slots')
    expect(joinSql).toBe('JOIN schedule_templates p0 ON p0.id = t.template_id')
    expect(campAlias).toBe('p0')
  })

  it('a two-hop entity: walks through the intermediate parent-scoped table to reach the camp-direct one', () => {
    const { joinSql, campAlias } = resolveParentJoinChain('elective_bundle_periods')
    expect(joinSql).toBe(
      'JOIN elective_bundles p0 ON p0.id = t.bundle_id JOIN elective_sets p1 ON p1.id = p0.elective_set_id'
    )
    expect(campAlias).toBe('p1')
  })

  it('its sibling child (elective_bundle_tiers) gets the identical two-hop treatment — not a fix special-cased to one table', () => {
    const { joinSql, campAlias } = resolveParentJoinChain('elective_bundle_tiers')
    expect(joinSql).toBe(
      'JOIN elective_bundles p0 ON p0.id = t.bundle_id JOIN elective_sets p1 ON p1.id = p0.elective_set_id'
    )
    expect(campAlias).toBe('p1')
  })

  it('throws for an entity that is not parent-scoped at all', () => {
    expect(() => resolveParentJoinChain('not_a_real_entity')).toThrow(/not_a_real_entity.*not parent-scoped/)
  })
})
