// @vitest-environment node
//
// docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md, Decision 1.
// Pure document operations, mirroring reconcile.test.js's discipline: the property under test
// is "two devices derive the same answer from the same bytes", so no SQLite, no libp2p, no clock.
//
// reconcile.js's scalar path is per-FIELD: it walks `getConflicts` on one document key at a time,
// which only ever fires when two devices write the SAME key. Two devices each minting a NEW
// `days_of_operation` row for Tuesday write two entirely different keys (different entityIds) —
// Automerge never sees a conflict, and `reconcile()` reports zero. That is exactly the case this
// module exists for: grouping every record of an entity by its scoped unique value, not walking
// keys.
import { describe, it, expect } from 'vitest'
import * as A from '@automerge/automerge'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { deriveUniqueConflicts, assertNoUnrecordedUniqueConflicts } from './uniqueConflicts.js'

const write = (doc, entity, entity_id, field, value) =>
  applyWrite(doc, { entity, entity_id, field, value })

function diverge(base, editA, editB) {
  return { a: editA(A.clone(base)), b: editB(A.clone(base)) }
}

describe('deriveUniqueConflicts', () => {
  it('finds two whole records of a hard-set entity sharing a scoped unique value', () => {
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => {
        d = write(d, 'days_of_operation', 'day-a', 'camp_id', 'camp-1')
        return write(d, 'days_of_operation', 'day-a', 'day_of_week', 2)
      },
      (d) => {
        d = write(d, 'days_of_operation', 'day-b', 'camp_id', 'camp-1')
        return write(d, 'days_of_operation', 'day-b', 'day_of_week', 2)
      }
    )
    const merged = A.merge(A.clone(a), b)

    // The scalar reconciler sees no conflict at all — a different key per device, never the same
    // field. This is the exact gap deriveUniqueConflicts exists to close.
    const conflicts = deriveUniqueConflicts(merged)
    expect(conflicts).toEqual([
      {
        entity: 'days_of_operation',
        scopeId: 'camp-1',
        field: 'day_of_week',
        entityIds: ['day-a', 'day-b'],
        values: [
          { entityId: 'day-a', record: { camp_id: 'camp-1', day_of_week: 2 } },
          { entityId: 'day-b', record: { camp_id: 'camp-1', day_of_week: 2 } },
        ],
      },
    ])
  })

  it('does not flag two records with different scoped values', () => {
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => {
        d = write(d, 'days_of_operation', 'day-a', 'camp_id', 'camp-1')
        return write(d, 'days_of_operation', 'day-a', 'day_of_week', 1)
      },
      (d) => {
        d = write(d, 'days_of_operation', 'day-b', 'camp_id', 'camp-1')
        return write(d, 'days_of_operation', 'day-b', 'day_of_week', 2)
      }
    )
    const merged = A.merge(A.clone(a), b)
    expect(deriveUniqueConflicts(merged)).toEqual([])
  })

  it('does not flag two records that only share an unset/empty field', () => {
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(d, 'users', 'u-a', 'camp_id', 'camp-1'),
      (d) => write(d, 'users', 'u-b', 'camp_id', 'camp-1')
    )
    const merged = A.merge(A.clone(a), b)
    // Both users have no `name` written at all (ensureExists-style placeholder), so there is
    // nothing to collide on yet.
    expect(deriveUniqueConflicts(merged)).toEqual([])
  })

  it('resolving on either device (renaming one record) clears the collision', () => {
    let doc = createEmptyDoc()
    doc = write(doc, 'days_of_operation', 'day-a', 'camp_id', 'camp-1')
    doc = write(doc, 'days_of_operation', 'day-a', 'day_of_week', 2)
    doc = write(doc, 'days_of_operation', 'day-b', 'camp_id', 'camp-1')
    doc = write(doc, 'days_of_operation', 'day-b', 'day_of_week', 2)
    expect(deriveUniqueConflicts(doc)).toHaveLength(1)

    doc = write(doc, 'days_of_operation', 'day-b', 'day_of_week', 3)
    expect(deriveUniqueConflicts(doc)).toEqual([])
  })

  it('derives byte-identical output regardless of record-write order (cross-device determinism)', () => {
    // Same logical document, records added in reversed order — proves ordering is a property of
    // the derivation, not an accident of insertion order.
    let forward = createEmptyDoc()
    forward = write(forward, 'days_of_operation', 'day-a', 'camp_id', 'camp-1')
    forward = write(forward, 'days_of_operation', 'day-a', 'day_of_week', 2)
    forward = write(forward, 'days_of_operation', 'day-b', 'camp_id', 'camp-1')
    forward = write(forward, 'days_of_operation', 'day-b', 'day_of_week', 2)
    forward = write(forward, 'users', 'u-a', 'camp_id', 'camp-1')
    forward = write(forward, 'users', 'u-a', 'name', 'Alex')
    forward = write(forward, 'users', 'u-b', 'camp_id', 'camp-1')
    forward = write(forward, 'users', 'u-b', 'name', 'Alex')

    let reversed = createEmptyDoc()
    reversed = write(reversed, 'users', 'u-b', 'name', 'Alex')
    reversed = write(reversed, 'users', 'u-b', 'camp_id', 'camp-1')
    reversed = write(reversed, 'users', 'u-a', 'name', 'Alex')
    reversed = write(reversed, 'users', 'u-a', 'camp_id', 'camp-1')
    reversed = write(reversed, 'days_of_operation', 'day-b', 'day_of_week', 2)
    reversed = write(reversed, 'days_of_operation', 'day-b', 'camp_id', 'camp-1')
    reversed = write(reversed, 'days_of_operation', 'day-a', 'day_of_week', 2)
    reversed = write(reversed, 'days_of_operation', 'day-a', 'camp_id', 'camp-1')

    expect(deriveUniqueConflicts(reversed)).toEqual(deriveUniqueConflicts(forward))
  })
})

describe('assertNoUnrecordedUniqueConflicts', () => {
  it('throws when a derived collision is absent from the recorded set', () => {
    let doc = createEmptyDoc()
    doc = write(doc, 'days_of_operation', 'day-a', 'camp_id', 'camp-1')
    doc = write(doc, 'days_of_operation', 'day-a', 'day_of_week', 2)
    doc = write(doc, 'days_of_operation', 'day-b', 'camp_id', 'camp-1')
    doc = write(doc, 'days_of_operation', 'day-b', 'day_of_week', 2)

    expect(() => assertNoUnrecordedUniqueConflicts(doc, [])).toThrow(/silently discarded/)
  })

  it('does not throw once the collision is recorded', () => {
    let doc = createEmptyDoc()
    doc = write(doc, 'days_of_operation', 'day-a', 'camp_id', 'camp-1')
    doc = write(doc, 'days_of_operation', 'day-a', 'day_of_week', 2)
    doc = write(doc, 'days_of_operation', 'day-b', 'camp_id', 'camp-1')
    doc = write(doc, 'days_of_operation', 'day-b', 'day_of_week', 2)

    const recorded = [{ entity: 'days_of_operation', entityIds: ['day-a', 'day-b'], field: 'day_of_week' }]
    expect(() => assertNoUnrecordedUniqueConflicts(doc, recorded)).not.toThrow()
  })
})
