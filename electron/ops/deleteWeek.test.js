// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { duplicateWeek } from './duplicateWeek.js'
import { deleteWeek } from './deleteWeek.js'
import { deriveScheduleTemplateId } from './scheduleTemplateId.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function makeDb() {
  const file = path.join(os.tmpdir(), `shoresh-delweek-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function seedCamp(db) {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  return 'camp1'
}

function seedWeek(db, weekId, campId, name, sortOrder = 0) {
  db.prepare(
    'INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, ?, 0)'
  ).run(weekId, campId, name, sortOrder)
}

function seedTemplate(db, weekId, kind, campId) {
  const id = deriveScheduleTemplateId(weekId, kind)
  db.prepare(
    'INSERT INTO schedule_templates (id, camp_id, week_id, name, kind) VALUES (?, ?, ?, ?, ?)'
  ).run(id, campId, weekId, kind === 'manual' ? 'Manual' : 'Generated', kind)
  return id
}

function seedSlot(db, templateId, n) {
  const id = `slot-${templateId}-${n}`
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id, is_anchor, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, templateId, `grp-${n}`, `day-${n}`, `blk-${n}`, `act-${n}`, '0', '{}')
  return id
}

function seedSnapshot(db, templateId, n) {
  const id = `snap-${templateId}-${n}`
  db.prepare(
    "INSERT INTO schedule_snapshots (id, template_id, name, is_auto, created_at, slots) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, templateId, `Snap ${n}`, 0, new Date().toISOString(), '[]')
  return id
}

function seedActivity(db, campId, n) {
  db.prepare("INSERT OR IGNORE INTO activities (id, camp_id, name) VALUES (?, ?, ?)").run(`act-${n}`, campId, `Activity ${n}`)
}

function seedGroup(db, campId, n) {
  db.prepare("INSERT OR IGNORE INTO groups (id, camp_id, name) VALUES (?, ?, ?)").run(`grp-${n}`, campId, `Group ${n}`)
}

function seedDay(db, campId, n) {
  db.prepare("INSERT OR IGNORE INTO days_of_operation (id, camp_id, label, sort_order) VALUES (?, ?, ?, ?)").run(`day-${n}`, campId, `Day ${n}`, n)
}

function seedTimeBlock(db, campId, n) {
  db.prepare("INSERT OR IGNORE INTO time_blocks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)").run(`blk-${n}`, campId, `Block ${n}`, n)
}

function seedSlotPrereqs(db, campId, n) {
  seedActivity(db, campId, n)
  seedGroup(db, campId, n)
  seedDay(db, campId, n)
  seedTimeBlock(db, campId, n)
}

function seedDevice(db) {
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'authorized', ?)"
  ).run('test-device', 'Test Device', new Date().toISOString())
}

const CTX = { author_user_id: null, device_id: 'test-device' }

describe('deleteWeek — S3-2: last-week guard', () => {
  it('returns last-week error and deletes nothing when only one week exists', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1')
    const tid = seedTemplate(db, 'week1', 'generated', campId)
    seedSlotPrereqs(db, campId, 1); seedSlot(db, tid, 1)

    const result = deleteWeek(db, { weekId: 'week1', campId }, CTX)

    expect(result).toEqual({ error: 'last-week' })
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) as c FROM template_slots').get().c).toBe(1)
  })
})

describe('deleteWeek — S3-1: cascade', () => {
  it('removes all scoped rows in one transaction, leaving operations intact', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)

    const tidGen = seedTemplate(db, 'week1', 'generated', campId)
    const tidMan = seedTemplate(db, 'week1', 'manual', campId)
    seedSlotPrereqs(db, campId, 1); seedSlot(db, tidGen, 1)
    seedSlotPrereqs(db, campId, 2); seedSlot(db, tidGen, 2)
    seedSlotPrereqs(db, campId, 3); seedSlot(db, tidMan, 3)
    seedSnapshot(db, tidGen, 1)
    db.prepare('INSERT INTO week_location_exclusions (id, week_id, location_id) VALUES (?, ?, ?)')
      .run('wlx-1', 'week1', 'loc-pool')

    const opsBefore = db.prepare('SELECT COUNT(*) as c FROM operations').get().c

    const result = deleteWeek(db, { weekId: 'week1', campId }, CTX)

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE id = ?').get('week1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_templates WHERE week_id = ?').get('week1').c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) as c FROM template_slots WHERE template_id = ?').get(tidGen).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) as c FROM template_slots WHERE template_id = ?').get(tidMan).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_snapshots WHERE template_id = ?').get(tidGen).c).toBe(0)
    // M5: no orphaned week_location_exclusions rows after the parent week is gone.
    expect(db.prepare('SELECT COUNT(*) as c FROM week_location_exclusions WHERE week_id = ?').get('week1').c).toBe(0)

    // operations table retains history
    const opsAfter = db.prepare('SELECT COUNT(*) as c FROM operations').get().c
    expect(opsAfter).toBeGreaterThan(opsBefore)
  })

  it('does not touch week2 rows', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)

    const tid2 = seedTemplate(db, 'week2', 'generated', campId)
    seedSlotPrereqs(db, campId, 10); seedSlot(db, tid2, 10)
    seedTemplate(db, 'week1', 'generated', campId)

    deleteWeek(db, { weekId: 'week1', campId }, CTX)

    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE id = ?').get('week2').c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) as c FROM template_slots WHERE template_id = ?').get(tid2).c).toBe(1)
  })
})

describe('deleteWeek — S3-3: conflict closure', () => {
  it('closes unresolved conflicts pointing at deleted entities', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)

    const tidGen = seedTemplate(db, 'week1', 'generated', campId)
    seedSlotPrereqs(db, campId, 1); const slotId = seedSlot(db, tidGen, 1)

    // Seed a conflict pointing at the slot
    db.prepare(
      "INSERT INTO conflicts (id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"
    ).run('conflict1', 'template_slots', slotId, 'activity_id', '{}', '{}', 'op1', new Date().toISOString())

    expect(db.prepare('SELECT COUNT(*) as c FROM conflicts WHERE resolved_at IS NULL').get().c).toBe(1)

    deleteWeek(db, { weekId: 'week1', campId }, CTX)

    // The conflict row should be deleted via op-log
    expect(db.prepare('SELECT COUNT(*) as c FROM conflicts WHERE id = ? AND resolved_at IS NULL').get('conflict1').c).toBe(0)
  })
})

describe('deleteWeek — S3-7: duplicate then delete source', () => {
  it('copy is fully intact with no dangling references to source week ids', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)

    const tid1Gen = seedTemplate(db, 'week1', 'generated', campId)
    const tid1Man = seedTemplate(db, 'week1', 'manual', campId)
    seedSlotPrereqs(db, campId, 1); seedSlot(db, tid1Gen, 1)
    seedSlotPrereqs(db, campId, 2); seedSlot(db, tid1Man, 2)

    // Duplicate week1 → week3
    const dupResult = duplicateWeek(db, { sourceWeekId: 'week1', campId }, CTX)
    expect(dupResult.ok).toBe(true)
    const week3Id = dupResult.newWeekId

    // week3 has its own templates with fresh ids
    const week3Templates = db.prepare('SELECT id FROM schedule_templates WHERE week_id = ?').all(week3Id)
    expect(week3Templates.length).toBe(2)
    const week3TemplateIds = new Set(week3Templates.map(t => t.id))

    const week3Slots = db.prepare('SELECT id FROM template_slots WHERE template_id IN (SELECT id FROM schedule_templates WHERE week_id = ?)').all(week3Id)
    expect(week3Slots.length).toBeGreaterThan(0)

    // Delete week1 (the source)
    const deleteResult = deleteWeek(db, { weekId: 'week1', campId }, CTX)
    expect(deleteResult.ok).toBe(true)

    // week1 is gone
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE id = ?').get('week1').c).toBe(0)

    // week3 is fully intact
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE id = ?').get(week3Id).c).toBe(1)
    for (const tid of week3TemplateIds) {
      expect(db.prepare('SELECT COUNT(*) as c FROM schedule_templates WHERE id = ?').get(tid).c).toBe(1)
    }
    // week3's slots still point at week3's template ids, not week1's
    const week3SlotTemplateIds = db
      .prepare('SELECT DISTINCT template_id FROM template_slots WHERE template_id IN (SELECT id FROM schedule_templates WHERE week_id = ?)')
      .all(week3Id)
      .map(r => r.template_id)
    expect(week3SlotTemplateIds.length).toBeGreaterThan(0)
    for (const tid of week3SlotTemplateIds) {
      expect(week3TemplateIds.has(tid)).toBe(true)
    }

    // week2 is unaffected
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE id = ?').get('week2').c).toBe(1)
  })

  it('deleting the camp\'s only week returns last-week error', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1')
    seedTemplate(db, 'week1', 'generated', campId)

    const result = deleteWeek(db, { weekId: 'week1', campId }, CTX)

    expect(result).toEqual({ error: 'last-week' })
    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks').get().c).toBe(1)
  })
})

describe('deleteWeek — anchor_activities.schedule_week_id FK-cascade landmine (v42 Red Hat HIGH 3)', () => {
  it('nulls the binding on an anchor scoped to the deleted week instead of throwing an FK error', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)
    seedTemplate(db, 'week2', 'generated', campId) // keep week2 non-empty so week1 isn't the last week

    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, schedule_week_id) VALUES (?, ?, ?, ?)"
    ).run('anchor1', campId, 'Flag Raising', 'week1')

    expect(() => deleteWeek(db, { weekId: 'week1', campId }, CTX)).not.toThrow()

    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE id = ?').get('week1').c).toBe(0)

    const anchor = db.prepare('SELECT id, schedule_week_id FROM anchor_activities WHERE id = ?').get('anchor1')
    expect(anchor).toBeTruthy()
    expect(anchor.schedule_week_id).toBeNull()
  })

  it('leaves an anchor bound to a different week untouched', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)
    seedTemplate(db, 'week1', 'generated', campId)

    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, schedule_week_id) VALUES (?, ?, ?, ?)"
    ).run('anchor2', campId, 'Swim Rotation', 'week2')

    deleteWeek(db, { weekId: 'week1', campId }, CTX)

    const anchor = db.prepare('SELECT schedule_week_id FROM anchor_activities WHERE id = ?').get('anchor2')
    expect(anchor.schedule_week_id).toBe('week2')
  })
})

describe('deleteWeek — elective_sets.schedule_week_id FK-cascade landmine (v43 Slice 3a)', () => {
  it('nulls the binding on an elective set scoped to the deleted week instead of throwing an FK error', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)
    seedTemplate(db, 'week2', 'generated', campId) // keep week2 non-empty so week1 isn't the last week

    db.prepare(
      "INSERT INTO elective_sets (id, camp_id, name, schedule_week_id) VALUES (?, ?, ?, ?)"
    ).run('es1', campId, 'Afternoon Electives', 'week1')

    expect(() => deleteWeek(db, { weekId: 'week1', campId }, CTX)).not.toThrow()

    expect(db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE id = ?').get('week1').c).toBe(0)

    const set = db.prepare('SELECT id, schedule_week_id FROM elective_sets WHERE id = ?').get('es1')
    expect(set).toBeTruthy()
    expect(set.schedule_week_id).toBeNull()
  })

  it('leaves an elective set bound to a different week untouched', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week1', campId, 'Week 1', 0)
    seedWeek(db, 'week2', campId, 'Week 2', 1)
    seedTemplate(db, 'week1', 'generated', campId)

    db.prepare(
      "INSERT INTO elective_sets (id, camp_id, name, schedule_week_id) VALUES (?, ?, ?, ?)"
    ).run('es2', campId, 'Morning Electives', 'week2')

    deleteWeek(db, { weekId: 'week1', campId }, CTX)

    const set = db.prepare('SELECT schedule_week_id FROM elective_sets WHERE id = ?').get('es2')
    expect(set.schedule_week_id).toBe('week2')
  })
})
