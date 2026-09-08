// @vitest-environment node
//
// docs/adr/2026-09-08-crdt-conflict-reconciliation.md. Pure document
// operations — no SQLite, no libp2p, no clock — because the property under
// test is "two devices derive the same answer from the same bytes", and
// anything asynchronous would only obscure it.
//
// The two jobs, which must never collapse into one:
//   1. non-overlapping fields are UNIONED, silently — nobody adjudicates
//      "A set the name, B set the location";
//   2. a scalar field with two DIFFERENT values is SURFACED and never resolved
//      here — that is two people disagreeing, and the app does not pick.
import { describe, it, expect } from 'vitest'
import * as A from '@automerge/automerge'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { reconcile, assertNoUnrecordedConflicts } from './reconcile.js'

const write = (doc, entity, entity_id, field, value) =>
  applyWrite(doc, { entity, entity_id, field, value })

/** Two devices, one shared genesis, each editing independently — then merged
 * the way a real pair of devices merge. */
function diverge(base, editA, editB) {
  return { a: editA(A.clone(base)), b: editB(A.clone(base)) }
}

describe('reconcile — job 1: union what nobody needs to adjudicate', () => {
  it('recovers a field that would otherwise be silently discarded', () => {
    // The measured defect: 400 merges, not one preserved both sides.
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(d, 'activities', 'x1', 'name', 'Archery'),
      (d) => write(d, 'activities', 'x1', 'location', 'Lakeside')
    )
    const merged = A.merge(A.clone(a), b)
    expect(Object.keys(merged.activities.x1)).toHaveLength(1) // one side lost

    const { doc, conflicts, unioned } = reconcile(merged)
    expect(doc.activities.x1).toMatchObject({ name: 'Archery', location: 'Lakeside' })
    expect(unioned).toHaveLength(1)
    // Nobody is asked about it. This is the half that must stay silent —
    // prompting here trains a director to dismiss prompts.
    expect(conflicts).toEqual([])
  })

  it('is idempotent, so two devices do not write unions at each other forever', () => {
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(d, 'activities', 'x1', 'name', 'Archery'),
      (d) => write(d, 'activities', 'x1', 'location', 'Lakeside')
    )
    const once = reconcile(A.merge(A.clone(a), b))
    const twice = reconcile(once.doc)
    expect(twice.unioned).toEqual([])
    expect(twice.doc).toBe(once.doc) // no change written at all
  })

  it('does not reassign the record key, so the conflict stays derivable', () => {
    // Assigning the key would look tidier and lose the evidence — and with it
    // this module's own guarantee. See reconcile.js's header.
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(d, 'activities', 'x1', 'name', 'Archery'),
      (d) => write(d, 'activities', 'x1', 'location', 'Lakeside')
    )
    const { doc } = reconcile(A.merge(A.clone(a), b))
    expect(Object.keys(A.getConflicts(doc.activities, 'x1') ?? {}).length).toBe(2)
  })
})

describe('reconcile — job 2: surface a real disagreement, never resolve it', () => {
  // The owner's case, and the ordinary one: two people editing the same cell.
  const base = write(createEmptyDoc(), 'template_slots', 's1', 'activity_id', 'basketball')

  it('reports two people choosing differently for the same slot', () => {
    const { a, b } = diverge(
      base,
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'playground')
    )
    const { conflicts } = reconcile(A.merge(A.clone(a), b))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ entity: 'template_slots', entityId: 's1', field: 'activity_id' })
    expect(conflicts[0].values.map((v) => v.value).sort()).toEqual(['archery', 'playground'])
  })

  it('does not pick a winner — the document is left as it was', () => {
    const { a, b } = diverge(
      base,
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'playground')
    )
    const merged = A.merge(A.clone(a), b)
    const before = merged.template_slots.s1.activity_id
    const { doc, unioned } = reconcile(merged)
    expect(doc.template_slots.s1.activity_id).toBe(before)
    expect(unioned).toEqual([])
  })

  // Caught in review before implementation, and it is the trap the obvious
  // implementation falls into: Automerge tracks concurrent OPERATIONS, not
  // distinct VALUES, so `getConflicts(...).length > 1` flags agreement as a
  // collision. A director must never be asked to choose between archery and
  // archery on a schedule that is already correct.
  it('treats the same value from both devices as agreement, not a collision', () => {
    const { a, b } = diverge(
      base,
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery')
    )
    const merged = A.merge(A.clone(a), b)
    // Automerge really does report two conflicting ops here...
    expect(Object.keys(A.getConflicts(merged.template_slots.s1, 'activity_id')).length).toBe(2)
    // ...and this must not become a prompt.
    expect(reconcile(merged).conflicts).toEqual([])
  })

  it('records a disagreement inside a concurrently-created record, rather than unioning it', () => {
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(write(d, 'activities', 'x1', 'name', 'Archery'), 'activities', 'x1', 'location', 'Field'),
      (d) => write(write(d, 'activities', 'x1', 'name', 'Archery'), 'activities', 'x1', 'location', 'Lake')
    )
    const { conflicts, unioned } = reconcile(A.merge(A.clone(a), b))
    // `name` agrees on both sides, so it is not a conflict and not a union.
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].field).toBe('location')
    expect(unioned.map((u) => u.field)).not.toContain('location')
  })
})

describe('reconcile — the property that makes "both devices see it" free', () => {
  const base = write(createEmptyDoc(), 'template_slots', 's1', 'activity_id', 'basketball')
  const { a, b } = diverge(
    base,
    (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
    (d) => write(d, 'template_slots', 's1', 'activity_id', 'playground')
  )

  it('derives the same conflicts on both devices, in the same order', () => {
    // Each device merges the OTHER into its own copy — opposite merge orders,
    // which is what actually happens on a LAN.
    const onA = reconcile(A.merge(A.clone(a), b)).conflicts
    const onB = reconcile(A.merge(A.clone(b), a)).conflicts
    expect(onA).toEqual(onB)
  })

  it('survives being saved and reloaded, so a restarted device still shows it', () => {
    // If conflict information did not survive A.save/A.load, a device that
    // restarted would silently keep the winner and this whole design would
    // collapse. It does survive.
    const merged = A.merge(A.clone(a), b)
    const reloaded = A.load(A.save(merged))
    expect(reconcile(reloaded).conflicts).toEqual(reconcile(merged).conflicts)
  })

  it('clears everywhere once a human chooses, with nothing to broadcast', () => {
    const merged = A.merge(A.clone(a), b)
    expect(reconcile(merged).conflicts).toHaveLength(1)

    // Resolution is an ordinary document write that dominates both values.
    const resolved = write(merged, 'template_slots', 's1', 'activity_id', 'archery')
    expect(reconcile(resolved).conflicts).toEqual([])

    // And it clears on the peer by the same mechanism that surfaced it —
    // no "resolved" message, no synced resolution state.
    const peer = A.merge(A.clone(A.merge(A.clone(b), a)), resolved)
    expect(reconcile(peer).conflicts).toEqual([])
    expect(peer.template_slots.s1.activity_id).toBe('archery')
  })

  it('resurfaces when two people resolve the same conflict differently', () => {
    const merged = A.merge(A.clone(a), b)
    const { a: r1, b: r2 } = diverge(
      merged,
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'swimming')
    )
    const { conflicts } = reconcile(A.merge(A.clone(r1), r2))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].values.map((v) => v.value).sort()).toEqual(['archery', 'swimming'])
  })

  it('clears when two people happen to resolve it the same way', () => {
    const merged = A.merge(A.clone(a), b)
    const { a: r1, b: r2 } = diverge(
      merged,
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery')
    )
    expect(reconcile(A.merge(A.clone(r1), r2)).conflicts).toEqual([])
  })
})

describe('assertNoUnrecordedConflicts — no path around it', () => {
  const base = write(createEmptyDoc(), 'template_slots', 's1', 'activity_id', 'basketball')
  const { a, b } = diverge(
    base,
    (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
    (d) => write(d, 'template_slots', 's1', 'activity_id', 'playground')
  )

  it('throws when a document carries a conflict nobody was told about', () => {
    // The failure this exists to make impossible: a path that merges and
    // projects without reconciling. Its symptom would be identical to the bug
    // itself — a director's edit silently discarded — so it must be loud.
    expect(() => assertNoUnrecordedConflicts(A.merge(A.clone(a), b), [])).toThrow(
      /never recorded/
    )
  })

  it('passes once the conflict has been recorded', () => {
    const merged = A.merge(A.clone(a), b)
    const { conflicts } = reconcile(merged)
    expect(() => assertNoUnrecordedConflicts(merged, conflicts)).not.toThrow()
  })

  it('passes for an ordinary document with nothing concurrent in it', () => {
    expect(() => assertNoUnrecordedConflicts(base, [])).not.toThrow()
  })
})
