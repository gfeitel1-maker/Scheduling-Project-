// ADR 2026-08-09 Decision 2 — a group's unit gets the SAME per-field
// human/import provenance every other hand-edited field already has (S2b
// Policy A), closing the one gap that kept a director's hand-picked (or
// hand-cleared) unit from surviving a later re-import: commitCreate and
// commitUpdate stamping 'import' unconditionally, with no way to say "this
// field, on this item, is the director's pick."
//
// Mirrors ingest.s2b.test.js's own F6/R1 evidence shape: hand-built plan
// items driven straight through commitPlan, so the human/import stamp is
// tested at the exact seam it lives in (item._humanFields, normalized to the
// stored column 'tier_id' the way buildPlan attaches it).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOp } from './operations.js'
import { commitPlan } from './ingest.js'
import { CLEAR } from '../../src/ingest/buildPlan.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-unit-prov-${Date.now()}-${Math.random()}.sqlite`)
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
const groupField = (id, field) => db.prepare(`SELECT ${field} AS v FROM groups WHERE id = ?`).get(id)?.v

function seedTier(id, name) {
  appendOp(db, { entity: 'tiers', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'tiers', entity_id: id, field: 'name', value: name, device_id: deviceId, source: 'import' })
}

// Seeds a live group directly on the op-log so tier_id's provenance is
// controllable (mirrors ingest.s2b.test.js's seedDay).
function seedGroup(id, name, { tier_id, tierSource } = {}) {
  appendOp(db, { entity: 'groups', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'groups', entity_id: id, field: 'name', value: name, device_id: deviceId, source: 'import' })
  if (tier_id !== undefined) {
    appendOp(db, { entity: 'groups', entity_id: id, field: 'tier_id', value: tier_id, device_id: deviceId, source: tierSource })
  }
}

const plan = (items) => ({
  plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
  sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
  unresolved: [], items: Array.isArray(items) ? items : [items],
})

const updateItem = (id, name, fields, humanFields) => ({
  op: 'update', entity: 'groups', entity_id: id, fields,
  evidence: { tier: 'exact_name', matched_name: name }, _name: name,
  _humanFields: humanFields ?? [],
})

const clearItem = (id, name, live, humanFields) => ({
  op: 'clear', entity: 'groups', entity_id: id,
  fields: { unit: { from: live, to: CLEAR, source: 'import' } },
  evidence: { tier: 'exact_name', matched_name: name }, _name: name,
  _humanFields: humanFields ?? [],
})

describe('a director-picked unit on CREATE is stamped human, not import', () => {
  it('commitCreate honors _humanFields on the very first write', () => {
    const res = commitPlan(db, plan([
      { op: 'create', entity: 'tiers', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Kfar A', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Kfar A', _humanFields: [] },
      { op: 'create', entity: 'groups', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Chagalls', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Chagalls', _link_unit: 'Kfar A', _humanFields: ['tier_id'] },
    ]), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    const row = db.prepare('SELECT id, tier_id FROM groups WHERE camp_id = ? AND name = ?').get(campId, 'Chagalls')
    expect(row.tier_id).toBeTruthy()
    const latest = latestOp(db, 'groups', row.id, 'tier_id')
    expect(latest.source).toBe('human')
  })

  it('a file-inferred unit on create (no _humanFields) is stamped import', () => {
    commitPlan(db, plan([
      { op: 'create', entity: 'tiers', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Kfar A', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Kfar A', _humanFields: [] },
      { op: 'create', entity: 'groups', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Chagalls', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Chagalls', _link_unit: 'Kfar A', _humanFields: [] },
    ]), { author_user_id: 'u1', device_id: deviceId })

    const row = db.prepare('SELECT id FROM groups WHERE camp_id = ? AND name = ?').get(campId, 'Chagalls')
    expect(latestOp(db, 'groups', row.id, 'tier_id').source).toBe('import')
  })
})

describe('a hand-assigned unit is protected from a later differing re-import', () => {
  it('re-importing with a DIFFERENT file-inferred unit holds a stale conflict, writes nothing', () => {
    const tierAId = randomUUID()
    const tierBId = randomUUID()
    seedTier(tierAId, 'Kfar A')
    seedTier(tierBId, 'Kfar B')
    const groupId = randomUUID()
    seedGroup(groupId, 'Chagalls', { tier_id: tierAId, tierSource: 'human' })

    const before = opCount()
    const res = commitPlan(db, plan(
      updateItem(groupId, 'Chagalls', { unit: { from: 'Kfar A', to: 'Kfar B', source: 'import' } }, []),
    ), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
    expect(groupField(groupId, 'tier_id')).toBe(tierAId)
    expect(res.conflicts.some((c) => c.reason === 'stale')).toBe(true)
  })

  it('control: a file-inferred (non-human) unit updates freely and a later re-import changes it with no conflict', () => {
    const tierAId = randomUUID()
    const tierBId = randomUUID()
    seedTier(tierAId, 'Kfar A')
    seedTier(tierBId, 'Kfar B')
    const groupId = randomUUID()
    seedGroup(groupId, 'Chagalls', { tier_id: tierAId, tierSource: 'import' })

    const res = commitPlan(db, plan(
      updateItem(groupId, 'Chagalls', { unit: { from: 'Kfar A', to: 'Kfar B', source: 'import' } }, []),
    ), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    expect(groupField(groupId, 'tier_id')).toBe(tierBId)
    expect(latestOp(db, 'groups', groupId, 'tier_id').source).toBe('import')
  })

  it('a hand-assigned unit equal to the file value does not thrash between import/human provenance', () => {
    const tierAId = randomUUID()
    seedTier(tierAId, 'Kfar A')
    const groupId = randomUUID()
    seedGroup(groupId, 'Chagalls', { tier_id: tierAId, tierSource: 'human' })

    // The re-import proposes the SAME unit the director already hand-picked —
    // buildPlan's own diff would see no change (identical label), so this is
    // an 'unchanged' item, never reaching decideFieldItem/commitUpdate at all.
    const res = commitPlan(db, plan({
      op: 'unchanged', entity: 'groups', entity_id: groupId, fields: {},
      evidence: { tier: 'exact_name', matched_name: 'Chagalls' }, _name: 'Chagalls',
    }), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    expect(latestOp(db, 'groups', groupId, 'tier_id').source).toBe('human')
  })
})

describe('an explicit unit CLEAR is protected exactly like a set value (Risk 1)', () => {
  it('the clear writes null AND is stamped human, not import', () => {
    const tierAId = randomUUID()
    seedTier(tierAId, 'Kfar A')
    const groupId = randomUUID()
    seedGroup(groupId, 'Chagalls', { tier_id: tierAId, tierSource: 'import' })

    const res = commitPlan(db, plan(
      clearItem(groupId, 'Chagalls', 'Kfar A', ['tier_id']),
    ), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    expect(groupField(groupId, 'tier_id')).toBeNull()
    const latest = latestOp(db, 'groups', groupId, 'tier_id')
    expect(latest.source).toBe('human')
    expect(latest.value).toBeNull()
  })

  it('a THIRD import proposing the original unit again is held stale, not silently re-populated', () => {
    const tierAId = randomUUID()
    seedTier(tierAId, 'Kfar A')
    const groupId = randomUUID()
    seedGroup(groupId, 'Chagalls', { tier_id: tierAId, tierSource: 'import' })

    const cleared = commitPlan(db, plan(
      clearItem(groupId, 'Chagalls', 'Kfar A', ['tier_id']),
    ), { author_user_id: 'u1', device_id: deviceId })
    expect(cleared.held).toBe(false)
    expect(groupField(groupId, 'tier_id')).toBeNull()

    const before = opCount()
    const res = commitPlan(db, plan(
      updateItem(groupId, 'Chagalls', { unit: { from: null, to: 'Kfar A', source: 'import' } }, []),
    ), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
    expect(groupField(groupId, 'tier_id')).toBeNull() // still cleared, not re-populated
    expect(res.conflicts.some((c) => c.reason === 'stale')).toBe(true)
  })

  it('control: an unset override (no clear) leaves the file-inferred fold unaffected', () => {
    const tierAId = randomUUID()
    const tierBId = randomUUID()
    seedTier(tierAId, 'Kfar A')
    seedTier(tierBId, 'Kfar B')
    const groupId = randomUUID()
    seedGroup(groupId, 'Chagalls', { tier_id: tierAId, tierSource: 'import' })

    const res = commitPlan(db, plan(
      updateItem(groupId, 'Chagalls', { unit: { from: 'Kfar A', to: 'Kfar B', source: 'import' } }, []),
    ), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    expect(groupField(groupId, 'tier_id')).toBe(tierBId)
  })
})
