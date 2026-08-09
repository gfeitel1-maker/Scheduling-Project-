// S2b — field-level UPDATE with hand-edit protection (Policy A) + stale conflict.
// docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
//
// Covers the ADR "Completion evidence" list:
//   F5  partial enrichment (buildPlan diff + commitPlan writes)
//   F6  stale over a newer hand-edit (held, no op, re-commit after resolve)
//   2a  the NULL trap is escapable (decay: accept stamps 'import', 2nd import quiet)
//   #3  import-owned field updates freely (parent_op_id = prior op id)
//   #4  never-set field fills (from:null, parent_op_id:null)
//   #5  clear still throws; a blank source cell never clears; stale emits no op
//   F4  idempotency + S1a anchors stay green (asserted in the sibling suites)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOp } from './operations.js'
import { commitIngest, commitPlan } from './ingest.js'
import { buildPlan } from '../../src/ingest/buildPlan.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-s2b-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const opCount = () => db.prepare('SELECT COUNT(*) c FROM operations').get().c
const dayField = (id, field) => db.prepare(`SELECT ${field} AS v FROM days_of_operation WHERE id = ?`).get(id)?.v

// Seed a live day directly on the op-log so each field's provenance is
// controllable (mirrors ingest.provenance.test.js). camp_id makes idExists pass;
// label makes recognition match. The target field's source is caller-chosen.
function seedDay(id, label, { sort_order, sortSource } = {}) {
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'label', value: label, device_id: deviceId, source: 'import' })
  if (sort_order !== undefined) {
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: sort_order, device_id: deviceId, source: sortSource })
  }
}

const plan = (item) => ({
  plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
  sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
  unresolved: [], items: [item],
})

const updateItem = (id, label, fields) => ({
  op: 'update', entity: 'days_of_operation', entity_id: id, fields,
  evidence: { tier: 'exact_name', matched_name: label }, _name: label,
})

// ---------------------------------------------------------------------------
// buildPlan: the field diff (the `update` arm goes live).
// ---------------------------------------------------------------------------
describe('buildPlan diffs a recognized entity (F5 diff side)', () => {
  it('a differing comparable field becomes an update carrying ONLY that field', () => {
    // Live 'Monday' with a hand-moved sort_order 5. S2c: the recognized diff
    // reads ONLY the fields the source explicitly carries, so the source supplies
    // sort_order 1 (DIFFERS); nothing else is proposed, so nothing else diffs.
    const p = buildPlan(
      { approved: { days_of_operation: [{ name: 'Monday', fields: { sort_order: 1 } }] }, camp_id: campId },
      { days_of_operation: [{ id: 'd-mon', name: 'Monday', day_of_week: 1, sort_order: 5 }] },
    )
    expect(p.items).toHaveLength(1)
    const item = p.items[0]
    expect(item.op).toBe('update')
    expect(item.entity_id).toBe('d-mon')
    expect(Object.keys(item.fields)).toEqual(['sort_order'])
    expect(item.fields.sort_order).toMatchObject({ from: 5, to: 1, source: 'import' })
  })

  it('all comparable fields equal → stays unchanged (F4 preserved at the diff)', () => {
    const p = buildPlan(
      { approved: { days_of_operation: ['Monday'] }, camp_id: campId },
      { days_of_operation: [{ id: 'd-mon', name: 'Monday', day_of_week: 1, sort_order: 1 }] },
    )
    expect(p.items[0].op).toBe('unchanged')
    expect(p.items[0].fields).toEqual({})
  })

  it('a blank/absent proposed field is NOT in the delta — never diffed, never cleared', () => {
    // 'Rest' is not a time range, so parseTimeRange yields a null start_time.
    // The live block has a hand-set start_time; the blank proposal must leave it
    // out of the delta entirely (preserve), so the item stays unchanged.
    const p = buildPlan(
      { approved: { time_blocks: ['Rest'] }, camp_id: campId },
      { time_blocks: [{ id: 'tb', name: 'Rest', start_time: '13:00', end_time: null, sort_order: 0, cohort_id: null }] },
    )
    expect(p.items[0].op).toBe('unchanged')
    // start_time was NOT proposed for change.
    expect(p.items[0].fields.start_time).toBeUndefined()
  })

  it('a raw-form name difference is the SAME entity, not an update', () => {
    const p = buildPlan(
      { approved: { activities: ['Art'] }, camp_id: campId },
      { activities: [{ id: 'a', name: 'art ' }] },
    )
    expect(p.items[0].op).toBe('unchanged')
  })
})

// ---------------------------------------------------------------------------
// commitPlan: the Policy A protection gate + the writes.
// ---------------------------------------------------------------------------
describe('commitPlan Policy A gate (F5 write side / evidence #3, #4)', () => {
  it('import-owned differing field updates freely, parent_op_id = the prior op id', () => {
    const id = randomUUID()
    seedDay(id, 'Monday', { sort_order: 1, sortSource: 'import' })
    const priorOpId = latestOp(db, 'days_of_operation', id, 'sort_order').id

    const res = commitPlan(db, plan(updateItem(id, 'Monday', { sort_order: { from: 1, to: 9, source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    expect(res.updated).toBe(1)
    expect(dayField(id, 'sort_order')).toBe(9)
    const latest = latestOp(db, 'days_of_operation', id, 'sort_order')
    expect(latest.source).toBe('import')
    expect(latest.parent_op_id).toBe(priorOpId)
  })

  it('never-set field fills: from:null, parent_op_id:null, source import', () => {
    const id = randomUUID()
    seedDay(id, 'Monday') // no sort_order op at all

    const res = commitPlan(db, plan(updateItem(id, 'Monday', { sort_order: { from: null, to: 4, source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    expect(dayField(id, 'sort_order')).toBe(4)
    const latest = latestOp(db, 'days_of_operation', id, 'sort_order')
    expect(latest.source).toBe('import')
    expect(latest.parent_op_id).toBeNull()
  })

  it('a mix of import-owned (write) and human (protected) fields HOLDS the whole update', () => {
    const id = randomUUID()
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'label', value: 'Monday', device_id: deviceId, source: 'import' })
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: 2, device_id: deviceId, source: 'import' })
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'day_of_week', value: 6, device_id: deviceId, source: 'human' })

    const before = opCount()
    const res = commitPlan(db, plan(updateItem(id, 'Monday', {
      sort_order: { from: 2, to: 7, source: 'import' },     // import-owned → would write
      day_of_week: { from: 6, to: 1, source: 'import' },     // human-owned → protected
    })), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(true)
    // Hold-the-whole: NOTHING written, not even the import-owned field.
    expect(opCount()).toBe(before)
    expect(dayField(id, 'sort_order')).toBe(2)
    expect(res.conflicts.some((c) => c.reason === 'stale')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// F6 — stale over a newer hand-edit (the most-likely-quietly-broken case).
// ---------------------------------------------------------------------------
describe('F6 — stale over a newer hand-edit (evidence #2)', () => {
  it('a human-authored field differing from the import is a held stale conflict, no op', () => {
    const id = randomUUID()
    // Import wrote it, then a director hand-edited it (source human).
    seedDay(id, 'Monday', { sort_order: 1, sortSource: 'import' })
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: 3, device_id: deviceId, source: 'human' })
    const humanSeq = latestOp(db, 'days_of_operation', id, 'sort_order').seq

    const before = opCount()
    const res = commitPlan(db, plan(updateItem(id, 'Monday', { sort_order: { from: 3, to: 1, source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)                 // whole import writes nothing
    expect(dayField(id, 'sort_order')).toBe(3)     // the hand-edit is untouched
    expect(res.conflicts).toHaveLength(1)
    const c = res.conflicts[0]
    expect(c.reason).toBe('stale')
    expect(c.fields.sort_order.from).toBe(3)
    expect(c.fields.sort_order.to).toBe(1)
    expect(c.fields.sort_order.conflict.clock.field_last_seq).toBe(humanSeq)
    expect(c.fields.sort_order.conflict.competing).toEqual([
      { value: 3, source: 'human', seq: humanSeq },
      { value: 1, source: 'import' },
    ])
  })

  it('re-commit after the director resolves (drops the stale field) succeeds', () => {
    const id = randomUUID()
    seedDay(id, 'Monday', { sort_order: 3, sortSource: 'human' })

    const held = commitPlan(db, plan(updateItem(id, 'Monday', { sort_order: { from: 3, to: 1, source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })
    expect(held.held).toBe(true)

    // Director keeps their hand-edit: the re-commit carries no changed field, so
    // the item is `unchanged` and the whole import lands clean.
    const ok = commitPlan(db, plan({
      op: 'unchanged', entity: 'days_of_operation', entity_id: id, fields: {},
      evidence: { tier: 'exact_name', matched_name: 'Monday' }, _name: 'Monday',
    }), { author_user_id: 'u1', device_id: deviceId })
    expect(ok.held).toBe(false)
    expect(dayField(id, 'sort_order')).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 2a — the NULL trap is escapable (R1 decay).
// ---------------------------------------------------------------------------
describe('R1 decay — the NULL trap is escapable (evidence #2a)', () => {
  it('a pre-S2a (NULL) field holds; accepting stamps import; the 2nd import is quiet', () => {
    const id = randomUUID()
    // Pre-S2a field: no source recorded (NULL = human = protected).
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId })
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'label', value: 'Monday', device_id: deviceId })
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: 3, device_id: deviceId })
    // A second NULL field that the acceptance must NOT touch (no blanket backfill).
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'day_of_week', value: 6, device_id: deviceId })
    expect(latestOp(db, 'days_of_operation', id, 'sort_order').source).toBeNull()

    // FIRST re-import → the NULL field is protected → held stale.
    const held = commitPlan(db, plan(updateItem(id, 'Monday', { sort_order: { from: 3, to: 1, source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })
    expect(held.held).toBe(true)
    expect(held.conflicts[0].reason).toBe('stale')

    // Director ACCEPTS the import value. This is what the source-aware
    // resolveConflict variant (main.js §3a) writes: the accepted import value,
    // stamped source:'import', parented on the losing human op.
    const humanOp = latestOp(db, 'days_of_operation', id, 'sort_order')
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: 1, device_id: deviceId, source: 'import', parent_op_id: humanOp.id })

    // Provenance flipped to import for the accepted field only.
    expect(latestOp(db, 'days_of_operation', id, 'sort_order').source).toBe('import')
    // The OTHER pre-S2a field was NOT backfilled — still NULL/protected.
    expect(latestOp(db, 'days_of_operation', id, 'day_of_week').source).toBeNull()

    // SECOND re-import proposing a further change now sees import ownership →
    // updates quietly, no conflict.
    const quiet = commitPlan(db, plan(updateItem(id, 'Monday', { sort_order: { from: 1, to: 8, source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })
    expect(quiet.held).toBe(false)
    expect(quiet.updated).toBe(1)
    expect(dayField(id, 'sort_order')).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// #5 — clear still throws; a blank source cell never clears; stale emits no op.
// ---------------------------------------------------------------------------
describe('scope fence (evidence #5)', () => {
  it('op:clear still throws', () => {
    expect(() => commitPlan(db, plan({ op: 'clear', entity: 'activities', entity_id: 'x', fields: {} }),
      { author_user_id: 'u1', device_id: deviceId })).toThrow(/not implemented/)
  })

  it('a blank source cell produces no op (never clears the live value)', () => {
    // commitIngest builds the snapshot + plan itself. 'Rest' proposes a null
    // start_time; the live block keeps its hand-set start_time, zero ops.
    const tb = randomUUID()
    appendOp(db, { entity: 'time_blocks', entity_id: tb, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
    appendOp(db, { entity: 'time_blocks', entity_id: tb, field: 'name', value: 'Rest', device_id: deviceId, source: 'import' })
    appendOp(db, { entity: 'time_blocks', entity_id: tb, field: 'start_time', value: '13:00', device_id: deviceId, source: 'human' })
    // sort_order matches what fieldsFor derives for index 0, so the ONLY field
    // in play is the blank start_time — isolating the blank-preserve behavior.
    appendOp(db, { entity: 'time_blocks', entity_id: tb, field: 'sort_order', value: 0, device_id: deviceId, source: 'import' })

    const before = opCount()
    const res = commitIngest(db, { approved: { time_blocks: ['Rest'] }, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
    expect(res.held).toBe(false)
    expect(opCount()).toBe(before)                       // no op emitted
    expect(db.prepare('SELECT start_time FROM time_blocks WHERE id = ?').get(tb).start_time).toBe('13:00')
  })
})

// ---------------------------------------------------------------------------
// F5 end-to-end via commitIngest: enrich import-owned, preserve blank, keep
// unchanged unchanged — all in one real re-import.
// ---------------------------------------------------------------------------
describe('F5 — partial enrichment end-to-end (evidence #1)', () => {
  it('updates an import-owned differing field while preserving an unrelated hand-edit-free field', () => {
    // First import establishes Monday (sort_order 1, import) and Tuesday.
    commitIngest(db, { approved: { days_of_operation: ['Monday', 'Tuesday'] }, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
    const monId = db.prepare("SELECT id FROM days_of_operation WHERE label = 'Monday'").get().id

    // A director moved Monday's sort_order via an IMPORT-provenance path (e.g. a
    // prior accepted re-import), so it is import-owned and re-importable.
    appendOp(db, { entity: 'days_of_operation', entity_id: monId, field: 'sort_order', value: 5, device_id: deviceId, source: 'import' })

    // Re-import: the source explicitly carries Monday's sort_order = 1 (S2c), which
    // differs from the live 5 → update writes; Tuesday carries nothing → unchanged.
    const res = commitIngest(db, { approved: { days_of_operation: [{ name: 'Monday', fields: { sort_order: 1 } }, 'Tuesday'] }, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(1)
    expect(db.prepare('SELECT sort_order FROM days_of_operation WHERE id = ?').get(monId).sort_order).toBe(1)
    expect(latestOp(db, 'days_of_operation', monId, 'sort_order').source).toBe('import')
  })
})
