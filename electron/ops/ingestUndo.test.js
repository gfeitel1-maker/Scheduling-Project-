// U1 — grace-window undo, updates-only slice.
// docs/adr/2026-08-17-onescreen-reconciliation-undo.md ("U1 mechanism", Invariants 1-6)
//
// Covers the ADR's decomposition (U1a-U1d):
//   U1a  capture, no undo yet: invertibleOps/createdEntityIds populated correctly;
//        mode:'replace' + captureInverse throws; golden-ops parity (captureInverse
//        changes only what's returned, never what's written); invertibleOps never
//        contains a creation.
//   U1b  the LOAD-BEARING concurrent-write test: a second device's write after
//        capture must be skipped, not clobbered.
//   U1c  device-local seq invariant: ingestUndo's gate uses latestOp (plain seq),
//        not the COALESCE(host_seq, seq) convention.
//   U1d  idempotency / double-undo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
import { commitPlan, ingestUndo } from './ingest.js'

let db, tmpFile, campId
const deviceId = 'device-1'
const peerDeviceId = 'device-2'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ingest-undo-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(peerDeviceId, 'Peer Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const opCount = () => db.prepare('SELECT COUNT(*) c FROM operations').get().c
const dayField = (id, field) => db.prepare(`SELECT ${field} AS v FROM days_of_operation WHERE id = ?`).get(id)?.v
const allOps = () =>
  db.prepare('SELECT entity, entity_id, field, value, source FROM operations ORDER BY seq ASC').all()

function seedDay(id, label, { sort_order, sortSource = 'import' } = {}) {
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'label', value: label, device_id: deviceId, source: 'import' })
  if (sort_order !== undefined) {
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: sort_order, device_id: deviceId, source: sortSource })
  }
}

const basePlan = (overrides) => ({
  plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
  sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
  unresolved: [], items: [],
  ...overrides,
})

const updateItem = (id, label, fields) => ({
  op: 'update', entity: 'days_of_operation', entity_id: id, fields,
  evidence: { tier: 'exact_name', matched_name: label }, _name: label, _humanFields: [],
})

const createDayItem = (name) => ({
  op: 'create', entity: 'days_of_operation', entity_id: null,
  fields: { camp_id: { from: null, to: campId, source: 'import' }, label: { from: null, to: name, source: 'import' } },
  evidence: { tier: 'new' }, _name: name, _humanFields: [],
})

// U2 fixtures — generic create items for entities beyond days_of_operation.
const createTimeBlockItem = (name) => ({
  op: 'create', entity: 'time_blocks', entity_id: null,
  fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: name, source: 'import' } },
  evidence: { tier: 'new' }, _name: name, _humanFields: [],
})
const createLocationItem = (name) => ({
  op: 'create', entity: 'locations', entity_id: null,
  fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: name, source: 'import' } },
  evidence: { tier: 'new' }, _name: name, _humanFields: [],
})
const createActivityItem = (name, fields = {}) => ({
  op: 'create', entity: 'activities', entity_id: null,
  fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: name, source: 'import' }, ...fields },
  evidence: { tier: 'new' }, _name: name, _humanFields: [],
})

describe('U1a — capture at commit time', () => {
  it('mode:"replace" + captureInverse:true throws (Invariant 3)', () => {
    expect(() =>
      commitPlan(db, basePlan({ mode: 'replace', items: [] }), {
        author_user_id: 'u1', device_id: deviceId, captureInverse: true,
      })
    ).toThrow(/captureInverse/)
  })

  it('an update to a pre-existing row is captured in invertibleOps; a create is captured only in createdEntityIds', () => {
    const dayId = randomUUID()
    seedDay(dayId, 'Monday', { sort_order: 1 })

    const res = commitPlan(
      db,
      basePlan({ items: [updateItem(dayId, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } }), createDayItem('Tuesday')] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )

    expect(res.held).toBe(false)
    expect(res.invertibleOps).toHaveLength(1)
    // priorValue is the raw STORED op value (operations.value is TEXT; a JS
    // number binds as REAL, so better-sqlite3 round-trips 1 as the string
    // '1.0' — the same coercion coerceOpValue/appendOp already apply to every
    // op in this codebase, not a bug in the capture).
    expect(res.invertibleOps[0]).toMatchObject({
      entity: 'days_of_operation', entity_id: dayId, field: 'sort_order', priorValue: '1.0', prior_source: 'import',
    })
    expect(res.invertibleOps[0].seq).toBeTypeOf('number')
    expect(res.invertibleOps[0].opId).toBeTypeOf('string')

    // Invariant 6/2: no entry in invertibleOps for an entity_id with no prior op.
    expect(res.invertibleOps.every((e) => e.entity_id !== undefined)).toBe(true)
    const tuesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday')
    expect(res.invertibleOps.some((e) => e.entity_id === tuesday.id)).toBe(false)

    // createdEntityIds carries the creation, informational for U1 — and, as
    // of U2, additionally carries the full-projection-field snapshot U2's
    // creation-deletion gate reads (Finding 2).
    expect(res.createdEntityIds).toEqual([
      { entity: 'days_of_operation', entity_id: tuesday.id, fieldSnapshot: expect.any(Object) },
    ])
  })

  it('golden-ops parity: captureInverse changes only what is RETURNED, never what is WRITTEN', () => {
    const dayIdA = randomUUID()
    const dayIdB = randomUUID()
    seedDay(dayIdA, 'Monday', { sort_order: 1 })
    seedDay(dayIdB, 'Monday2', { sort_order: 1 })

    const opsBefore = opCount()
    commitPlan(db, basePlan({ items: [updateItem(dayIdA, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } }), createDayItem('Tuesday')] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: false })
    const withoutFlag = allOps().slice(opsBefore)

    // Reset to an identical starting state for a second, comparable run.
    db.prepare('DELETE FROM operations').run()
    db.prepare('DELETE FROM days_of_operation').run()
    seedDay(dayIdA, 'Monday', { sort_order: 1 })
    const opsBefore2 = opCount()
    const res2 = commitPlan(db, basePlan({ items: [updateItem(dayIdA, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } }), createDayItem('Tuesday')] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    const withFlag = allOps().slice(opsBefore2)

    // Same shape of ops written (entity/entity_id-pattern/field/value/source),
    // modulo the freshly-minted Tuesday id differing between runs.
    const normalize = (rows) => rows.map((r) => ({ entity: r.entity, field: r.field, value: r.value, source: r.source }))
    expect(normalize(withFlag)).toEqual(normalize(withoutFlag))
    expect(res2.invertibleOps).toHaveLength(1)
  })
})

describe('U1b — the concurrent-write test (load-bearing, proves Invariant 1)', () => {
  it('a field touched by a second device after capture is SKIPPED, not clobbered; every other captured field IS reverted', () => {
    const dayId = randomUUID()
    seedDay(dayId, 'Monday', { sort_order: 1 })
    appendOp(db, { entity: 'days_of_operation', entity_id: dayId, field: 'day_of_week', value: 1, device_id: deviceId, source: 'import' })

    const res = commitPlan(
      db,
      basePlan({ items: [updateItem(dayId, 'Monday', {
        sort_order: { from: 1, to: 9, source: 'import' },
        day_of_week: { from: 1, to: 2, source: 'import' },
      })] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    expect(res.held).toBe(false)
    expect(res.invertibleOps).toHaveLength(2)
    expect(dayField(dayId, 'sort_order')).toBe(9)
    expect(dayField(dayId, 'day_of_week')).toBe(2)

    // A SECOND, independent device writes directly to sort_order, bumping its
    // seq past the captured value — the peer write this test proves undo must
    // never clobber.
    appendOp(db, { entity: 'days_of_operation', entity_id: dayId, field: 'sort_order', value: 42, device_id: peerDeviceId, source: 'human' })

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps,
      author_user_id: 'u1',
      device_id: deviceId,
      client_write_id: randomUUID(),
    })

    expect(undoResult.ok).toBe(true)
    // (a) the concurrently-touched field is NOT reverted.
    expect(dayField(dayId, 'sort_order')).toBe(42)
    // (b) every OTHER captured field IS reverted.
    expect(dayField(dayId, 'day_of_week')).toBe(1)
    // (c) the skip is present in the returned receipt data with the correct field.
    expect(undoResult.skipped).toContainEqual({ entity: 'days_of_operation', entity_id: dayId, field: 'sort_order' })
    expect(undoResult.reverted).toContainEqual({ entity: 'days_of_operation', entity_id: dayId, field: 'day_of_week' })
  })

  it('would clobber the peer write if the seq gate were removed (regression harness sanity check)', () => {
    // Same fixture as above, but asserting the pre-undo peer value really is
    // what a blind restore would have overwritten — guards against the test
    // above accidentally passing for the wrong reason.
    const dayId = randomUUID()
    seedDay(dayId, 'Monday', { sort_order: 1 })
    const res = commitPlan(db, basePlan({ items: [updateItem(dayId, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } })] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    appendOp(db, { entity: 'days_of_operation', entity_id: dayId, field: 'sort_order', value: 42, device_id: peerDeviceId, source: 'human' })
    expect(res.invertibleOps[0].priorValue).toBe('1.0') // a blind restore would write this, clobbering 42
  })
})

describe('U1c — device-local seq invariant regression guard (Finding 4)', () => {
  it('ingestUndo gates on latestOp (plain seq), not host_seq — a row whose host_seq diverges from seq must not change the outcome', () => {
    const dayId = randomUUID()
    seedDay(dayId, 'Monday', { sort_order: 1 })
    const res = commitPlan(db, basePlan({ items: [updateItem(dayId, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } })] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true })

    // Corrupt host_seq on the captured op to a value that would make the
    // COALESCE(host_seq, seq) convention disagree with plain seq. If
    // ingestUndo ever used latestOpSeq/latestScopeOpSeq's convention here,
    // this would make the gate compare against the wrong number.
    const capturedOpId = res.invertibleOps[0].opId
    db.prepare('UPDATE operations SET host_seq = ? WHERE id = ?').run(999999, capturedOpId)

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })

    // Plain-seq comparison is unaffected by host_seq — the field still reverts.
    expect(undoResult.reverted).toContainEqual({ entity: 'days_of_operation', entity_id: dayId, field: 'sort_order' })
    expect(dayField(dayId, 'sort_order')).toBe(1)
  })
})

describe('U1d — idempotency / double-undo', () => {
  it('a literal retry (same client_write_id) returns the same result without writing a second op', () => {
    const dayId = randomUUID()
    seedDay(dayId, 'Monday', { sort_order: 1 })
    const res = commitPlan(db, basePlan({ items: [updateItem(dayId, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } })] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true })

    const clientWriteId = randomUUID()
    const first = ingestUndo(db, { invertibleOps: res.invertibleOps, author_user_id: 'u1', device_id: deviceId, client_write_id: clientWriteId })
    expect(first.reverted).toHaveLength(1)
    const opsAfterFirst = opCount()

    const second = ingestUndo(db, { invertibleOps: res.invertibleOps, author_user_id: 'u1', device_id: deviceId, client_write_id: clientWriteId })
    expect(second.reverted).toEqual(first.reverted)
    expect(second.skipped).toEqual([])
    expect(opCount()).toBe(opsAfterFirst) // no new op written on the retry
  })

  it('a second, independent undo attempt (different client_write_id) reports "kept, changed since import" for every field', () => {
    const dayId = randomUUID()
    seedDay(dayId, 'Monday', { sort_order: 1 })
    const res = commitPlan(db, basePlan({ items: [updateItem(dayId, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } })] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true })

    const first = ingestUndo(db, { invertibleOps: res.invertibleOps, author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID() })
    expect(first.reverted).toHaveLength(1)
    expect(dayField(dayId, 'sort_order')).toBe(1)

    // A second call with the SAME captured invertibleOps but a DIFFERENT
    // client_write_id (a genuinely separate attempt, e.g. a stale second tab)
    // must fall through to the ordinary "touched since" gate: the first
    // undo's own write is now the latest op for the field, so its seq no
    // longer matches the captured seq — same wording a real peer edit gets.
    const second = ingestUndo(db, { invertibleOps: res.invertibleOps, author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID() })
    expect(second.reverted).toEqual([])
    expect(second.skipped).toContainEqual({ entity: 'days_of_operation', entity_id: dayId, field: 'sort_order' })
    // Value stays reverted (first undo's write), not double-applied or reset.
    expect(dayField(dayId, 'sort_order')).toBe(1)
  })
})

describe('U1 never creates or deletes a row (Invariant 2)', () => {
  it('row counts are unchanged by undo except for the reverted field values', () => {
    const dayId = randomUUID()
    seedDay(dayId, 'Monday', { sort_order: 1 })
    const daysBefore = db.prepare('SELECT COUNT(*) c FROM days_of_operation').get().c

    const res = commitPlan(
      db,
      basePlan({ items: [updateItem(dayId, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } }), createDayItem('Tuesday')] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    expect(db.prepare('SELECT COUNT(*) c FROM days_of_operation').get().c).toBe(daysBefore + 1) // Tuesday created

    const rowsBeforeUndo = db.prepare('SELECT COUNT(*) c FROM days_of_operation').get().c
    ingestUndo(db, { invertibleOps: res.invertibleOps, author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID() })

    // U1's undo touched only sort_order — Tuesday (a creation) still exists,
    // row count unchanged by the undo itself.
    expect(db.prepare('SELECT COUNT(*) c FROM days_of_operation').get().c).toBe(rowsBeforeUndo)
    expect(dayField(dayId, 'sort_order')).toBe(1)
    const tuesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday')
    expect(tuesday).toBeTruthy()
  })
})

// U2 — creation/deletion undo. docs/adr/2026-08-17-onescreen-reconciliation-undo.md
// ("U2 mechanism"), decomposition U2b-U2g.
describe('U2b — full-projection-field gate: a human-edited creation is KEPT', () => {
  it('a human filling a field the import left blank on a created activity is not deleted', () => {
    const res = commitPlan(
      db,
      basePlan({ items: [createActivityItem('Kayaking')] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    expect(res.held).toBe(false)
    const kayaking = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Kayaking')
    expect(res.createdEntityIds).toEqual([{ entity: 'activities', entity_id: kayaking.id, fieldSnapshot: expect.any(Object) }])
    // The full-projection snapshot includes location_id (never written by the
    // import) as null/no-op — Finding 2's point is exactly this field.
    expect(res.createdEntityIds[0].fieldSnapshot.location_id).toBe(null)

    // A human fills the blank the import left — AFTER commit, not part of it.
    appendOp(db, { entity: 'activities', entity_id: kayaking.id, field: 'location_id', value: 'loc-lake', device_id: peerDeviceId, source: 'human' })

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })

    expect(undoResult.deleted).toEqual([])
    expect(undoResult.kept).toContainEqual({ entity: 'activities', entity_id: kayaking.id, name: 'Kayaking', reason: 'edited_since_import' })
    // Row survives.
    expect(db.prepare('SELECT id FROM activities WHERE id = ?').get(kayaking.id)).toBeTruthy()
  })
})

describe('U2c — referential checks (Finding 3/4)', () => {
  it('outside reference: a location created by import, referenced by an activity created OUTSIDE the import, is KEPT', () => {
    const res = commitPlan(
      db,
      basePlan({ items: [createLocationItem('Lake')] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    expect(res.held).toBe(false)
    const lake = db.prepare('SELECT id FROM locations WHERE camp_id = ? AND name = ?').get(campId, 'Lake')

    // A director creates a second activity pointing at Lake, unrelated to
    // this import (no captureInverse, straight writes — not part of D).
    const canoeingId = randomUUID()
    appendOp(db, { entity: 'activities', entity_id: canoeingId, field: 'camp_id', value: campId, device_id: peerDeviceId, source: 'human' })
    appendOp(db, { entity: 'activities', entity_id: canoeingId, field: 'name', value: 'Canoeing', device_id: peerDeviceId, source: 'human' })
    appendOp(db, { entity: 'activities', entity_id: canoeingId, field: 'location_id', value: lake.id, device_id: peerDeviceId, source: 'human' })

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })

    expect(undoResult.deleted).toEqual([])
    expect(undoResult.kept).toContainEqual({ entity: 'locations', entity_id: lake.id, name: 'Lake', reason: 'still_referenced', referencedByCount: 1 })
    expect(db.prepare('SELECT id FROM locations WHERE id = ?').get(lake.id)).toBeTruthy()
  })

  it('in-batch pair: a location AND an activity referencing it, both created by the SAME import, both undone together — no FK throw, no orphan', () => {
    const res = commitPlan(
      db,
      basePlan({ items: [
        createLocationItem('Lake'),
        // location_id resolved after the fact below since buildPlan-level
        // resolution isn't exercised here — commitCreate writes location_id
        // literally from item.fields, so we mint the location id the same
        // way deriveLocationId would and reference it directly.
      ] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    const lake = db.prepare('SELECT id FROM locations WHERE camp_id = ? AND name = ?').get(campId, 'Lake')

    const res2 = commitPlan(
      db,
      basePlan({ items: [createActivityItem('Kayaking', { location_id: { from: null, to: lake.id, source: 'import' } })] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    const kayaking = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Kayaking')

    // Both entries undone TOGETHER, as if from one grace window (same shape
    // captureInverse callers combine into a single invertibleOps/
    // createdEntityIds pair for one commit — here simulated by concatenating
    // two commits' createdEntityIds, which is exactly the in-D exclusion the
    // ADR requires to prove works regardless of which commit produced which row).
    const createdEntityIds = [...res.createdEntityIds, ...res2.createdEntityIds]

    expect(() => {
      const undoResult = ingestUndo(db, {
        invertibleOps: [], createdEntityIds,
        author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
      })
      expect(undoResult.kept).toEqual([])
      expect(undoResult.deleted.sort((a, b) => a.entity.localeCompare(b.entity))).toEqual([
        { entity: 'activities', entity_id: kayaking.id },
        { entity: 'locations', entity_id: lake.id },
      ])
    }).not.toThrow()

    expect(db.prepare('SELECT id FROM activities WHERE id = ?').get(kayaking.id)).toBeFalsy()
    expect(db.prepare('SELECT id FROM locations WHERE id = ?').get(lake.id)).toBeFalsy()
  })
})

describe('U2d — anchor inclusion', () => {
  it('an anchor placed on a live template_slots row is KEPT, reported still-referenced', () => {
    const res = commitPlan(
      db,
      basePlan({
        items: [createDayItem('Monday'), createTimeBlockItem('Swim')],
        fixedEvents: [{ name: 'Lunch', time_block: 'Swim', days: ['Monday'], scope: { is_all_groups: true }, confidence: 'high' }],
      }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    expect(res.held).toBe(false)
    expect(res.fixedEvents.created).toBe(1)
    const anchorId = res.fixedEvents.createdEntries[0].anchorId
    expect(anchorId).toBeTruthy()

    // A director places this anchor on a schedule slot.
    db.prepare('INSERT INTO template_slots (id, template_id, anchor_id) VALUES (?, ?, ?)').run(randomUUID(), randomUUID(), anchorId)

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })

    expect(undoResult.kept).toContainEqual({ entity: 'anchor_activities', entity_id: anchorId, name: 'Lunch', reason: 'still_referenced', referencedByCount: 1 })
    expect(db.prepare('SELECT id FROM anchor_activities WHERE id = ?').get(anchorId)).toBeTruthy()
    // No FOREIGN KEY constraint failed under PRAGMA foreign_keys=ON — the
    // deletion attempt on the day/time_block that ARE deletable must not
    // throw even though the (kept) anchor still points at them.

    // The kept anchor's day_id/time_block_id edges must SURVIVE, not merely
    // "not throw" — time_block_id is enforced:false (silent orphan on a
    // wrongly-included delete, no FK throw to catch it). This asserts the
    // exact orphan class the deletion mechanism exists to prevent: if the
    // registry entry were dropped, or the kept anchor were wrongly added to
    // excludeSet, this is the assertion that would catch it (a bare
    // not-toThrow would not).
    const monday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Monday')
    const swim = db.prepare('SELECT id FROM time_blocks WHERE camp_id = ? AND name = ?').get(campId, 'Swim')
    expect(monday).toBeTruthy()
    expect(swim).toBeTruthy()
  })

  it('reimport of the same source file after an anchor undo does NOT recreate it (source:"human" engages rejectedSlotKeys)', () => {
    const res = commitPlan(
      db,
      basePlan({
        items: [createDayItem('Monday'), createTimeBlockItem('Swim')],
        fixedEvents: [{ name: 'Lunch', time_block: 'Swim', days: ['Monday'], scope: { is_all_groups: true }, confidence: 'high' }],
      }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    const anchorId = res.fixedEvents.createdEntries[0].anchorId

    // Undo ONLY the anchor here (not the day/time_block it sits on) — this
    // isolates rejectedSlotKeys' recognition, which is keyed by the LIVE
    // day_id/time_block_id: if those were also undone, the reimport would
    // mint fresh ids and the rejected-slot key would never match, which
    // would test the wrong thing (id churn, not the tombstone-suppression
    // mechanism this test targets).
    const anchorOnly = res.createdEntityIds.filter((e) => e.entity === 'anchor_activities')
    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: anchorOnly,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(undoResult.deleted).toContainEqual({ entity: 'anchor_activities', entity_id: anchorId })
    expect(db.prepare('SELECT id FROM anchor_activities WHERE id = ?').get(anchorId)).toBeFalsy()

    // Reimport of the SAME fixed event, same day/time block (still live —
    // recognize-then-skip would normally no-op, but the tombstone here must
    // suppress recreation, not just be silently masked by recognition).
    const reimport = commitPlan(
      db,
      basePlan({ fixedEvents: [{ name: 'Lunch', time_block: 'Swim', days: ['Monday'], scope: { is_all_groups: true }, confidence: 'high' }] }),
      { author_user_id: 'u1', device_id: deviceId }
    )
    expect(reimport.held).toBe(false)
    expect(reimport.fixedEvents.created).toBe(0)
    expect(reimport.fixedEvents.rejected).toHaveLength(1)
    const liveAnchors = db.prepare('SELECT id FROM anchor_activities WHERE camp_id = ?').all(campId)
    expect(liveAnchors).toEqual([])
  })
})

describe('U2e — clean case: no edits, no references', () => {
  it('undo deletes every created row, row counts drop to pre-import, no orphans', () => {
    const activitiesBefore = db.prepare('SELECT COUNT(*) c FROM activities').get().c

    const res = commitPlan(
      db,
      basePlan({ items: [createActivityItem('Archery')] }),
      { author_user_id: 'u1', device_id: deviceId, captureInverse: true }
    )
    expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(activitiesBefore + 1)

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })

    expect(undoResult.kept).toEqual([])
    expect(undoResult.deleted).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(activitiesBefore)
  })
})

describe('U2e — import_evidence cleanup', () => {
  it('a created row with evidence is undone; import_evidence rows are gone, not orphaned', () => {
    // A low-confidence activity rule writes evidence via writeActivityEvidence.
    const item = createActivityItem('Fishing')
    item._rule = { support: { source: 'file row 4' }, eligibility_known: false }
    const res = commitPlan(db, basePlan({ items: [item] }), { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    const fishing = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Fishing')
    const evidenceBefore = db.prepare("SELECT COUNT(*) c FROM import_evidence WHERE entity_type = 'activities' AND entity_id = ?").get(fishing.id).c
    expect(evidenceBefore).toBeGreaterThan(0)

    ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })

    const evidenceAfter = db.prepare("SELECT COUNT(*) c FROM import_evidence WHERE entity_type = 'activities' AND entity_id = ?").get(fishing.id).c
    expect(evidenceAfter).toBe(0)
  })
})

describe('U2g — undo-then-reimport (non-anchor entity)', () => {
  it('a non-anchor row deleted by undo (source:"human") IS recreated by a reimport of the same file', () => {
    const res = commitPlan(db, basePlan({ items: [createLocationItem('Lake')] }), { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    const lake = db.prepare('SELECT id FROM locations WHERE camp_id = ? AND name = ?').get(campId, 'Lake')

    ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(db.prepare('SELECT id FROM locations WHERE id = ?').get(lake.id)).toBeFalsy()

    // Reimport of the same source (same normalized name) — locations are
    // deterministic-id (deriveLocationId), so the reimport must recreate it
    // under the same id, unsuppressed (no rejectedSlotKeys-equivalent for
    // non-anchor entities).
    const reimport = commitPlan(db, basePlan({ items: [createLocationItem('Lake')] }), { author_user_id: 'u1', device_id: deviceId })
    expect(reimport.held).toBe(false)
    expect(reimport.created.locations).toBe(1)
    const recreated = db.prepare('SELECT id FROM locations WHERE camp_id = ? AND name = ?').get(campId, 'Lake')
    expect(recreated).toBeTruthy()
  })

  // Table-driven coverage of the same undo-then-reimport shape for every
  // other non-anchor deletable entity (Red Hat coverage finding — locations
  // alone left 5 of 6 entities unproven; unlike locations these mint a fresh
  // randomUUID per create, so "recreated" is asserted by name/table lookup,
  // not by id equality).
  const nonAnchorCases = [
    {
      label: 'activities',
      table: 'activities',
      createItem: () => createActivityItem('Archery Range'),
      lookup: () => db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Archery Range'),
    },
    {
      label: 'groups',
      table: 'groups',
      createItem: () => ({
        op: 'create', entity: 'groups', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Bunk 3', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Bunk 3', _humanFields: [],
      }),
      lookup: () => db.prepare('SELECT id FROM groups WHERE camp_id = ? AND name = ?').get(campId, 'Bunk 3'),
    },
    {
      label: 'tiers',
      table: 'tiers',
      createItem: () => ({
        op: 'create', entity: 'tiers', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Seniors', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Seniors', _humanFields: [],
      }),
      lookup: () => db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND name = ?').get(campId, 'Seniors'),
    },
    {
      label: 'days_of_operation',
      table: 'days_of_operation',
      createItem: () => createDayItem('Wednesday'),
      lookup: () => db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Wednesday'),
    },
    {
      label: 'time_blocks',
      table: 'time_blocks',
      createItem: () => createTimeBlockItem('Free Swim'),
      lookup: () => db.prepare('SELECT id FROM time_blocks WHERE camp_id = ? AND name = ?').get(campId, 'Free Swim'),
    },
  ]

  it.each(nonAnchorCases)('$label: deleted by undo, then recreated by a reimport of the same source', ({ createItem, lookup }) => {
    const res = commitPlan(db, basePlan({ items: [createItem()] }), { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    const created = lookup()
    expect(created).toBeTruthy()

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(undoResult.kept).toEqual([])
    expect(lookup()).toBeFalsy()

    const reimport = commitPlan(db, basePlan({ items: [createItem()] }), { author_user_id: 'u1', device_id: deviceId })
    expect(reimport.held).toBe(false)
    expect(lookup()).toBeTruthy()
  })
})

describe('U2 — concurrent-write on a created row field, gated per Finding 2', () => {
  it('a peer edit to any field of a created row (not just an import-written one) keeps the whole row', () => {
    const res = commitPlan(db, basePlan({ items: [createDayItem('Monday')] }), { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    const monday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Monday')

    // A peer device sets sort_order — a field the import never wrote at all.
    appendOp(db, { entity: 'days_of_operation', entity_id: monday.id, field: 'sort_order', value: 3, device_id: peerDeviceId, source: 'human' })

    const undoResult = ingestUndo(db, {
      invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })

    expect(undoResult.deleted).toEqual([])
    expect(undoResult.kept).toContainEqual({ entity: 'days_of_operation', entity_id: monday.id, name: 'Monday', reason: 'edited_since_import' })
  })
})

describe('U2g — idempotent per-row retry', () => {
  it('a retried ingestUndo call (same outer client_write_id) reuses the same derived per-row client_write_id, does not double-delete or double-write', () => {
    const res = commitPlan(db, basePlan({ items: [createActivityItem('Tennis')] }), { author_user_id: 'u1', device_id: deviceId, captureInverse: true })
    const tennis = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Tennis')

    const clientWriteId = randomUUID()
    const first = ingestUndo(db, { invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds, author_user_id: 'u1', device_id: deviceId, client_write_id: clientWriteId })
    expect(first.deleted).toEqual([{ entity: 'activities', entity_id: tennis.id }])
    const opsAfterFirst = opCount()

    const second = ingestUndo(db, { invertibleOps: res.invertibleOps, createdEntityIds: res.createdEntityIds, author_user_id: 'u1', device_id: deviceId, client_write_id: clientWriteId })
    expect(second.deleted).toEqual([{ entity: 'activities', entity_id: tennis.id }])
    expect(opCount()).toBe(opsAfterFirst) // no new op written on the retry
  })
})
