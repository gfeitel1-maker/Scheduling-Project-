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
import { createEmptyDoc, applyWrite, readRecord, recordKey } from './campDocument.js'
import { reconcile, assertNoUnrecordedConflicts, resolveConflictInDoc } from './reconcile.js'

const write = (doc, entity, entity_id, field, value) =>
  applyWrite(doc, { entity, entity_id, field, value })

/** Two devices, one shared genesis, each editing independently — then merged
 * the way a real pair of devices merge. */
function diverge(base, editA, editB) {
  return { a: editA(A.clone(base)), b: editB(A.clone(base)) }
}

describe('the flat record shape removes the job that used to be here', () => {
  // This block replaces a whole describe() of union tests. Those covered
  // recovering a field that a merge had silently discarded — measured at 400
  // merges with ZERO preserving both sides. Under one document key per field
  // (docs/adr/2026-09-08-flat-record-shape.md) there is nothing to recover:
  // two devices writing different fields write different keys and never
  // collide. Their deletion is the evidence the class of bug is gone rather
  // than handled, which is why this test exists in their place.
  it('keeps both devices\' fields with no reconciliation at all', () => {
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(d, 'activities', 'x1', 'name', 'Archery'),
      (d) => write(d, 'activities', 'x1', 'location', 'Lakeside')
    )
    const merged = A.merge(A.clone(a), b)

    // Straight out of the merge — before reconcile is even called.
    expect(readRecord(merged, 'activities', 'x1')).toEqual({ name: 'Archery', location: 'Lakeside' })

    const { doc, conflicts } = reconcile(merged)
    expect(conflicts).toEqual([])
    expect(doc).toBe(merged) // nothing written, nothing to write
  })

  it('cannot produce a contested record, so a resolution always sticks', () => {
    // The old shape let two devices each create the record, which no ordinary
    // write could then resolve. There is no record object to contest now.
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'playground')
    )
    const merged = A.merge(A.clone(a), b)
    expect(reconcile(merged).conflicts).toHaveLength(1)

    const resolved = resolveConflictInDoc(merged, {
      entity: 'template_slots', entityId: 's1', field: 'activity_id', value: 'archery',
    })
    expect(reconcile(resolved).conflicts).toEqual([])
    expect(readRecord(resolved, 'template_slots', 's1').activity_id).toBe('archery')
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
    const before = readRecord(merged, 'template_slots', 's1').activity_id
    const { doc } = reconcile(merged)
    expect(readRecord(doc, 'template_slots', 's1').activity_id).toBe(before)
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
    expect(Object.keys(A.getConflicts(merged.template_slots, recordKey('s1', 'activity_id'))).length).toBe(2)
    // ...and this must not become a prompt.
    expect(reconcile(merged).conflicts).toEqual([])
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
    expect(readRecord(peer, 'template_slots', 's1').activity_id).toBe('archery')
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

// The bug scenario 28 was actually catching, and the reason it failed ~50% of
// runs rather than always: it only fires when the RECORD KEY is contested, not
// merely a field. Two devices writing the same new slot id each create the
// record, so which path reports depends on how the writes interleave.
describe('resolveConflictInDoc — a decision has to stick, without costing someone else theirs', () => {
  const contestedRecord = () => {
    const { a, b } = diverge(
      createEmptyDoc(),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'playground')
    )
    return A.merge(A.clone(a), b)
  }

  it('settles an ordinary field disagreement, including the value already showing', () => {
    // The owner's case, and the common one: the record exists everywhere and
    // two people change the same cell. Choosing the value already on screen is
    // the likeliest thing a person does, and is the shape where a plain
    // assignment risks writing nothing at all.
    const base = write(createEmptyDoc(), 'template_slots', 's1', 'activity_id', 'basketball')
    const { a, b } = diverge(
      base,
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'archery'),
      (d) => write(d, 'template_slots', 's1', 'activity_id', 'playground')
    )
    const merged = A.merge(A.clone(a), b)
    const showing = readRecord(merged, 'template_slots', 's1').activity_id
    const resolved = resolveConflictInDoc(merged, {
      entity: 'template_slots', entityId: 's1', field: 'activity_id', value: showing,
    })
    expect(reconcile(resolved).conflicts).toEqual([])
    expect(readRecord(resolved, 'template_slots', 's1').activity_id).toBe(showing)
  })

  // Carried forward from the shape that made it possible. An earlier design
  // resolved a contested record by reassigning the whole record, which cleared
  // the conflict and SILENTLY discarded any concurrent write to a different
  // field of that record — `getConflicts` returned nothing, so nobody was ever
  // told. The flat shape makes that particular mistake unavailable, but the
  // invariant it violated is worth asserting in terms that survive the next
  // shape change: settling one field must never disturb another.
  it('leaves a colleague\'s concurrent edit to a different field untouched', () => {
    const contested = contestedRecord()
    const resolved = resolveConflictInDoc(A.clone(contested), {
      entity: 'template_slots', entityId: 's1', field: 'activity_id', value: 'archery',
    })
    const colleague = write(A.clone(contested), 'template_slots', 's1', 'flags', 'bring-sunscreen')
    const merged = A.merge(A.clone(resolved), colleague)

    const row = readRecord(merged, 'template_slots', 's1')
    expect(row.activity_id).toBe('archery')
    expect(row.flags).toBe('bring-sunscreen')
    expect(reconcile(merged).conflicts).toEqual([])
  })

})
