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
  applyWrites,
  saveDoc,
  loadDoc, readRecord, listRecordIds, recordKey, PROVENANCE_COLLECTION, AUTHOR_COLLECTION } from './campDocument.js'
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

    // T267 (docs/adr/2026-09-26-fixed-recurring-event-identity-model.md): two devices concurrently
    // re-linking the same fixed_events row to a different catalog activity_id — e.g. one re-links
    // it after a rename, the other after a merge — is a same-field conflict, which the ADR predicts
    // "falls out of the existing per-field CRDT model for free, exactly like every other field on
    // this entity does today." No new conflict-handling code was written for this; this test proves
    // that prediction rather than assuming it.
    it('a concurrent activity_id re-link on the same fixed_events row surfaces via A.getConflicts, not silent last-write-wins', () => {
      let base = createEmptyDoc()
      base = applyWrite(base, { entity: 'fixed_events', entity_id: 'anchor-1', field: 'camp_id', value: 'camp-1' })
      base = applyWrite(base, { entity: 'fixed_events', entity_id: 'anchor-1', field: 'name', value: 'Swim' })
      base = applyWrite(base, { entity: 'fixed_events', entity_id: 'anchor-1', field: 'activity_id', value: 'act-swim-1' })
      let a = A.clone(base)
      let b = A.clone(base)
      a = applyWrite(a, { entity: 'fixed_events', entity_id: 'anchor-1', field: 'activity_id', value: 'act-swim-2' })
      b = applyWrite(b, { entity: 'fixed_events', entity_id: 'anchor-1', field: 'activity_id', value: 'act-swim-3' })
      const merged = A.merge(A.clone(a), b)
      // Deterministic single winner...
      expect(['act-swim-2', 'act-swim-3']).toContain(readRecord(merged, 'fixed_events', 'anchor-1').activity_id)
      // ...and BOTH competing values remain inspectable, exactly like the name-field case above —
      // no bespoke merge logic exists for activity_id, and none was added.
      const conflicts = A.getConflicts(merged.fixed_events, recordKey('anchor-1', 'activity_id'))
      expect(Object.values(conflicts).sort()).toEqual(['act-swim-2', 'act-swim-3'])
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
    // MODELED_ENTITIES/GENESIS_ENTITIES — see campDocument.js's GENESIS_B64 comment.
    //
    // FIFTH REGENERATION (author attribution): `field_author` added — who last set each field, so
    // record history and Trash can name a person for a change that arrived from another device.
    // Same acceptance as every regeneration below.
    //
    // FOURTH REGENERATION (field provenance,
    // docs/adr/2026-09-09-field-provenance-in-the-document.md): the
    // `field_provenance` collection was added to GENESIS_ENTITIES. It had to go in
    // the genesis rather than be created on first use for exactly the reason this
    // whole mechanism exists — two devices each running `d.field_provenance = {}`
    // is a concurrent create of the same map key, which Automerge resolves by
    // keeping one side and discarding the other into A.getConflicts, which nothing
    // reads. Same acceptance as the three prior regenerations: pre-production, no
    // live camps on this sync engine, existing `.automerge` files may be
    // discarded.)
    // SIXTH REGENERATION (T194, the participant data substrate, docs/adr/2026-09-17-
    // individual-elective-scheduling.md D13): the seven participant entities —
    // campers, elective_assignment_runs, elective_occurrences, elective_choices,
    // elective_choice_offerings, elective_preferences, elective_assignments — were
    // added to MODELED_ENTITIES (automatically, since it is derived) and therefore
    // to GENESIS_ENTITIES, and GENESIS_B64 was regenerated.
    //
    // ACCEPTANCE: every existing `.automerge` file is invalidated and every paired
    // device must re-pair. Free ONLY because the owner confirmed on 2026-09-17 that
    // the project is pre-production and no real camp document exists.
    //
    // If this expectation ever needs to change to make the test pass, that is a
    // document-compatibility break being HIDDEN, not fixed — see the comment above.
    // The regeneration recipe is in campDocument.js and was verified to reproduce
    // the PREVIOUS genesis byte for byte before being used to make this one.
    // SEVENTH REGENERATION (T233, docs/adr/2026-09-19-multi-device-erasure-propagation.md):
    // `tombstones` added to MODELED_ENTITIES/GENESIS_ENTITIES — see campDocument.js's GENESIS_B64
    // comment. Same acceptance as every regeneration above.
    //
    // NINTH REGENERATION (T267, docs/adr/2026-09-26-fixed-recurring-event-identity-model.md): the
    // document key `anchor_activities` renamed to `fixed_events` — see campDocument.js's GENESIS_B64
    // comment for why this regeneration, unlike every prior one, does not keep the old key as an
    // orphan. Same acceptance as every regeneration above.
    //
    // TENTH REGENERATION (T301, docs/adr/2026-09-29-linked-elective-bundles.md): `elective_bundles`,
    // `elective_bundle_periods` and `elective_bundle_tiers` added to MODELED_ENTITIES/
    // GENESIS_ENTITIES — see campDocument.js's GENESIS_B64 comment. Same acceptance as every
    // ELEVENTH REGENERATION (T312): `camp_seedlings` added to DIRECT_CAMP_ENTITIES and so,
    // automatically, to MODELED_ENTITIES — which forced it into GENESIS_ENTITIES and forced this
    // regeneration. An APPEND: no existing key changes meaning. Same acceptance as every
    // regeneration above.
    //
    // TWELFTH REGENERATION (T320, docs/adr/2026-09-30-elective-run-durability.md item 4):
    // `elective_run_findings` added to PARENT_SCOPED_ENTITIES and so, automatically, to
    // MODELED_ENTITIES — same forcing function. An APPEND. Same acceptance as every regeneration
    // above.
    //
    // THIRTEENTH REGENERATION (T321, docs/adr/2026-10-01-camper-id-high-entropy-format.md):
    // `camper_identity_keys` added to DIRECT_CAMP_ENTITIES and so, automatically, to
    // MODELED_ENTITIES — same forcing function. Same acceptance as every regeneration above.
    it('createEmptyDoc always clones the same frozen genesis root', () => {
      const doc = createEmptyDoc()
      expect(A.getHeads(doc)).toEqual([
        '012398ef68af7ea00c6d8b20b5a9bacaa47cd9b0462089d127df77e1bf09310b',
      ])
      // Two independent calls must produce the SAME head every time — a genesis that varied per
      // call (e.g. one deriving fresh randomness or doing a runtime top-up) would defeat the whole
      // point. This is the exact assertion that caught the runtime-top-up regression above.
      //
      // T271 round 3 (docs/adr/2026-09-26-schema-version-gate-before-merge.md, Verification item
      // 5): this is also the genesis-identity tripwire for the ROUND-1 T271 mechanism that used to
      // live here (a synthetic schemaVersion-stamping change on genesisDoc(), removed in round 3 in
      // favor of a per-device handshake value — see syncNode.js's peerSchemaVersions). This
      // assertion alone catches any future re-introduction of a per-call side effect on
      // genesisDoc() — a repeat of round 1's mistake would immediately break it.
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

// --- applyWrites: one A.change for a run of writes --------------------------
//
// The batched path must be indistinguishable from the per-write path in
// MATERIALISED STATE. Saved BYTES are deliberately NOT compared: one change
// legitimately encodes differently from N changes, and a byte comparison would
// be a false red that the next person "fixes" by weakening the test.
describe('campDocument — applyWrites batches a run into one change', () => {
  // Both arms must start from the SAME document AND the SAME actor id, or any
  // difference could be an actor artefact rather than a batching one. Neither
  // two `createEmptyDoc()` calls nor two `A.load(A.save(base))` calls share an
  // actor — both mint a fresh random one (measured). So the arms are built with
  // `A.load(bytes, { actor })` against one explicit actor, which is the only
  // construction here that is deterministic.
  const ARM_ACTOR = 'aabbccdd00112233'
  const CONCURRENT_ACTOR = '99887766554433aa'

  // Base: genesis with the `activities` collection removed, so a write to it
  // exercises applyWrite's lazy collection top-up branch.
  const baseBytes = (() => {
    const stripped = A.change(createEmptyDoc(), (d) => {
      delete d.activities
    })
    return A.save(stripped)
  })()

  const armDoc = (actor = ARM_ACTOR) => A.load(baseBytes, { actor })

  // Every branch of applyWrite's per-field body, in one fixture. A fixture that
  // skips a branch proves nothing about that branch.
  const WRITES = [
    // (a) plain write, (c) source omitted, (f) author omitted
    { entity: 'days_of_operation', entity_id: 'd1', field: 'label', value: 'Monday' },
    // (d) source null -> HUMAN_PROVENANCE; author set
    { entity: 'days_of_operation', entity_id: 'd1', field: 'sort_order', value: 1, source: null, author_user_id: 'u1' },
    // (b) source 'import' -> provenance key deleted
    { entity: 'days_of_operation', entity_id: 'd1', field: 'day_of_week', value: true, source: 'import', author_user_id: 'u2' },
    { entity: 'days_of_operation', entity_id: 'd2', field: 'label', value: 'Tue', source: 'human', author_user_id: 'u1' },
    // (e) author_user_id null -> author key deleted
    { entity: 'days_of_operation', entity_id: 'd2', field: 'camp_id', value: 'camp-1', author_user_id: null },
    // (i) field not in PROJECTIONS[entity].fields -> silent return
    { entity: 'days_of_operation', entity_id: 'd2', field: 'not_a_registered_field', value: 'x', source: null, author_user_id: 'u1' },
    // (j) collection absent -> lazy top-up
    { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', source: null, author_user_id: 'u3' },
    // (g) delete: field sweep, provenance/author prefix sweeps, deleted-by tombstone
    { entity: 'days_of_operation', entity_id: 'd1', field: DELETE_FIELD, value: 1, author_user_id: 'u9' },
    // (h) write after the delete -> tombstone cleared
    { entity: 'days_of_operation', entity_id: 'd1', field: 'label', value: 'Monday again', source: null, author_user_id: 'u4' },
    // (k) second write to a field already written -> last wins (and clears provenance)
    { entity: 'days_of_operation', entity_id: 'd2', field: 'label', value: 'Tuesday FINAL', source: 'import' },
  ]

  const COLLECTIONS = ['days_of_operation', 'activities', PROVENANCE_COLLECTION, AUTHOR_COLLECTION]
  const materialise = (doc) =>
    Object.fromEntries(COLLECTIONS.map((c) => [c, JSON.parse(JSON.stringify(doc[c] ?? null))]))

  const perWrite = (writes) => {
    let doc = armDoc()
    for (const w of writes) doc = applyWrite(doc, w)
    return doc
  }

  it('one batched change materialises exactly what N separate changes do', () => {
    const a = perWrite(WRITES)
    const b = applyWrites(armDoc(), WRITES)
    const expected = materialise(a)

    // NON-VACUITY (i): a floor derived from the fixture, so empty-vs-empty fails.
    expect(Object.keys(expected.days_of_operation)).toHaveLength(3) // d1.label, d2.label, d2.camp_id
    expect(Object.keys(expected.activities)).toHaveLength(1)
    expect(Object.keys(expected[PROVENANCE_COLLECTION]).length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(expected[AUTHOR_COLLECTION]).length).toBeGreaterThanOrEqual(3)

    expect(materialise(b)).toEqual(expected)
  })

  it('the equality check is sensitive to write order (mutation check)', () => {
    // NON-VACUITY (ii): reverse the batch and the comparison must FAIL. If it
    // still passes, the assertion above is not actually comparing anything.
    const a = perWrite(WRITES)
    const reversed = applyWrites(armDoc(), [...WRITES].reverse())
    expect(materialise(reversed)).not.toEqual(materialise(a))
  })

  it('applyWrites([one]) is applyWrite', () => {
    const w = { entity: 'days_of_operation', entity_id: 'd9', field: 'label', value: 'Solo', source: null, author_user_id: 'u1' }
    expect(materialise(applyWrites(armDoc(), [w]))).toEqual(materialise(applyWrite(armDoc(), w)))
  })

  it('rejects an unmodeled entity before any op is pending', () => {
    const doc = armDoc()
    expect(() => applyWrites(doc, [
      { entity: 'days_of_operation', entity_id: 'd1', field: 'label', value: 'Monday' },
      { entity: 'not_a_modeled_entity', entity_id: 'x', field: 'y', value: 'z' },
    ])).toThrow()
    // The input document is untouched — the throw happened in the pre-pass.
    expect(readRecord(doc, 'days_of_operation', 'd1')).toBeNull()
  })

  it('a concurrent remote edit conflicts identically against the batched arm', () => {
    // THE SYNC-SEAM TEST. Collapsing N changes into one must not change what a
    // peer's concurrent edit to the same field does on merge.
    const concurrentBytes = A.save(
      applyWrite(armDoc(CONCURRENT_ACTOR), {
        entity: 'days_of_operation',
        entity_id: 'd2',
        field: 'label',
        value: 'CONCURRENT',
        source: null,
        author_user_id: 'u-remote',
      })
    )
    const key = recordKey('d2', 'label')

    const mergedA = A.merge(perWrite(WRITES), A.load(concurrentBytes, { actor: CONCURRENT_ACTOR }))
    const mergedB = A.merge(applyWrites(armDoc(), WRITES), A.load(concurrentBytes, { actor: CONCURRENT_ACTOR }))

    const conflictsA = A.getConflicts(mergedA.days_of_operation, key)
    const conflictsB = A.getConflicts(mergedB.days_of_operation, key)
    expect(Object.values(conflictsA ?? {}).sort()).toEqual(['CONCURRENT', 'Tuesday FINAL'])
    expect(Object.values(conflictsB ?? {}).sort()).toEqual(Object.values(conflictsA ?? {}).sort())
    expect(mergedB.days_of_operation[key]).toBe(mergedA.days_of_operation[key])
  })
})
