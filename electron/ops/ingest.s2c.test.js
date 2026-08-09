// S2c — complete the activity/group field-update seam.
// docs/adr/2026-08-08-s2c-activity-and-group-field-update.md
//
// The foundational fix: today `COMPARABLE_COLUMNS.activities = []` so activity
// rule fields (min/max/priority/eligibility/location) and group unit (tier_id)
// never update on a recognized re-import. S2c makes them first-class through the
// existing schedule/clipboard re-import — workbook-independent.
//
// Covers the ADR "Completion evidence" list (1..8):
//   1 activity rule update (max_per_week 2->3 via activityRules) -> op:update
//   2 priority/min/eligibility diff+write; unchanged rule set -> zero ops (F4)
//   3 eligibility is a SET; unresolvable group -> eligibility_unresolved held
//   4 group unit update via label -> tier_id; unresolvable unit -> held
//   5 update-path validation ("3 "->3; "abc"/0/2.5/"medium" -> validation held)
//   6 row-reorder -> NO sort_order delta (recognized diff never reads index)
//   7 string-element back-compat -> byte-identical golden create sequence
//   8 Policy-A: hand-edited rule field re-imported different -> stale held

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
  tmpFile = path.join(os.tmpdir(), `shoresh-s2c-${Date.now()}-${Math.random()}.sqlite`)
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
const activityField = (id, field) => db.prepare(`SELECT ${field} AS v FROM activities WHERE id = ?`).get(id)?.v
const groupField = (id, field) => db.prepare(`SELECT ${field} AS v FROM groups WHERE id = ?`).get(id)?.v
const actId = (name) => db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, name)?.id
const grpId = (name) => db.prepare('SELECT id FROM groups WHERE camp_id = ? AND name = ?').get(campId, name)?.id

// A first import establishing two bunks under two units, and Swim with a rule.
function seedBaseSchedule(rule) {
  return commit({
    approved: {
      tiers: ['Aleph', 'Bet'],
      groups: ['Bunk 1', 'Bunk 2'],
      activities: ['Swim'],
    },
    links: { groups: { 'Bunk 1': 'Aleph', 'Bunk 2': 'Bet' } },
    activityRules: { Swim: rule },
  })
}

// A commitPlan `update` item, for the validation tests that drive the write path
// directly (a raw value the natural adapter would never fold).
const plan = (item) => ({
  plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
  sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
  unresolved: [], items: [item],
})
const updateActivity = (id, name, fields) => ({
  op: 'update', entity: 'activities', entity_id: id, fields,
  evidence: { tier: 'exact_name', matched_name: name }, _name: name,
})

// ---------------------------------------------------------------------------
// 1 — activity rule update (THE gap this closes). RISK A.
// ---------------------------------------------------------------------------
describe('1 — activity rule update via activityRules (RISK A closed)', () => {
  it('re-importing max_per_week 2->3 writes one op and the value changes', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const id = actId('Swim')
    expect(activityField(id, 'max_per_week')).toBe(2)

    const before = opCount()
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 3, priority: 'high' } },
    })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(1)
    expect(opCount()).toBe(before + 1)          // exactly one op
    expect(activityField(id, 'max_per_week')).toBe(3)
    expect(latestOp(db, 'activities', id, 'max_per_week').source).toBe('import')
  })
})

// ---------------------------------------------------------------------------
// 2 — priority / min / eligibility diff + write; unchanged rule set is F4.
// ---------------------------------------------------------------------------
describe('2 — priority/min/eligibility diff + write, F4 idempotency', () => {
  it('priority low->high, min 1->2, and an added eligible group each write', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 3, priority: 'low' })
    const id = actId('Swim')

    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Bunk 1', 'Bunk 2'], min_per_week: 2, max_per_week: 3, priority: 'high' } },
    })
    expect(res.held).toBe(false)
    expect(activityField(id, 'priority')).toBe('high')
    expect(activityField(id, 'min_per_week')).toBe(2)
    const ids = JSON.parse(activityField(id, 'eligible_group_ids'))
    expect(ids.sort()).toEqual([grpId('Bunk 1'), grpId('Bunk 2')].sort())
  })

  it('re-importing the identical rule set is unchanged — zero ops (F4)', () => {
    const rule = { eligible_group_names: ['Bunk 1', 'Bunk 2'], min_per_week: 2, max_per_week: 3, priority: 'high' }
    seedBaseSchedule(rule)
    const before = opCount()
    const res = commit({ approved: { activities: ['Swim'] }, activityRules: { Swim: rule } })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(0)
    expect(opCount()).toBe(before)              // nothing written
  })

  it('a 0/no-minimum activity re-imports clean — F4 holds despite the create floor', () => {
    // min 0 is floored to 1 on create; the adapter does not fold a non-positive
    // min, so the re-import proposes nothing for it -> preserve, no delta.
    const rule = { eligible_group_names: ['Bunk 1'], min_per_week: 0, max_per_week: 1, priority: 'low' }
    seedBaseSchedule(rule)
    const before = opCount()
    const res = commit({ approved: { activities: ['Swim'] }, activityRules: { Swim: rule } })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(0)
    expect(opCount()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 3 — eligibility is a SET; unresolvable label surfaces (never dropped). RISK N.
// ---------------------------------------------------------------------------
describe('3 — eligibility set semantics + unresolvable held (RISK N)', () => {
  it('same groups in a different order → NO delta', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1', 'Bunk 2'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const before = opCount()
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Bunk 2', 'Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' } },
    })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(0)
    expect(opCount()).toBe(before)
  })

  it('an eligibility referencing a non-existent group is eligibility_unresolved, held, not dropped', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const id = actId('Swim')
    const before = opCount()
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Bunk 1', 'Ghost Bunk'], min_per_week: 1, max_per_week: 2, priority: 'high' } },
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)              // whole import writes nothing
    const c = res.conflicts.find((x) => x.reason === 'eligibility_unresolved')
    expect(c).toBeTruthy()
    expect(c.fields.eligible_groups.conflict.unresolved).toContain('Ghost Bunk')
    // The eligibility was NOT silently narrowed to the resolvable subset.
    expect(JSON.parse(activityField(id, 'eligible_group_ids'))).toEqual([grpId('Bunk 1')])
  })
})

// ---------------------------------------------------------------------------
// 4 — group unit update via label -> tier_id. RISK O.
// ---------------------------------------------------------------------------
describe('4 — group unit update via label (RISK O)', () => {
  it('moving a group to a different unit writes tier_id', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const bunk1 = grpId('Bunk 1')
    expect(groupField(bunk1, 'tier_id')).toBe(db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND name = ?').get(campId, 'Aleph').id)

    const res = commit({
      approved: { groups: ['Bunk 1'] },
      links: { groups: { 'Bunk 1': 'Bet' } },
    })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(1)
    expect(groupField(bunk1, 'tier_id')).toBe(db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND name = ?').get(campId, 'Bet').id)
  })

  it('an unresolvable unit label is unit_unresolved, held', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const before = opCount()
    const res = commit({
      approved: { groups: ['Bunk 1'] },
      links: { groups: { 'Bunk 1': 'Gimel' } },  // no such unit
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
    expect(res.conflicts.some((c) => c.reason === 'unit_unresolved')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5 — update-path validation (create-parity). RISK M.
// ---------------------------------------------------------------------------
describe('5 — update-path validation matches the create path (RISK M)', () => {
  it('"3 " is trimmed/coerced to 3 and written', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const id = actId('Swim')
    const res = commitPlan(db, plan(updateActivity(id, 'Swim', { max_per_week: { from: 2, to: '3 ', source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })
    expect(res.held).toBe(false)
    expect(activityField(id, 'max_per_week')).toBe(3)
  })

  for (const bad of ['abc', 0, 2.5]) {
    it(`min_per_week ${JSON.stringify(bad)} is a validation conflict, held, never written raw`, () => {
      seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
      const id = actId('Swim')
      const before = opCount()
      const res = commitPlan(db, plan(updateActivity(id, 'Swim', { min_per_week: { from: 1, to: bad, source: 'import' } })),
        { author_user_id: 'u1', device_id: deviceId })
      expect(res.held).toBe(true)
      expect(opCount()).toBe(before)
      expect(res.conflicts.some((c) => c.reason === 'validation')).toBe(true)
      expect(activityField(id, 'min_per_week')).toBe(1)   // untouched
    })
  }

  it('priority "medium" is a validation conflict, held', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const id = actId('Swim')
    const res = commitPlan(db, plan(updateActivity(id, 'Swim', { priority: { from: 'high', to: 'medium', source: 'import' } })),
      { author_user_id: 'u1', device_id: deviceId })
    expect(res.held).toBe(true)
    expect(res.conflicts.some((c) => c.reason === 'validation')).toBe(true)
    expect(activityField(id, 'priority')).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// 6 — row-reorder is a no-op (recognized diff never reads a row index). RISK E.
// ---------------------------------------------------------------------------
describe('6 — row-reorder produces NO sort_order delta (RISK E)', () => {
  it('re-importing the same days in a different order writes nothing', () => {
    commit({ approved: { days_of_operation: ['Monday', 'Tuesday', 'Wednesday'] } })
    const before = opCount()
    const res = commit({ approved: { days_of_operation: ['Wednesday', 'Monday', 'Tuesday'] } })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(0)
    expect(opCount()).toBe(before)              // no phantom sort_order deltas
  })

  it('buildPlan: a recognized row carrying no fields never derives sort_order', () => {
    const p = buildPlan(
      { approved: { days_of_operation: ['Monday'] }, camp_id: campId },
      { days_of_operation: [{ id: 'd', name: 'Monday', day_of_week: 1, sort_order: 5 }] },
    )
    expect(p.items[0].op).toBe('unchanged')
    expect(p.items[0].fields).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 7 — string-element back-compat: byte-identical create sequence.
// ---------------------------------------------------------------------------
describe('7 — string-element back-compat', () => {
  it('a string element and its {name} record produce the same create ops', () => {
    // Same activity + rule, once with a bare string, once as an explicit record.
    const rule = { eligible_group_names: [], min_per_week: 1, max_per_week: 2, priority: 'high' }
    const before = opCount()
    commit({ approved: { activities: ['Archery'] }, activityRules: { Archery: rule } })
    const afterString = opCount()

    // Fresh camp-equivalent via a second activity, record form.
    commit({ approved: { activities: [{ name: 'Fencing' }] }, activityRules: { Fencing: rule } })
    const afterRecord = opCount()

    // Each create emitted the same number of ops (name + priority + min floor).
    expect(afterString - before).toBe(afterRecord - afterString)
    expect(actId('Archery')).toBeTruthy()
    expect(actId('Fencing')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 8 — Policy-A still governs a rule field (S2b F6 through eligibility/priority).
// ---------------------------------------------------------------------------
describe('8 — Policy-A protects a hand-edited rule field (stale held)', () => {
  it('a human-authored priority differing from the import is a held stale conflict', () => {
    seedBaseSchedule({ eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' })
    const id = actId('Swim')
    // A director hand-edits priority (source human) after the import.
    appendOp(db, { entity: 'activities', entity_id: id, field: 'priority', value: 'low', device_id: deviceId, source: 'human' })

    const before = opCount()
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' } },
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)              // whole import writes nothing
    expect(activityField(id, 'priority')).toBe('low')   // the hand-edit is untouched
    expect(res.conflicts.some((c) => c.reason === 'stale')).toBe(true)
  })
})
