// S4b — the enrichment-workbook RE-IMPORT round-trip. Drives the real committer
// (commitIngest/commitPlan) through the workbook adapter's output: the uuid match
// tier, the live <clear> arm, missing_target, and the ACTIVE base_generation
// staleness gate. Covers the ADR "Completion evidence" list (round-trip F5,
// idempotency, F6/import-over-import, missing_target, clear, forced add-mode).
//
// docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOp, latestOpSeq } from './operations.js'
import { commitIngest } from './ingest.js'
import { exportWorkbook } from '../../src/utils/exportWorkbook.js'
import { workbookToSource, CLEAR_TOKEN } from '../../src/ingest/workbookToSource.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-s4b-${Date.now()}-${Math.random()}.sqlite`)
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
const commit = (extra) => commitIngest(db, { camp_id: campId, device_id: deviceId, author_user_id: 'u1', ...extra })
const actId = (name) => db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, name)?.id
const actField = (id, f) => db.prepare(`SELECT ${f} AS v FROM activities WHERE id = ?`).get(id)?.v

// Seed a camp via the import path, then read it back into the localClient.list
// shape exportWorkbook consumes.
function seed() {
  commit({
    approved: { tiers: ['Aleph', 'Bet'], groups: ['Bunk 1', 'Bunk 2'], activities: ['Swim'] },
    links: { groups: { 'Bunk 1': 'Aleph', 'Bunk 2': 'Bet' } },
    activityRules: { Swim: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' } },
  })
}
function listShape() {
  const tiers = db.prepare('SELECT id, name, sort_order FROM tiers WHERE camp_id = ?').all(campId)
  const groups = db.prepare('SELECT id, name, tier_id, availability FROM groups WHERE camp_id = ?').all(campId)
  const activities = db.prepare('SELECT id, name, priority, min_per_week, max_per_week, eligible_group_ids, location FROM activities WHERE camp_id = ?').all(campId)
  return { tiers, groups, activities, cohorts: [], days_of_operation: [], time_blocks: [] }
}
function makeWorkbook(base_generation) {
  return exportWorkbook({ ...listShape(), camp_id: campId, cohort_id: null, base_generation })
}
// Read a workbook back through write/read like an uploaded file, run the adapter,
// and return the commit inputs.
function reimport(wb, extra = {}) {
  const round = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' })
  const src = workbookToSource(round, { camp_id: campId })
  return commit({ approved: src.approved, base_generation: src.base_generation, ...extra })
}
function editCell(wb, sheet, name, header, value) {
  const ws = wb.Sheets[sheet]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
  const hdr = rows[0]
  const nameCol = hdr.indexOf('name')
  const r = rows.findIndex((row, i) => i > 0 && row[nameCol] === name)
  const c = hdr.indexOf(header)
  ws[XLSX.utils.encode_cell({ c, r })] = { t: typeof value === 'number' ? 'n' : 's', v: value }
}

// ---------------------------------------------------------------------------
// F5 — the round-trip update by id.
// ---------------------------------------------------------------------------
describe('round-trip update by id (F5)', () => {
  it('editing max_per_week re-imports as op:update on THAT activity, value changes', () => {
    seed()
    const id = actId('Swim')
    expect(actField(id, 'max_per_week')).toBe(2)
    const seq = latestOpSeq(db)
    const wb = makeWorkbook(seq)
    editCell(wb, 'Activities', 'Swim', 'max_per_week', 5)
    const before = opCount()
    const res = reimport(wb)
    expect(res.held).toBe(false)
    expect(res.updated).toBe(1)
    expect(opCount()).toBe(before + 1)      // exactly one field op
    expect(actField(id, 'max_per_week')).toBe(5)
    expect(latestOp(db, 'activities', id, 'max_per_week').source).toBe('import')
  })
})

// ---------------------------------------------------------------------------
// Idempotency — unchanged re-import writes zero ops, even with peer drift.
// ---------------------------------------------------------------------------
describe('idempotency + baseline diff (RISK D)', () => {
  it('re-importing an UNEDITED workbook writes zero ops', () => {
    seed()
    const wb = makeWorkbook(latestOpSeq(db))
    const before = opCount()
    const res = reimport(wb)
    expect(res.held).toBe(false)
    expect(res.updated).toBe(0)
    expect(opCount()).toBe(before)
  })

  it('a peer drift on an UNTOUCHED cell still produces no delta (baseline, not live)', () => {
    seed()
    const id = actId('Swim')
    const wb = makeWorkbook(latestOpSeq(db))
    // A peer changes priority live AFTER the export — but the director never
    // touched the priority cell, so the baseline-diff omits it: no delta, no hold.
    appendOp(db, { entity: 'activities', entity_id: id, field: 'location', value: 'Lake', device_id: deviceId, source: 'import' })
    const before = opCount()
    const res = reimport(wb)
    // location was drifted live but untouched in the sheet → baseline-diff drops it.
    expect(res.held).toBe(false)
    expect(res.updated).toBe(0)
    expect(opCount()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Import-over-import staleness — the ACTIVE base_generation gate (RISK C / F6).
// ---------------------------------------------------------------------------
describe('import-over-import staleness (RISK C)', () => {
  it('a stale workbook proposing a change to an import-owned field is held', () => {
    seed()
    const id = actId('Swim')
    const staleSeq = latestOpSeq(db)   // "Monday" export generation
    const wb = makeWorkbook(staleSeq)
    editCell(wb, 'Activities', 'Swim', 'max_per_week', 9)
    // A LATER import writes the same field (import-owned) — seq now > staleSeq.
    commit({ approved: { activities: ['Swim'] }, activityRules: { Swim: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 4, priority: 'high' } } })
    expect(actField(id, 'max_per_week')).toBe(4)
    const before = opCount()
    const res = reimport(wb)
    // Provenance alone (import-owned) would wave this through; the clock holds it.
    expect(res.held).toBe(true)
    expect(res.conflicts.some((c) => c.reason === 'stale')).toBe(true)
    expect(opCount()).toBe(before)
    expect(actField(id, 'max_per_week')).toBe(4)   // untouched
  })
})

// ---------------------------------------------------------------------------
// missing_target — an id absent from the camp holds, never crashes/creates.
// ---------------------------------------------------------------------------
describe('missing_target (RISK H)', () => {
  it('a shoresh_id absent from the camp is a held conflict, not a crash or a create', () => {
    seed()
    const wb = makeWorkbook(latestOpSeq(db))
    editCell(wb, 'Activities', 'Swim', 'max_per_week', 5)
    // Corrupt the id so it no longer names a live activity.
    const ws = wb.Sheets['Activities']
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
    const r = rows.findIndex((row, i) => i > 0 && row[1] === 'Swim')
    ws[XLSX.utils.encode_cell({ c: 0, r })] = { t: 's', v: 'ghost-id-xyz' }
    const before = opCount()
    const res = reimport(wb)
    expect(res.held).toBe(true)
    expect(res.conflicts.some((c) => c.reason === 'missing_target')).toBe(true)
    expect(opCount()).toBe(before)
    // No duplicate activity was created.
    expect(db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Swim').c).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// clear — import-owned nulled; human-owned held; never-set no-op (RISK I).
// ---------------------------------------------------------------------------
describe('the live <clear> arm (RISK I)', () => {
  it('<clear> on an import-owned field writes a field-null op', () => {
    seed()
    const id = actId('Swim')
    expect(actField(id, 'location')).toBeNull() // never set; set one now (import)
    appendOp(db, { entity: 'activities', entity_id: id, field: 'location', value: 'Pool', device_id: deviceId, source: 'import' })
    expect(actField(id, 'location')).toBe('Pool')
    const wb = makeWorkbook(latestOpSeq(db))
    editCell(wb, 'Activities', 'Swim', 'location', CLEAR_TOKEN)
    const res = reimport(wb)
    expect(res.held).toBe(false)
    expect(actField(id, 'location')).toBeNull()
    // The write is a real null op (never a Symbol).
    expect(latestOp(db, 'activities', id, 'location').value).toBeNull()
  })

  it('<clear> on a HUMAN-authored field is held (gated ≥ update)', () => {
    seed()
    const id = actId('Swim')
    appendOp(db, { entity: 'activities', entity_id: id, field: 'location', value: 'Pool', device_id: deviceId, source: 'human' })
    const wb = makeWorkbook(latestOpSeq(db))
    editCell(wb, 'Activities', 'Swim', 'location', CLEAR_TOKEN)
    const before = opCount()
    const res = reimport(wb)
    expect(res.held).toBe(true)
    expect(res.conflicts.some((c) => c.reason === 'stale')).toBe(true)
    expect(opCount()).toBe(before)
    expect(actField(id, 'location')).toBe('Pool')  // untouched
  })

  it('<clear> on a never-set field is a NO-OP (no spurious null op)', () => {
    seed()
    const id = actId('Swim')
    expect(actField(id, 'location')).toBeNull()
    const wb = makeWorkbook(latestOpSeq(db))
    editCell(wb, 'Activities', 'Swim', 'location', CLEAR_TOKEN)
    const before = opCount()
    const res = reimport(wb)
    expect(res.held).toBe(false)
    expect(res.updated).toBe(0)
    expect(opCount()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Forced add-mode — a workbook can never trigger replaceScope (RISK L).
// ---------------------------------------------------------------------------
describe('forced add-mode (RISK L)', () => {
  it('the adapter always emits mode:add', () => {
    seed()
    const round = XLSX.read(XLSX.write(makeWorkbook(latestOpSeq(db)), { type: 'array', bookType: 'xlsx' }), { type: 'array' })
    const src = workbookToSource(round, { camp_id: campId })
    expect(src.mode).toBe('add')
  })

  it('omitting a row does NOT delete it (no replace)', () => {
    seed()
    const otherBefore = db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ?').get(campId).c
    const wb = makeWorkbook(latestOpSeq(db))
    // Drop the Swim row entirely from the sheet.
    const ws = wb.Sheets['Activities']
    const ref = XLSX.utils.decode_range(ws['!ref'])
    // Clear all data rows (r>=1).
    for (let r = 1; r <= ref.e.r; r++) for (let c = 0; c <= ref.e.c; c++) delete ws[XLSX.utils.encode_cell({ c, r })]
    ws['!ref'] = XLSX.utils.encode_range({ s: ref.s, e: { c: ref.e.c, r: 0 } })
    const res = reimport(wb)
    expect(res.held).toBe(false)
    // Swim still exists — omission is not deletion.
    expect(db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ?').get(campId).c).toBe(otherBefore)
  })
})
