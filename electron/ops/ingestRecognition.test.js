import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest, commitPlan } from './ingest.js'

// S1a — commit-time RECOGNITION + hold-the-whole-import.
// docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md §1,§2,§3,§4,§5.

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-s1a-${Date.now()}-${Math.random()}.sqlite`)
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

const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
const opCount = () => db.prepare('SELECT COUNT(*) c FROM operations').get().c

const RICH = {
  approved: {
    cohorts: ['Main'],
    tiers: ['Aleph', 'Bet'],
    groups: ['Bunk 1', 'Bunk 2'],
    days_of_operation: ['Monday', 'Tuesday'],
    time_blocks: ['09:00-09:40', 'Block 2'],
    activities: ['Swim', 'Archery'],
  },
  links: { groups: { 'Bunk 1': 'Aleph', 'Bunk 2': 'Bet' } },
}

// F4 (scoped to the six ingestible entities). An identical re-import of an
// already-present camp recognizes everything and writes ZERO ops.
describe('F4 — identical re-import is all-unchanged, zero ops (S1a §1, §5)', () => {
  it('writes zero ops across the six ingestible entities on re-import', () => {
    const first = commitIngest(db, { ...RICH, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
    expect(first.held).toBe(false)
    expect(first.total).toBeGreaterThan(0)

    const opsAfterFirst = opCount()
    const second = commitIngest(db, { ...RICH, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })

    expect(second.held).toBe(false)
    expect(second.total).toBe(0)
    for (const entity of ['cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities']) {
      expect(second.created[entity]).toBe(0)
    }
    // No new op of any kind was appended by the second import.
    expect(opCount()).toBe(opsAfterFirst)
    // And no duplicate rows materialized.
    expect(count('activities')).toBe(2)
    expect(count('groups')).toBe(2)
    expect(count('days_of_operation')).toBe(2)
  })
})

describe('commit-time ambiguous_identity (§3, live against the DB)', () => {
  it('holds when a peer added a second normalize-colliding row after preview', () => {
    // Two live rows "Art" and "art " both exist (legal under UNIQUE on raw name).
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, 'Art')
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, 'art ')

    const before = opCount()
    const result = commitIngest(db, {
      approved: { activities: ['Art'] }, camp_id: campId, device_id: deviceId,
    })

    expect(result.held).toBe(true)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].reason).toBe('ambiguous_identity')
    expect(result.conflicts[0].evidence.candidates).toHaveLength(2)
    expect(opCount()).toBe(before) // nothing written
  })
})

describe('R4 — peer-created same-name row in the review window holds the import (§2)', () => {
  it('surfaces a gated conflict, writes zero rows, and re-commit after resolving succeeds', () => {
    // Provisional plan (built when the camp had no "Swim") recognizes nothing,
    // so Swim is a create. Between preview and commit a peer creates "Swim".
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('peer-swim', campId, 'Swim')

    const plan = {
      plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
      sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
      unresolved: [],
      items: [
        { op: 'create', entity: 'activities', entity_id: null, fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Swim', source: 'import' } }, evidence: { tier: 'new' }, _name: 'Swim' },
        { op: 'create', entity: 'activities', entity_id: null, fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Archery', source: 'import' } }, evidence: { tier: 'new' }, _name: 'Archery' },
      ],
    }

    const before = opCount()
    const held = commitPlan(db, plan, { author_user_id: 'u1', device_id: deviceId })
    expect(held.held).toBe(true)
    expect(held.conflicts).toHaveLength(1)
    expect(held.conflicts[0]._name).toBe('Swim')
    expect(held.conflicts[0].evidence.candidates[0].id).toBe('peer-swim')
    // No UNIQUE throw, and the whole import held — not even Archery landed.
    expect(opCount()).toBe(before)
    expect(count('activities')).toBe(1)

    // Director resolves: drops the colliding Swim (recognizes the peer row). The
    // re-commit — now only Archery as a create — succeeds in full.
    const resolved = { ...plan, items: [plan.items[1]] }
    const ok = commitPlan(db, resolved, { author_user_id: 'u1', device_id: deviceId })
    expect(ok.held).toBe(false)
    expect(ok.total).toBe(1)
    expect(count('activities')).toBe(2)
  })

  it('holds when an unchanged item\'s live row was deleted in the window', () => {
    // First import creates Swim; the plan below recognizes it as unchanged.
    commitIngest(db, { approved: { activities: ['Swim'] }, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
    const swimId = db.prepare("SELECT id FROM activities WHERE name = 'Swim'").get().id

    // A peer deletes the row (its projection row goes away).
    db.prepare('DELETE FROM activities WHERE id = ?').run(swimId)

    const plan = {
      plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
      sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
      unresolved: [],
      items: [
        { op: 'unchanged', entity: 'activities', entity_id: swimId, fields: {}, evidence: { tier: 'exact_name', matched_name: 'Swim' }, _name: 'Swim' },
      ],
    }
    const before = opCount()
    const result = commitPlan(db, plan, { author_user_id: 'u1', device_id: deviceId })
    expect(result.held).toBe(true)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].reason).toBe('ambiguous_identity')
    expect(opCount()).toBe(before) // no silent re-mint
  })
})

describe('conflict gates; clear/cross_source still throw, update/stale go live (S2b §4)', () => {
  const base = (item) => ({
    plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
    sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
    unresolved: [], items: [item],
  })

  it('gates an ambiguous_identity conflict: no op, no throw, held', () => {
    const before = opCount()
    const result = commitPlan(db, base({
      op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity',
      fields: {}, evidence: { tier: 'exact_name', candidates: [] }, _name: 'X',
    }), { author_user_id: 'u1', device_id: deviceId })
    expect(result.held).toBe(true)
    expect(opCount()).toBe(before)
  })

  it('op:update no longer throws — an update whose row was deleted holds as ambiguous_identity', () => {
    // S2b: `update` is live. An update pointing at a non-existent row cannot
    // resolve its identity, so it holds (no op, no throw), exactly like a
    // deleted `unchanged` — it does NOT throw "not implemented".
    const before = opCount()
    const result = commitPlan(db, base({
      op: 'update', entity: 'activities', entity_id: 'no-such-row',
      fields: { name: { from: 'A', to: 'B', source: 'import' } }, _name: 'A',
    }), { author_user_id: 'u1', device_id: deviceId })
    expect(result.held).toBe(true)
    expect(result.conflicts[0].reason).toBe('ambiguous_identity')
    expect(opCount()).toBe(before)
  })

  it('throws on op:clear', () => {
    expect(() => commitPlan(db, base({ op: 'clear', entity: 'activities', entity_id: 'x', fields: {} }),
      { author_user_id: 'u1', device_id: deviceId })).toThrow(/not implemented/)
  })

  it('a stale conflict item gates (no throw); cross_source still throws', () => {
    // S2b: `stale` is a real, gated reason now — collected into conflicts, held,
    // no throw. cross_source (S7) is still unbuilt and throws.
    const before = opCount()
    const stale = commitPlan(db, base({
      op: 'conflict', entity: 'activities', entity_id: null, reason: 'stale', fields: {}, evidence: {},
    }), { author_user_id: 'u1', device_id: deviceId })
    expect(stale.held).toBe(true)
    expect(opCount()).toBe(before)

    expect(() => commitPlan(db, base({ op: 'conflict', entity: 'activities', entity_id: null, reason: 'cross_source', fields: {}, evidence: {} }),
      { author_user_id: 'u1', device_id: deviceId })).toThrow(/not implemented/)
  })
})

describe('fixed events still re-emit on re-import (documented, NOT idempotent — T72)', () => {
  it('duplicates anchors on identical re-import, while the six entities stay unchanged', () => {
    const coMain = 'co-fx'
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(coMain, campId, 'Main')
    const payload = {
      approved: { groups: ['A'], days_of_operation: ['Monday'], time_blocks: ['09:00-09:30'] },
      fixedEvents: [{ name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'], scope: { is_all_groups: true, groups: null } }],
      camp_id: campId, cohort_id: coMain, device_id: deviceId, author_user_id: 'u1',
    }
    const first = commitIngest(db, payload)
    expect(first.fixedEvents.created).toBe(1)
    expect(count('anchor_activities')).toBe(1)

    const second = commitIngest(db, payload)
    // The six entities recognized (zero) — but the fixed-event loop is NOT part
    // of F4 and re-emits (T72). This test PINS that documented behavior; it does
    // NOT assert anchor idempotency.
    expect(second.total).toBe(0)
    expect(second.fixedEvents.created).toBe(1)
    expect(count('anchor_activities')).toBe(2)
  })
})
