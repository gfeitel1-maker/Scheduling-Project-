// @vitest-environment node
//
// T266 — `activities.catalog_role` must raise a CONFLICT when two devices
// disagree, not silently pick a winner and not quietly fail to sync.
//
// WHY THIS IS A REAL REQUIREMENT AND NOT DEFENSIVE PADDING. An activity's
// category is a fact about the CAMP, not an opinion a device holds. Lunch is
// either a fixed event (everyone eats at one time) or a recurring event
// (several shifts); there is no camp where some groups eat at random times. So
// two devices can never LEGITIMATELY differ about it — which means this path
// should essentially never fire in normal operation, and when it does it is not
// noise, it is evidence that one of those devices ingested something wrong.
// Silently picking a winner would be the app choosing which of two contradictory
// versions of the camp to believe, and the losing outcome re-exposes the pinned
// event as a free-choice activity — the owner's original bug, restored silently
// on one device. That is the worst available outcome, and it is exactly what
// last-writer-wins gives you.
//
// WHICH OF THE THREE OUTCOMES THE FIELD HAD BEFORE THIS TICKET: none of them —
// the column did not exist. The honest statement is about what it does NOW, and
// the answer is that it RAISES, by INHERITANCE rather than by anything written
// for it. `PROJECTIONS[entity].fields` (electron/ops/projections.js) is the
// single gate for BOTH syncing and conflict-raising: `applyWrite`
// (electron/automerge/campDocument.js:569) drops any field not in that list, so
// an unregistered field never enters the document and can neither sync nor
// conflict; and `reconcile` (electron/automerge/reconcile.js:75-107) walks EVERY
// key of every collection with `A.getConflicts` and has no field allowlist or
// denylist whatsoever. Registering `catalog_role` so it would materialize in
// SQLite therefore also enrolled it in conflict detection.
//
// NO CODE WAS ADDED TO MAKE THAT LOOK DELIBERATE. This file is the evidence for
// the claim, which is the part that was actually missing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import * as A from '@automerge/automerge'
import { openTemplatedDb } from './db/testDbTemplate.js'
import { createEmptyDoc, applyWrite, recordKey } from './automerge/campDocument.js'
import { reconcileAndRecordConflicts } from './automerge/reconcileForProjection.js'
import { PROJECTIONS } from './ops/projections.js'

let db, tmpFile
const ACT = 'activity-lunch-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
})
afterEach(() => {
  db.close()
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(tmpFile + s)) fs.unlinkSync(tmpFile + s)
})

const write = (doc, field, value) =>
  applyWrite(doc, { entity: 'activities', entity_id: ACT, field, value })

/** Two devices, one shared genesis, each editing independently, then merged the
 *  way a real pair of devices merge. Mirrors electron/automerge/reconcile.test.js. */
function divergeAndMerge(editA, editB) {
  const base = write(createEmptyDoc(), 'name', 'Lunch')
  return A.merge(A.clone(editA(A.clone(base))), editB(A.clone(base)))
}

// Rows as the DATABASE returns them, with columns taken from the SCHEMA
// (electron/db/schema.sql:454) rather than from the shape the code under test
// happens to produce.
const pendingConflicts = () =>
  db.prepare(
    "SELECT id, entity, entity_id, field, incoming_op, existing_op FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'crdt:%'"
  ).all()

describe('catalog_role under an Automerge merge', () => {
  it('is registered, which is the single gate for BOTH syncing and conflict-raising', () => {
    // If this ever stops being true, every test below becomes vacuous — they
    // would pass by never producing a document key at all.
    expect(PROJECTIONS.activities.fields).toContain('catalog_role')
  })

  it('two devices that DISAGREE raise a conflict row for a human', () => {
    reconcileAndRecordConflicts(db, divergeAndMerge(
      (d) => write(d, 'catalog_role', 'pinned_event'),
      (d) => write(d, 'catalog_role', null),
    ))

    const rows = pendingConflicts()
    // Assert the ROW came back, not that a function was called.
    expect(rows).toHaveLength(1)
    expect(rows[0].entity).toBe('activities')
    expect(rows[0].entity_id).toBe(ACT)
    expect(rows[0].field).toBe('catalog_role')
    expect(rows[0].id).toBe(`crdt:activities:${ACT}:catalog_role`)
    // Both sides survive in the row, so the human chooses between two real
    // values rather than being told "something differed".
    const values = [rows[0].incoming_op, rows[0].existing_op].map((s) => JSON.parse(s).value)
    expect(values.map((v) => String(v)).sort()).toEqual(['null', 'pinned_event'])
  })

  it('NON-VACUITY: it is NOT last-writer-wins — the merge does not collapse the two values', () => {
    // If the merge resolved silently, `reconcile` would see fewer than two
    // concurrent versions and record nothing, and the row above would have to
    // come from somewhere else. Checked at the Automerge layer directly: both
    // versions are still present after the merge, so nothing picked a winner.
    const merged = divergeAndMerge(
      (d) => write(d, 'catalog_role', 'pinned_event'),
      (d) => write(d, 'catalog_role', null),
    )
    const versions = A.getConflicts(merged.activities, recordKey(ACT, 'catalog_role'))
    expect(Object.keys(versions ?? {}).length).toBe(2)
  })

  it('NON-VACUITY: an unregistered field raises NOTHING, so registration is what does the work', () => {
    // Plant the defect the mechanism's description does not point at. If
    // `catalog_role` were ever dropped from PROJECTIONS — an easy thing to do
    // while tidying a field list — it would not merely stop materializing in
    // SQLite. It would stop entering the document at all, and two devices
    // disagreeing about it would produce NO conflict and NO error: the app would
    // never notice. Shown directly with a field name that is deliberately not
    // registered.
    const base = applyWrite(createEmptyDoc(), { entity: 'activities', entity_id: ACT, field: 'name', value: 'Lunch' })
    const mk = (v) => applyWrite(A.clone(base), { entity: 'activities', entity_id: ACT, field: 'not_a_registered_field', value: v })
    reconcileAndRecordConflicts(db, A.merge(A.clone(mk('x')), mk('y')))

    expect(pendingConflicts()).toEqual([])
  })

  it('CONTROL: two devices that AGREE raise nothing — a row means a real disagreement', () => {
    // Without this, the disagreement test proves only "merging makes rows".
    reconcileAndRecordConflicts(db, divergeAndMerge(
      (d) => write(d, 'catalog_role', 'pinned_event'),
      (d) => write(d, 'catalog_role', 'pinned_event'),
    ))
    expect(pendingConflicts()).toEqual([])
  })

  it('a disagreement on catalog_role does not entangle other fields of the same activity', () => {
    // The flat record shape means one document key per field. Stated as a test
    // because the design leans on it: a concurrent edit to another field must
    // not be dragged into the category dispute.
    reconcileAndRecordConflicts(db, divergeAndMerge(
      (d) => write(write(d, 'catalog_role', 'pinned_event'), 'min_per_week', 3),
      (d) => write(d, 'catalog_role', null),
    ))
    expect(pendingConflicts().map((r) => r.field)).toEqual(['catalog_role'])
  })
})
