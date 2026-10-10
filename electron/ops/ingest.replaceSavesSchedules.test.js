// R1 (packaged-build audit) — Replace-mode import deletes every template_slots
// row on BOTH routes (replaceScope step 1). It must first save each route that
// has placements as a "Before replace — <time>" version, inside the same
// transaction, and abort the whole replace if a save fails.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'
import { dropDeadReferences } from '../../src/screens/schedule/useSnapshots.js'

afterAll(() => { cleanupTemplatedDbs() })

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

const APPROVED = {
  groups: ['Bunk 1', 'Bunk 2'],
  days_of_operation: ['Monday', 'Tuesday'],
  time_blocks: ['09:00-09:40'],
  activities: ['Swim'],
}
const commit = (mode) => commitIngest(db, {
  camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode, approved: APPROVED,
})
const ids = (table, col = 'name') => Object.fromEntries(
  db.prepare(`SELECT id, ${col} AS n FROM ${table} WHERE camp_id = ?`).all(campId).map((r) => [r.n, r.id]))

function seedRoutes({ manual = true, generated = true } = {}) {
  commit('add')
  const g = ids('groups'), d = ids('days_of_operation', 'label'), b = ids('time_blocks'), a = ids('activities')
  const insert = db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)')
  const placed = {}
  for (const [kind, on] of [['manual', manual], ['generated', generated]]) {
    const tid = `template-${kind}`
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)').run(tid, campId, kind, kind)
    if (!on) continue
    placed[kind] = []
    for (const gn of Object.keys(g)) for (const dn of Object.keys(d)) {
      insert.run(`${tid}-${gn}-${dn}`, tid, g[gn], a.Swim, d[dn], b['09:00-09:40'])
      placed[kind].push({ group_id: g[gn], day_id: d[dn], time_block_id: b['09:00-09:40'], activity_id: a.Swim })
    }
  }
  return placed
}

const versions = (tid) => db.prepare('SELECT * FROM schedule_snapshots WHERE template_id = ?').all(tid)
const keyOf = (s) => `${s.group_id}|${s.day_id}|${s.time_block_id}|${s.activity_id}`

describe('R1 — Replace saves both schedules first', () => {
  it('leaves a "Before replace" version on each route holding exactly the pre-replace slots', () => {
    const placed = seedRoutes()
    commit('replace')
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots').get().n).toBe(0)
    for (const kind of ['manual', 'generated']) {
      const vs = versions(`template-${kind}`)
      expect(vs).toHaveLength(1)
      expect(vs[0].name).toMatch(/^Before replace — .+/)
      expect(vs[0].is_auto).toBe(1)
      const slots = JSON.parse(vs[0].slots)
      expect(slots.map(keyOf).sort()).toEqual(placed[kind].map(keyOf).sort())
    }
  })

  it('saves only routes that actually have placements', () => {
    seedRoutes({ generated: false })
    commit('replace')
    expect(versions('template-manual')).toHaveLength(1)
    expect(versions('template-generated')).toHaveLength(0)
  })

  it('writes no version when nothing is placed', () => {
    seedRoutes({ manual: false, generated: false })
    commit('replace')
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_snapshots').get().n).toBe(0)
  })

  it('writes no version in add mode', () => {
    seedRoutes()
    commit('add')
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_snapshots').get().n).toBe(0)
  })

  it('restoring that version after the replace: every cell is reported dead, because Replace mints new ids', () => {
    seedRoutes()
    commit('replace')
    const slots = JSON.parse(versions('template-generated')[0].slots)
    const live = {
      groups: db.prepare('SELECT id FROM groups WHERE camp_id = ?').all(campId),
      days: db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ?').all(campId),
      timeBlocks: db.prepare('SELECT id FROM time_blocks WHERE camp_id = ?').all(campId),
      activities: db.prepare('SELECT id FROM activities WHERE camp_id = ?').all(campId),
      fixedEvents: [],
    }
    expect(slots.length).toBe(4)
    expect(dropDeadReferences(slots, live)).toHaveLength(0)
  })

  it('a failed save aborts the replace: nothing is cleared, nothing imported', () => {
    seedRoutes()
    db.exec("CREATE TRIGGER block_snapshots BEFORE INSERT ON schedule_snapshots BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    const groupsBefore = ids('groups')
    expect(() => commit('replace')).toThrow()
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots').get().n).toBe(8)
    expect(ids('groups')).toEqual(groupsBefore)
  })
})
