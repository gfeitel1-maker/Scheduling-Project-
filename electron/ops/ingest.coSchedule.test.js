import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'

// T114 follow-up — co-schedule inference reaches the database, WITH the
// evidence that explains it.
//
// Before this, inferCoScheduleRules ran at parse time and its output was
// assigned to a ref nothing ever read: the values were computed and thrown
// away. Now they travel on the rule side-channel as `rule.co_schedule` and
// land on the two columns that already exist for them.
//
// The evidence half is the point of the ticket. A director looking at
// "Up to 3 (same age division)" on the Activities screen must be able to ask
// WHY and be told — otherwise an inference is indistinguishable from
// something they typed themselves, and there is nothing to confirm.
//
// WHY `co_schedule_groups` LIVES IN THE EVIDENCE AND NOT A COLUMN.
// Which groups were seen sharing a slot is an observation, not a scheduling
// constraint the engine reads. `max_groups_per_slot`/`same_tier_only` are
// columns because the engine consumes them; the group list is the supporting
// detail behind them, which is exactly what import_evidence.support is for.
// That keeps this change free of a schema migration.

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-cosched-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db?.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const activity = (name) => db.prepare('SELECT * FROM activities WHERE camp_id = ? AND name = ?').get(campId, name)
const evidenceFor = (name, field) => {
  const a = activity(name)
  const row = db.prepare(
    'SELECT * FROM import_evidence WHERE camp_id = ? AND entity_type = ? AND entity_id = ? AND field = ?'
  ).get(campId, 'activities', a.id, field)
  return row ? { ...row, support: JSON.parse(row.support) } : null
}

const LUNCH = {
  eligible_group_names: ['Tzofim 1'],
  min_per_week: 5,
  max_per_week: 5,
  priority: 'high',
  co_schedule: {
    max_groups_per_slot: 3,
    same_tier_only: true,
    co_schedule_groups: ['Tzofim 1', 'Tzofim 2', 'Tzofim 3'],
    support: {
      busiest_slot: { day: 'Monday', block: '12:00' },
      groups_in_busiest_slot: ['Tzofim 1', 'Tzofim 2', 'Tzofim 3'],
      slots_observed: 5,
    },
  },
}

const commit = (rules, approved) => commitIngest(db, {
  approved: approved ?? { groups: ['Tzofim 1', 'Tzofim 2', 'Tzofim 3'], activities: Object.keys(rules) },
  activityRules: rules,
  camp_id: campId,
  device_id: deviceId,
})

describe('co-schedule inference reaches the columns', () => {
  it('writes max_groups_per_slot and same_tier_only from the inferred rule', () => {
    commit({ 'Lunch 1': LUNCH })
    const a = activity('Lunch 1')
    expect(a.max_groups_per_slot).toBe(3)
    expect(a.same_tier_only).toBe(1)
  })

  it('writes an activity never seen sharing a slot as a capacity of one', () => {
    // "Sports never seen with more than 1 group cannot co-schedule" is a real
    // finding, not an absence — 1 is the honest observed maximum and must be
    // written, or the column stays NULL and reads as "nobody looked".
    commit({ Sports: { ...LUNCH, co_schedule: { max_groups_per_slot: 1, same_tier_only: undefined, co_schedule_groups: [], support: { busiest_slot: { day: 'Tue', block: '10:00' }, groups_in_busiest_slot: ['Tzofim 1'], slots_observed: 3 } } } })
    expect(activity('Sports').max_groups_per_slot).toBe(1)
  })

  it('leaves same_tier_only NULL when division membership was unknown', () => {
    // "we could not tell" and "no, groups mixed" are different answers.
    // Omitted must stay omitted all the way to the column.
    const { same_tier_only: _omit, ...noTier } = LUNCH.co_schedule
    commit({ 'Lunch 1': { ...LUNCH, co_schedule: noTier } })
    expect(activity('Lunch 1').same_tier_only).toBeNull()
  })

  it('refuses a max_groups_per_slot that is not a positive integer', () => {
    // Same write-boundary discipline min_per_week already has: the op log
    // validates rather than trusting file-derived input.
    for (const bad of [0, -2, 1.5, '3', null]) {
      const name = `Bad ${String(bad)}`
      commit({ [name]: { ...LUNCH, co_schedule: { ...LUNCH.co_schedule, max_groups_per_slot: bad } } },
        { groups: ['Tzofim 1'], activities: [name] })
      expect(activity(name).max_groups_per_slot).toBeNull()
    }
  })

  it('writes nothing when the rule carries no co_schedule at all', () => {
    const { co_schedule: _none, ...plain } = LUNCH
    commit({ 'Lunch 1': plain })
    const a = activity('Lunch 1')
    expect(a.max_groups_per_slot).toBeNull()
    expect(a.same_tier_only).toBeNull()
  })
})

describe('co-schedule inference records WHY', () => {
  it('writes observed evidence for max_groups_per_slot, carrying the busiest slot', () => {
    commit({ 'Lunch 1': LUNCH })
    const e = evidenceFor('Lunch 1', 'max_groups_per_slot')
    expect(e).toBeTruthy()
    // Read straight off the grid — a count of groups in one slot is seen, not
    // deduced, so it earns 'observed' where same_tier_only below does not.
    expect(e.tag).toBe('observed')
    expect(e.confidence).toBe('high')
    expect(e.support.busiest_slot).toEqual({ day: 'Monday', block: '12:00' })
    expect(e.support.slots_observed).toBe(5)
  })

  it('carries the groups seen sharing the slot, so "why?" can name them', () => {
    commit({ 'Lunch 1': LUNCH })
    const e = evidenceFor('Lunch 1', 'max_groups_per_slot')
    expect(e.support.co_schedule_groups).toEqual(['Tzofim 1', 'Tzofim 2', 'Tzofim 3'])
  })

  it('writes same_tier_only evidence as INFERRED, not observed', () => {
    commit({ 'Lunch 1': LUNCH })
    const e = evidenceFor('Lunch 1', 'same_tier_only')
    expect(e).toBeTruthy()
    // It depends on a group->division map that is itself partly inferred from
    // group NAMES. Tagging it 'observed' would launder a guess as a sighting —
    // the provenance lie this table exists to prevent.
    expect(e.tag).toBe('inferred')
    expect(e.confidence).toBe('low')
  })

  it('writes no same_tier_only evidence when the answer was unknown', () => {
    const { same_tier_only: _omit, ...noTier } = LUNCH.co_schedule
    commit({ 'Lunch 1': { ...LUNCH, co_schedule: noTier } })
    expect(evidenceFor('Lunch 1', 'same_tier_only')).toBeNull()
  })

  it('does not write evidence for a value the boundary refused', () => {
    // An evidence row for a column that was never written would explain a
    // value the director cannot see — worse than silence.
    commit({ Sports: { ...LUNCH, co_schedule: { ...LUNCH.co_schedule, max_groups_per_slot: 0 } } },
      { groups: ['Tzofim 1'], activities: ['Sports'] })
    expect(evidenceFor('Sports', 'max_groups_per_slot')).toBeNull()
  })

  it('is latest-wins on re-import, like every other evidence row', () => {
    commit({ 'Lunch 1': LUNCH })
    commit({ 'Lunch 1': { ...LUNCH, co_schedule: { ...LUNCH.co_schedule, max_groups_per_slot: 4, support: { ...LUNCH.co_schedule.support, slots_observed: 9 } } } })
    const rows = db.prepare(
      'SELECT * FROM import_evidence WHERE camp_id = ? AND field = ?'
    ).all(campId, 'max_groups_per_slot')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].support).slots_observed).toBe(9)
  })
})
