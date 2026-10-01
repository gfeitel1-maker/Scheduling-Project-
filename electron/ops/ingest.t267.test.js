// T267 PR2 — id-based fixed/recurring event identity cutover.
// docs/adr/2026-09-26-fixed-recurring-event-identity-model.md, "PR 2" section.
//
// Proves the acceptance predicate end-to-end through the REAL commitIngest
// path (not hand-built fixtures — the T62 lesson: a fixture that assumes
// `activity_id` exists stays green while the real write path never sets it).

import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'
import buildSchedule from '../../src/engine/buildSchedule.js'

afterAll(() => {
  cleanupTemplatedDbs()
})

function setup() {
  const { db, file } = openTemplatedDb()
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
  return { db, file, campId }
}

const BASE_APPROVED = {
  groups: ['Bunk 1'],
  days_of_operation: ['Monday'],
  time_blocks: ['09:00-09:40', '10:00-10:40'],
  // "Lunch" is pinned (fixed event); "Archery" is a genuine free-choice activity.
  activities: ['Lunch', 'Archery'],
}

const LUNCH_FIXED_EVENT = {
  name: 'Lunch', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: true, groups: [] },
}

function commit(db, campId, extra) {
  return commitIngest(db, {
    camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: 'device-1', mode: 'add',
    approved: BASE_APPROVED,
    fixedEvents: [LUNCH_FIXED_EVENT],
    pinOnlyActivityNames: ['Lunch'],
    ...extra,
  })
}

describe('T267 PR2 — ingest writes fixed_events.activity_id', () => {
  it('DoD 1: a pinned name gets catalog_role=pinned_event and its fixed_events row links to it', () => {
    const { db, file, campId } = setup()
    try {
      commit(db, campId)

      const lunchActivity = db.prepare("SELECT * FROM activities WHERE camp_id = ? AND name = 'Lunch'").get(campId)
      expect(lunchActivity).toBeTruthy()
      expect(lunchActivity.catalog_role).toBe('pinned_event')

      const lunchAnchor = db.prepare("SELECT * FROM fixed_events WHERE camp_id = ? AND name = 'Lunch'").get(campId)
      expect(lunchAnchor).toBeTruthy()
      expect(lunchAnchor.activity_id).toBe(lunchActivity.id)
    } finally {
      db.close()
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
  })

  it('DoD 4: the free-choice activity from the same import is still freely placeable (not swallowed by catalog_role)', () => {
    const { db, file, campId } = setup()
    try {
      commit(db, campId)
      const archery = db.prepare("SELECT * FROM activities WHERE camp_id = ? AND name = 'Archery'").get(campId)
      expect(archery.catalog_role).toBeFalsy()
    } finally {
      db.close()
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
  })

  it('DoD 3a: a since-deleted activity leaves the fixed_events row pointing at a dead id — FIXED_EVENT_IDENTITY_GAP fires and generation is refused-worthy', () => {
    const { db, file, campId } = setup()
    try {
      commit(db, campId)
      const lunchActivity = db.prepare("SELECT * FROM activities WHERE camp_id = ? AND name = 'Lunch'").get(campId)
      const lunchAnchor = db.prepare("SELECT * FROM fixed_events WHERE camp_id = ? AND name = 'Lunch'").get(campId)

      const groups = db.prepare('SELECT * FROM groups WHERE camp_id = ?').all(campId)
      const days = db.prepare('SELECT * FROM days_of_operation WHERE camp_id = ?').all(campId).map(d => ({ id: d.id, label: d.label, day_of_week: d.day_of_week, sort_order: d.day_of_week }))
      const timeBlocks = db.prepare('SELECT * FROM time_blocks WHERE camp_id = ?').all(campId)
      const allActivities = db.prepare('SELECT * FROM activities WHERE camp_id = ?').all(campId)
      // Simulate the activity having been deleted: it is absent from the
      // `activities` list handed to buildSchedule, but the fixed_events row
      // still carries its (now dead) activity_id.
      const liveActivitiesMinusLunch = allActivities.filter(a => a.id !== lunchActivity.id)

      const result = buildSchedule({
        groups, tiers: [], days, timeBlocks,
        activities: liveActivitiesMinusLunch.map(a => ({ ...a, eligible_tier_ids: [], eligible_group_ids: [] })),
        anchors: [lunchAnchor],
        campId,
      })
      const gap = result.findings.filter(f => f.kind === 'FIXED_EVENT_IDENTITY_GAP')
      expect(gap.length).toBeGreaterThan(0)
      expect(gap[0].severity).toBe('error')
    } finally {
      db.close()
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
  })

  it('DoD 3b: a healthy anchor (activity present) resolves to exactly one id, no gap finding', () => {
    const { db, file, campId } = setup()
    try {
      commit(db, campId)
      const lunchAnchor = db.prepare("SELECT * FROM fixed_events WHERE camp_id = ? AND name = 'Lunch'").get(campId)
      const groups = db.prepare('SELECT * FROM groups WHERE camp_id = ?').all(campId)
      const days = db.prepare('SELECT * FROM days_of_operation WHERE camp_id = ?').all(campId).map(d => ({ id: d.id, label: d.label, day_of_week: d.day_of_week, sort_order: d.day_of_week }))
      const timeBlocks = db.prepare('SELECT * FROM time_blocks WHERE camp_id = ?').all(campId)
      const allActivities = db.prepare('SELECT * FROM activities WHERE camp_id = ?').all(campId).map(a => ({ ...a, eligible_tier_ids: [], eligible_group_ids: [] }))

      const result = buildSchedule({
        groups, tiers: [], days, timeBlocks, activities: allActivities, anchors: [lunchAnchor], campId,
      })
      expect(result.findings.filter(f => f.kind === 'FIXED_EVENT_IDENTITY_GAP')).toHaveLength(0)
    } finally {
      db.close()
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
  })
})
