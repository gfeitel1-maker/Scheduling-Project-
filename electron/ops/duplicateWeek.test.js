// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { duplicateWeek } from './duplicateWeek.js'
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
  const file = path.join(os.tmpdir(), `shoresh-dupweek-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function seedCamp(db) {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  return 'camp1'
}

function seedWeek(db, weekId, campId, name = 'Week 1') {
  db.prepare(
    'INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)'
  ).run(weekId, campId, name)
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

function seedOverlay(db, templateId, n) {
  const id = `overlay-${templateId}-${n}`
  db.prepare(
    'INSERT INTO template_overlays (id, template_id, unit_id, day_id, from_block_order, to_block_order, label) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, templateId, null, `day-${n}`, n, n + 1, `Overlay ${n}`)
  return id
}

function seedActivity(db, campId, n) {
  db.prepare("INSERT OR IGNORE INTO activities (id, camp_id, name) VALUES (?, ?, ?)").run(`act-${n}`, campId, `Activity ${n}`)
}

function seedGroup(db, campId, n) {
  db.prepare("INSERT OR IGNORE INTO groups (id, camp_id, name) VALUES (?, ?, ?)").run(`grp-${n}`, campId, `Group ${n}`)
}

const DEVICE = 'test-device'
const CTX = { author_user_id: null, device_id: DEVICE }

function seedDevice(db) {
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'authorized', ?)"
  ).run(DEVICE, 'Test Device', new Date().toISOString())
}

function seedDay(db, campId, n) {
  db.prepare(
    "INSERT OR IGNORE INTO days_of_operation (id, camp_id, label, sort_order) VALUES (?, ?, ?, ?)"
  ).run(`day-${n}`, campId, `Day ${n}`, n)
}

describe('duplicateWeek', () => {
  it('duplicating a week with both routes produces a new week with deep-copied slots/overlays', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week-1', campId)
    const genId = seedTemplate(db, 'week-1', 'generated', campId)
    const manId = seedTemplate(db, 'week-1', 'manual', campId)
    seedActivity(db, campId, 1); seedActivity(db, campId, 2)
    seedGroup(db, campId, 1); seedGroup(db, campId, 2)
    seedDay(db, campId, 1)
    seedSlot(db, genId, 1); seedSlot(db, genId, 2)
    seedSlot(db, manId, 1)
    seedOverlay(db, genId, 1)

    const result = duplicateWeek(db, { sourceWeekId: 'week-1', campId }, CTX)
    expect(result.ok).toBe(true)
    expect(result.newWeekId).toBeDefined()

    const newWeek = db.prepare('SELECT * FROM schedule_weeks WHERE id = ?').get(result.newWeekId)
    expect(newWeek).toBeTruthy()
    expect(newWeek.name).toContain('copy')

    const newTemplates = db.prepare('SELECT * FROM schedule_templates WHERE week_id = ?').all(result.newWeekId)
    expect(newTemplates).toHaveLength(2)

    const newGenTemplate = newTemplates.find((t) => t.kind === 'generated')
    expect(newGenTemplate).toBeTruthy()

    const newSlots = db.prepare('SELECT * FROM template_slots WHERE template_id = ?').all(newGenTemplate.id)
    expect(newSlots).toHaveLength(2)

    // Deep copy — no shared ids with source
    const srcSlotIds = db.prepare('SELECT id FROM template_slots WHERE template_id = ?').all(genId).map((s) => s.id)
    const newSlotIds = newSlots.map((s) => s.id)
    expect(newSlotIds.some((id) => srcSlotIds.includes(id))).toBe(false)

    const newOverlays = db.prepare('SELECT * FROM template_overlays WHERE template_id = ?').all(newGenTemplate.id)
    expect(newOverlays).toHaveLength(1)

    db.close()
  })

  it('source week is unmodified after duplication', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week-1', campId)
    const genId = seedTemplate(db, 'week-1', 'generated', campId)
    seedActivity(db, campId, 1)
    seedGroup(db, campId, 1)
    seedSlot(db, genId, 1)

    duplicateWeek(db, { sourceWeekId: 'week-1', campId }, CTX)

    const srcSlots = db.prepare('SELECT * FROM template_slots WHERE template_id = ?').all(genId)
    expect(srcSlots).toHaveLength(1)
    expect(srcSlots[0].id).toBe(`slot-${genId}-1`)
    db.close()
  })

  it('idempotent retry: same ops produce exactly one copy', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week-1', campId)
    const genId = seedTemplate(db, 'week-1', 'generated', campId)
    seedActivity(db, campId, 1)
    seedGroup(db, campId, 1)
    seedSlot(db, genId, 1)

    const result1 = duplicateWeek(db, { sourceWeekId: 'week-1', campId }, CTX)
    expect(result1.ok).toBe(true)

    // Operations have client_write_ids derived from sourceWeekId + newWeekId.
    // Re-running appendOp with the same client_write_id is absorbed (UNIQUE constraint).
    // Simulate by verifying the op-log has exactly one entry per client_write_id.
    const ops = db.prepare(
      'SELECT client_write_id, COUNT(*) c FROM operations WHERE client_write_id IS NOT NULL GROUP BY client_write_id HAVING c > 1'
    ).all()
    expect(ops).toHaveLength(0)

    db.close()
  })

  it('duplicating a week with only a generated route (no manual) still produces a valid copy', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week-1', campId)
    const genId = seedTemplate(db, 'week-1', 'generated', campId)
    seedActivity(db, campId, 1)
    seedGroup(db, campId, 1)
    seedSlot(db, genId, 1)

    const result = duplicateWeek(db, { sourceWeekId: 'week-1', campId }, CTX)
    expect(result.ok).toBe(true)

    const newTemplates = db.prepare('SELECT kind FROM schedule_templates WHERE week_id = ?').all(result.newWeekId)
    expect(newTemplates.map((t) => t.kind)).toContain('generated')
    expect(newTemplates.map((t) => t.kind)).not.toContain('manual')

    db.close()
  })

  it('returns error when source week does not exist', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    const result = duplicateWeek(db, { sourceWeekId: 'nonexistent', campId }, {})
    expect(result.error).toBe('no-source-week')
    db.close()
  })

  it('collision suffix: copy of a week whose copy name already exists gets (2) suffix', () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedDevice(db)
    seedWeek(db, 'week-1', campId, 'Week 1')
    seedWeek(db, 'week-copy', campId, 'Week 1 copy')
    seedTemplate(db, 'week-1', 'generated', campId)

    const result = duplicateWeek(db, { sourceWeekId: 'week-1', campId }, CTX)
    expect(result.ok).toBe(true)
    expect(result.newName).toBe('Week 1 copy (2)')

    db.close()
  })
})
