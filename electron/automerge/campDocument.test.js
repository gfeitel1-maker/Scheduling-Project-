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
  loadDoc, readRecord, listRecordIds, recordKey } from './campDocument.js'
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
    expect(readRecord(doc, STAGE1_ENTITY, 'day-1')).toEqual({ label: 'Monday' })
  })

  it('accumulates multiple fields and multiple entities', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'sort_order', value: 1 })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-2', field: 'label', value: 'Tuesday' })
    expect(readRecord(doc, STAGE1_ENTITY, 'day-1')).toEqual({ label: 'Monday', sort_order: 1 })
    expect(readRecord(doc, STAGE1_ENTITY, 'day-2')).toEqual({ label: 'Tuesday' })
  })

  it('DELETE_FIELD sentinel removes the whole entity (mirrors applyProjection)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: DELETE_FIELD, value: 1 })
    expect(readRecord(doc, STAGE1_ENTITY, 'day-1')).toBeNull()
  })

  it('an unregistered field is a silent no-op (mirrors applyProjection)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'not_a_field', value: 'x' })
    expect(readRecord(doc, STAGE1_ENTITY, 'day-1')).toBeNull()
  })

  it('coerces booleans the same way the op-log does (true -> "1")', () => {
    let doc = createEmptyDoc()
    // day_of_week is a registered field; use it to prove coercion parity.
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'day_of_week', value: true })
    expect(readRecord(doc, STAGE1_ENTITY, 'day-1').day_of_week).toBe('1')
  })

  it('refuses an entity outside the modeled scope (explicit scope — week_activity_exclusions is now modeled too, since the parent-scoped entities slice; see parentScoped.test.js)', () => {
    const doc = createEmptyDoc()
    expect(() =>
      applyWrite(doc, { entity: 'compound_cell_decisions', entity_id: 'x-1', field: 'anything', value: 1 })
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
    expect(listRecordIds(twice, STAGE1_ENTITY).sort()).toEqual(['day-1', 'day-2', 'day-3'])
    expect(readRecord(twice, STAGE1_ENTITY, 'day-1')).toEqual({ label: 'Monday', sort_order: 0 })
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
      expect(listRecordIds(merged, STAGE1_ENTITY).sort()).toEqual(['day-1', 'day-2', 'day-3'])
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
      expect(['Lunes', 'Montag']).toContain(readRecord(merged, STAGE1_ENTITY, 'day-1').label)
      // ...and BOTH competing values remain inspectable for a human to resolve.
      // Conflicts live on the FIELD's own document key now — a field is its own
      // key, so there is no record object to ask (see the flat-record-shape ADR).
      const conflicts = A.getConflicts(merged[STAGE1_ENTITY], recordKey('day-1', 'label'))
      expect(Object.values(conflicts).sort()).toEqual(['Lunes', 'Montag'])
    })
  })

  // Shared genesis (see campDocument.js's GENESIS_B64 comment): every device must clone the SAME
  // root, not mint its own via A.from(). Tests below prove this pins the actual wire bytes AND
  // that it fixes the regression it exists to close.
  //
  // Parent-scoped entities slice fix (Governor review round): an earlier revision of this file had
  // createEmptyDoc() TOP UP any entity beyond a smaller, frozen GENESIS_ENTITIES list at runtime
  // (`d[entity] = {}` inside an A.change). That reintroduced the exact bug this whole mechanism
  // exists to close, one level down: two devices each independently creating the SAME missing
  // collection is a concurrent map-key create, and Automerge keeps only ONE side's contents,
  // discarding the other silently (visible only via A.getConflicts, which nothing reads).
  // GENESIS_B64 now encodes EVERY collection this document layer can ever write to — see
  // campDocument.js's comment for the full reasoning and the subset guard that makes a future
  // instance of this mistake fail loudly at import time instead of silently at merge time.
  // createEmptyDoc() is therefore back to being a pure clone with no runtime top-up, and its heads
  // are pinned directly again (no `_genesisDocForTests` escape hatch needed — that only existed
  // because top-up made createEmptyDoc()'s output diverge from the untouched root).
  describe('shared genesis', () => {
    // Wire/document-compatibility tripwire, not a characterization test — mirrors
    // electron/sync/campIdHash.test.js's frozen-vector pattern. createEmptyDoc() must always clone
    // the SAME pinned root bytes; if this ever needs its expectation changed to pass, that means
    // the genesis bytes changed, which means every already-running device's persisted doc no
    // longer shares a root with a fresh one from this build — THAT is the break being hidden, not
    // fixed, by updating the expectation. (This value has been deliberately changed twice: in the
    // parent-scoped entities slice, to fix the runtime-top-up bug above, and again in the doc-native
    // ensureExists slice, to add day_overrides to GENESIS_ENTITIES when it was un-deferred — both
    // regenerations are explained and accepted in campDocument.js's GENESIS_B64 comment. Any FUTURE
    // change to this pinned value needs the same explicit justification, not a silent edit.
    //
    // THIRD REGENERATION (users/camps modeling slice, Stage 6 prep): `camps` and `users` added to
    // MODELED_ENTITIES/GENESIS_ENTITIES — see campDocument.js's GENESIS_B64 comment.)
    it('createEmptyDoc always clones the same frozen genesis root', () => {
      const doc = createEmptyDoc()
      expect(A.getHeads(doc)).toEqual([
        '24a5dba6febd3df8f8ffb9e89cc6daf5ef86921bbb0cebee73f0d609f263c26b',
      ])
      // Two independent calls must produce the SAME head every time — a genesis that varied per
      // call (e.g. one deriving fresh randomness or doing a runtime top-up) would defeat the whole
      // point. This is the exact assertion that caught the runtime-top-up regression above.
      expect(A.getHeads(createEmptyDoc())).toEqual(A.getHeads(doc))
    })

    it('two independently-created docs share a root: merge keeps rows from BOTH, zero root conflicts', () => {
      // Regression test for the confirmed bug: A.from(shape) on each device mints its own root,
      // and A.merge of two such roots silently drops one side's entire entity collection. Two
      // createEmptyDoc() calls here simulate two independent devices, each writing a distinct row
      // before ever meeting the other.
      let a = createEmptyDoc()
      let b = createEmptyDoc()
      a = applyWrite(a, { entity: STAGE1_ENTITY, entity_id: 'a-row', field: 'label', value: 'From A' })
      b = applyWrite(b, { entity: STAGE1_ENTITY, entity_id: 'b-row', field: 'label', value: 'From B' })

      const merged = A.merge(A.clone(a), b)

      expect(listRecordIds(merged, STAGE1_ENTITY).sort()).toEqual(['a-row', 'b-row'])
      expect(readRecord(merged, STAGE1_ENTITY, 'a-row').label).toBe('From A')
      expect(readRecord(merged, STAGE1_ENTITY, 'b-row').label).toBe('From B')
      // The bug's signature: a split root shows up as a root-level conflict (A.getConflicts on the
      // top-level document) once merged — a shared genesis has none.
      expect(Object.keys(A.getConflicts(merged) ?? {})).toHaveLength(0)
    })

    // Governor review round regression test: the SAME "concurrent map-key create discards one
    // side" hazard, reproduced for a PARENT-SCOPED entity (week_activity_exclusions) rather than
    // the original days_of_operation. This is the exact scenario that was broken before the
    // GENESIS_B64 regeneration — proves the fix generalizes to every newly-modeled collection, not
    // just the one this describe block happened to already cover.
    it('two independently-created docs each writing a row to a PARENT-SCOPED entity converge: both rows present, zero conflicts on the collection key', () => {
      let a = createEmptyDoc()
      let b = createEmptyDoc()
      a = applyWrite(a, { entity: 'week_activity_exclusions', entity_id: 'wae-a', field: 'week_id', value: 'week-1' })
      b = applyWrite(b, { entity: 'week_activity_exclusions', entity_id: 'wae-b', field: 'week_id', value: 'week-1' })

      const merged = A.merge(A.clone(a), b)

      expect(listRecordIds(merged, 'week_activity_exclusions')).toEqual(['wae-a', 'wae-b'])
      expect(readRecord(merged, 'week_activity_exclusions', 'wae-a').week_id).toBe('week-1')
      expect(readRecord(merged, 'week_activity_exclusions', 'wae-b').week_id).toBe('week-1')
      expect(Object.keys(A.getConflicts(merged) ?? {})).toHaveLength(0)
    })

    // Same regression, for the bulk-replace scope collection (template_slots_scopes) — the
    // third distinct collection SHAPE this document layer has (flat camp-scoped, flat
    // parent-scoped, and bulk-replace scope), each independently exercised here because each is a
    // SEPARATE top-level key in GENESIS_ENTITIES that could individually have been left out.
    it('two independently-created docs each bulk-replacing a DIFFERENT template converge: both scopes present, zero conflicts', () => {
      let a = createEmptyDoc()
      let b = createEmptyDoc()
      a = A.change(a, (d) => {
        d.template_slots_scopes['tpl-a'] = JSON.stringify([{ id: 'slot-a', template_id: 'tpl-a' }])
      })
      b = A.change(b, (d) => {
        d.template_slots_scopes['tpl-b'] = JSON.stringify([{ id: 'slot-b', template_id: 'tpl-b' }])
      })

      const merged = A.merge(A.clone(a), b)

      expect(Object.keys(merged.template_slots_scopes).sort()).toEqual(['tpl-a', 'tpl-b'])
      expect(Object.keys(A.getConflicts(merged) ?? {})).toHaveLength(0)
    })
  })
})
