// R1 (packaged-build audit) — Replace-mode import deletes every template_slots
// row on BOTH routes (replaceScope step 1). It must first save each route that
// has placements as a "Before replace — <time>" version, inside the same
// transaction, and abort the whole replace if a save fails.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'
import { remapSnapshotSlots } from '../../src/utils/snapshotRemap.js'

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
const commit = (mode, approved = APPROVED) => commitIngest(db, {
  camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode, approved,
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

  const liveCatalog = () => ({
    groups: db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(campId),
    days: db.prepare('SELECT id, label FROM days_of_operation WHERE camp_id = ?').all(campId),
    timeBlocks: db.prepare('SELECT id, name, start_time, end_time FROM time_blocks WHERE camp_id = ?').all(campId),
    activities: db.prepare('SELECT id, name FROM activities WHERE camp_id = ?').all(campId),
    fixedEvents: [],
  })

  it('restoring that version after a same-setup replace brings every placement back on the NEW ids', () => {
    seedRoutes()
    commit('replace')
    const slots = JSON.parse(versions('template-generated')[0].slots)
    expect(slots.length).toBe(4)
    const { slots: restored, skipped } = remapSnapshotSlots(slots, liveCatalog())
    expect(skipped).toEqual([])
    expect(restored).toHaveLength(4)
    const cat = liveCatalog()
    for (const r of restored) {
      expect(cat.groups.map((g) => g.id)).toContain(r.group_id)
      expect(cat.days.map((d) => d.id)).toContain(r.day_id)
      expect(cat.timeBlocks.map((b) => b.id)).toContain(r.time_block_id)
      expect(cat.activities.map((a) => a.id)).toContain(r.activity_id)
    }
  })

  it('a renamed group\'s cells are skipped and reported by name', () => {
    seedRoutes()
    commit('replace', { ...APPROVED, groups: ['Bunk 1', 'Bunk 3'] })
    const slots = JSON.parse(versions('template-generated')[0].slots)
    const { slots: restored, skipped } = remapSnapshotSlots(slots, liveCatalog())
    expect(restored).toHaveLength(2)
    expect(skipped).toHaveLength(2)
    expect(skipped.map((k) => k.label).every((l) => l.startsWith('Bunk 2 · '))).toBe(true)
    expect(skipped[0].reason).toBe('no matching group')
  })

  it('an old snapshot without names skips dead ids rather than guessing', () => {
    const { slots, skipped } = remapSnapshotSlots(
      [{ group_id: 'gone', day_id: 'gone', time_block_id: 'gone', activity_id: 'gone' }], liveCatalog())
    expect(slots).toEqual([])
    expect(skipped[0].label).toBe('a cell saved without names')
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
