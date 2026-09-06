// @vitest-environment node
//
// Stage 1 (productionize Automerge+libp2p, docs/adr/2026-09-06-productionize-
// automerge-libp2p-sync.md): the Automerge document layer for ONE entity,
// `days_of_operation`, as the first vertical slice. These are the PURE
// document tests — no SQLite. The SQLite projection + op-log parity live in
// projector.test.js. Nothing here touches the live app; it is additive.
import { describe, it, expect } from 'vitest'
import * as A from '@automerge/automerge'
import {
  STAGE1_ENTITY,
  STAGE1_FIELDS,
  createEmptyDoc,
  applyWrite,
  saveDoc,
  loadDoc,
} from './campDocument.js'
import { DELETE_FIELD } from '../ops/operations.js'
import { PROJECTIONS } from '../ops/projections.js'

describe('campDocument — Stage 1 Automerge doc for days_of_operation', () => {
  it('starts empty with the entity collection present', () => {
    const doc = createEmptyDoc()
    expect(doc[STAGE1_ENTITY]).toEqual({})
  })

  it('applies a field write into the entity collection', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    expect(doc[STAGE1_ENTITY]['day-1']).toEqual({ label: 'Monday' })
  })

  it('accumulates multiple fields and multiple entities', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'sort_order', value: 1 })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-2', field: 'label', value: 'Tuesday' })
    expect(doc[STAGE1_ENTITY]['day-1']).toEqual({ label: 'Monday', sort_order: 1 })
    expect(doc[STAGE1_ENTITY]['day-2']).toEqual({ label: 'Tuesday' })
  })

  it('DELETE_FIELD sentinel removes the whole entity (mirrors applyProjection)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: DELETE_FIELD, value: 1 })
    expect(doc[STAGE1_ENTITY]['day-1']).toBeUndefined()
  })

  it('an unregistered field is a silent no-op (mirrors applyProjection)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'not_a_field', value: 'x' })
    expect(doc[STAGE1_ENTITY]['day-1']).toBeUndefined()
  })

  it('coerces booleans the same way the op-log does (true -> "1")', () => {
    let doc = createEmptyDoc()
    // day_of_week is a registered field; use it to prove coercion parity.
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'day_of_week', value: true })
    expect(doc[STAGE1_ENTITY]['day-1'].day_of_week).toBe('1')
  })

  it('refuses an entity outside DIRECT_CAMP_ENTITIES (explicit scope — Stage 3 widened to all direct camp entities, not just days_of_operation)', () => {
    const doc = createEmptyDoc()
    expect(() =>
      applyWrite(doc, { entity: 'week_activity_exclusions', entity_id: 'x-1', field: 'week_id', value: 'w-1' })
    ).toThrow()
  })

  it('save/load round-trips the document byte-for-byte in content', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    const bytes = saveDoc(doc)
    const reloaded = loadDoc(bytes)
    expect(reloaded[STAGE1_ENTITY]).toEqual(doc[STAGE1_ENTITY])
  })

  it('save/load round-trips MULTIPLE entities + fields, and stays writable after reload', () => {
    // Red Hat coverage gap: the basic round-trip test only covered one field on
    // one entity. Prove a realistic multi-entity/multi-field doc survives a
    // save->load and can still take further writes afterward.
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'sort_order', value: 0 })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-2', field: 'label', value: 'Tuesday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-2', field: 'day_of_week', value: 2 })
    let reloaded = loadDoc(saveDoc(doc))
    expect(reloaded[STAGE1_ENTITY]).toEqual(doc[STAGE1_ENTITY])
    reloaded = applyWrite(reloaded, { entity: STAGE1_ENTITY, entity_id: 'day-3', field: 'label', value: 'Wednesday' })
    const twice = loadDoc(saveDoc(reloaded))
    expect(Object.keys(twice[STAGE1_ENTITY]).sort()).toEqual(['day-1', 'day-2', 'day-3'])
    expect(twice[STAGE1_ENTITY]['day-1']).toEqual({ label: 'Monday', sort_order: 0 })
  })

  it('STAGE1_FIELDS matches PROJECTIONS.days_of_operation.fields exactly (drift guard)', () => {
    // If the op-log projection's field list changes, this fails loudly rather
    // than letting the doc layer silently project a stale column set.
    expect(STAGE1_FIELDS).toEqual(PROJECTIONS[STAGE1_ENTITY].fields)
  })

  describe('CRDT convergence + conflict surfacing (the property the op-log lacked)', () => {
    it('independent edits to different entities converge', () => {
      let a = createEmptyDoc()
      a = applyWrite(a, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
      let b = A.clone(a)
      a = applyWrite(a, { entity: STAGE1_ENTITY, entity_id: 'day-2', field: 'label', value: 'Tuesday' })
      b = applyWrite(b, { entity: STAGE1_ENTITY, entity_id: 'day-3', field: 'label', value: 'Wednesday' })
      const merged = A.merge(A.clone(a), b)
      expect(Object.keys(merged[STAGE1_ENTITY]).sort()).toEqual(['day-1', 'day-2', 'day-3'])
    })

    it('a concurrent same-field edit converges deterministically AND surfaces both values', () => {
      let base = createEmptyDoc()
      base = applyWrite(base, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
      let a = A.clone(base)
      let b = A.clone(base)
      a = applyWrite(a, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Lunes' })
      b = applyWrite(b, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Montag' })
      const merged = A.merge(A.clone(a), b)
      // Deterministic single winner...
      expect(['Lunes', 'Montag']).toContain(merged[STAGE1_ENTITY]['day-1'].label)
      // ...and BOTH competing values remain inspectable for a human to resolve.
      const conflicts = A.getConflicts(merged[STAGE1_ENTITY]['day-1'], 'label')
      expect(Object.values(conflicts).sort()).toEqual(['Lunes', 'Montag'])
    })
  })
})
