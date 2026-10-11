// F1 (synthetic-15 scorecard): two inferred events sharing name/block/day with
// different group sets must not lose the second group set at commit. The slot key is
// scope-blind (docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md),
// so the scopes are unioned per slot before the one row per slot is written.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'
import { appendOp, DELETE_FIELD } from './operations.js'

afterAll(() => cleanupTemplatedDbs())
let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})
afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })
const rows = () => db.prepare('SELECT fe.*, d.label day FROM fixed_events fe JOIN days_of_operation d ON d.id = fe.day_id WHERE fe.camp_id = ?').all(campId)
const groupName = () => new Map(db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(campId).map((g) => [g.id, g.name]))
const scopeOf = (r) => JSON.parse(r.group_ids).map((id) => groupName().get(id)).sort()

const INPUT = {
  approved: {
    groups: ['Otters 1', 'Otters 2', 'Otters 3'],
    days_of_operation: ['Monday', 'Thursday'],
    time_blocks: ['10:00-10:45'],
    activities: ['Swim'],
  },
  fixedEvents: [
    { name: 'Lunch', time_block: '10:00-10:45', days: ['Monday', 'Thursday'], scope: { is_all_groups: false, groups: ['Otters 3'] } },
    { name: 'Lunch', time_block: '10:00-10:45', days: ['Monday'], scope: { is_all_groups: false, groups: ['Otters 1', 'Otters 2'] } },
  ],
}

describe('F1 - same name/block/day, two group sets', () => {
  it('keeps both group sets on the shared day', () => {
    commit(INPUT)
    const mon = rows().filter((r) => r.day === 'Monday')
    expect(mon).toHaveLength(1)
    expect(scopeOf(mon[0])).toEqual(['Otters 1', 'Otters 2', 'Otters 3'])
    const thu = rows().filter((r) => r.day === 'Thursday')
    expect(scopeOf(thu[0])).toEqual(['Otters 3'])
  })

  it('is order-independent', () => {
    commit({ ...INPUT, fixedEvents: [...INPUT.fixedEvents].reverse() })
    const mon = rows().find((r) => r.day === 'Monday')
    expect(scopeOf(mon)).toEqual(['Otters 1', 'Otters 2', 'Otters 3'])
  })

  it('Keep re-import of the same input writes nothing new and reports no scope drift', () => {
    commit(INPUT)
    const before = rows().length
    const second = commit(INPUT)
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(rows()).toHaveLength(before)
  })
})

const TWO_BLOCKS = {
  approved: {
    groups: ['Otters 1', 'Otters 2', 'Otters 3'],
    days_of_operation: ['Monday'],
    time_blocks: ['10:00-10:45', '11:00-11:45'],
    activities: ['Swim'],
  },
}
const ev = (groups, extra = {}) => ({
  name: 'Lunch', time_block: '10:00-10:45', days: ['Monday'],
  scope: groups === 'all' ? { is_all_groups: true, groups: [] } : { is_all_groups: false, groups },
  ...extra,
})

describe('F1 - span', () => {
  it('T363: different spans are never unioned: both import, each keeping its own span and group set', () => {
    const out = commit({ ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3'], { span_blocks: 2 }), ev(['Otters 1', 'Otters 2'])] })
    const mon = rows().sort((a, b) => (b.span_blocks ?? 1) - (a.span_blocks ?? 1))
    expect(mon).toHaveLength(2)
    expect(scopeOf(mon[0])).toEqual(['Otters 3'])
    expect(mon[0].span_blocks).toBe(2)
    expect(scopeOf(mon[1])).toEqual(['Otters 1', 'Otters 2'])
    expect(mon[1].span_blocks ?? 1).toBe(1)
    expect(out.fixedEvents.partial).toEqual([])
  })

  it('T363: Keep re-import of two same-slot events with different spans writes nothing new', () => {
    const input = { ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3'], { span_blocks: 2 }), ev(['Otters 1', 'Otters 2'])] }
    commit(input)
    const second = commit(input)
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(rows()).toHaveLength(2)
  })

  it('T363: a director deleting one of the two is honoured on re-import (tombstone is per span)', () => {
    const input = { ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3'], { span_blocks: 2 }), ev(['Otters 1', 'Otters 2'])] }
    commit(input)
    const long = rows().find((r) => r.span_blocks === 2)
    appendOp(db, { entity: 'fixed_events', entity_id: long.id, field: DELETE_FIELD, value: 1, source: 'human', author_user_id: 'u1', device_id: deviceId, parent_op_id: null, client_write_id: randomUUID() })
    const second = commit(input)
    expect(second.fixedEvents.rejected).toHaveLength(1)
    expect(rows()).toHaveLength(1)
    expect(rows()[0].span_blocks ?? 1).toBe(1)
  })

  it('equal spans are unioned and keep the span', () => {
    commit({ ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3'], { span_blocks: 2 }), ev(['Otters 1', 'Otters 2'], { span_blocks: 2 })] })
    const mon = rows()
    expect(mon).toHaveLength(1)
    expect(scopeOf(mon[0])).toEqual(['Otters 1', 'Otters 2', 'Otters 3'])
    expect(mon[0].span_blocks).toBe(2)
  })
})

describe('F1 - skipped events and partial group resolution', () => {
  it('an event the loop skips (no resolvable groups) adds nothing to the union', () => {
    commit({ ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3']), ev(['Nobody'])] })
    expect(scopeOf(rows()[0])).toEqual(['Otters 3'])
  })

  it('an event on an unknown day is skipped and does not widen another slot', () => {
    commit({ ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3']), ev(['Otters 1'], { days: ['Friday'] })] })
    expect(scopeOf(rows()[0])).toEqual(['Otters 3'])
  })

  it('a partly-resolved sibling makes the union uncomparable: no false drift on re-import', () => {
    const input = { ...TWO_BLOCKS, fixedEvents: [ev(['Otters 1']), ev(['Otters 2', 'Ghost'])] }
    commit(input)
    const o1 = [...groupName()].find(([, n]) => n === 'Otters 1')[0]
    db.prepare('UPDATE fixed_events SET group_ids = ? WHERE camp_id = ?').run(JSON.stringify([o1]), campId)
    const second = commit(input)
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(second.fixedEvents.created).toBe(0)
  })
})

describe('F1 - all-groups mix, Replace, hand edits', () => {
  it('an all-groups event plus an explicit one on the same slot is all groups', () => {
    commit({ ...TWO_BLOCKS, fixedEvents: [ev(['Otters 1']), ev('all')] })
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].is_all_groups).toBe(1)
    expect(JSON.parse(r[0].group_ids)).toEqual([])
  })

  it('Replace mode writes the union', () => {
    commit({ ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3'])] })
    commit({ ...TWO_BLOCKS, mode: 'replace', fixedEvents: [ev(['Otters 3']), ev(['Otters 1', 'Otters 2'])] })
    expect(scopeOf(rows()[0])).toEqual(['Otters 1', 'Otters 2', 'Otters 3'])
  })

  it('Replace mode restores a preserved division scope over the union', () => {
    const approved = { ...TWO_BLOCKS.approved, tiers: ['Juniors'] }
    const links = { groups: { 'Otters 1': 'Juniors', 'Otters 2': 'Juniors', 'Otters 3': 'Juniors' } }
    const fes = [ev(['Otters 3']), ev(['Otters 1', 'Otters 2'])]
    commit({ approved, links, fixedEvents: fes })
    const jid = db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND name = ?').get(campId, 'Juniors').id
    db.prepare("UPDATE fixed_events SET is_all_groups = 0, group_ids = '[]', unit_ids = ? WHERE camp_id = ?").run(JSON.stringify([jid]), campId)
    const res = commit({ approved, links, mode: 'replace', fixedEvents: fes })
    const r = rows()
    expect(r).toHaveLength(1)
    const newJid = db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND name = ?').get(campId, 'Juniors').id
    expect(JSON.parse(r[0].unit_ids)).toEqual([newJid])
    expect(JSON.parse(r[0].group_ids)).toEqual([])
    expect(res.fixedEvents.scopePreserved).toContainEqual(expect.objectContaining({ name: 'Lunch' }))
  })

  it('a hand-narrowed unioned row is reported as drift on re-import and not rewritten', () => {
    const input = { ...TWO_BLOCKS, fixedEvents: [ev(['Otters 3']), ev(['Otters 1', 'Otters 2'])] }
    commit(input)
    const o3 = [...groupName()].find(([, n]) => n === 'Otters 3')[0]
    db.prepare('UPDATE fixed_events SET group_ids = ? WHERE camp_id = ?').run(JSON.stringify([o3]), campId)
    const second = commit(input)
    expect(second.fixedEvents.scopeChanged).toHaveLength(1)
    expect(second.fixedEvents.created).toBe(0)
    expect(scopeOf(rows()[0])).toEqual(['Otters 3'])
  })
})
