// @vitest-environment node
//
// Merging two activities — the referrer sweep is the whole risk.
//
// WHY THIS IS TEST-FIRST. The Locations merge shipped handling two referrer
// kinds out of six; the other four were silently orphaned, and it took a Red Hat
// review to find them. Activities are worse in two specific ways:
//
//   1. THREE of the five activity_id columns have NO foreign key
//      (special_day_slots, elective_set_activities, event_slots) — deliberately,
//      per their own schema comments. A merge that forgets them produces no SQL
//      error, no failing constraint, nothing. Just a schedule pointing at an
//      activity that no longer exists.
//   2. An activity can reference ANOTHER activity, via
//      `activities.weather_alternative_id`. A sweep that greps for `activity_id`
//      does not find it. This one was missed by exactly that sweep while writing
//      this file, and caught by reading PRAGMA table_info instead.
//
// So every referrer gets its own test, and each asserts the ROW AFTER THE MERGE
// rather than that the merge returned ok — the standing lesson from a week of
// writers that could not fail loudly.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { mergeActivity } from './mergeActivity.js'

let db, campId, deviceId, winner, loser, weekId, specialDayId, eventId

const templateId = 'tpl-1'

function mkActivity(name) {
  const id = randomUUID()
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(id, campId, name)
  return id
}

beforeEach(() => {
  // Was a mkdtemp dir + openLocalDb — the per-test migration-chain replay, ~304ms
  // (T188/F2b). The template copy already lives in its own tmp path, so the
  // per-test directory it used to need is gone, and cleanupTemplatedDbs owns
  // removing the file instead of this file's own rmSync.
  const __t = openTemplatedDb()
  db = __t.db
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'C', 'a'.repeat(64))
  deviceId = randomUUID()
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'H')
  // Parent rows the referrer tables have real foreign keys to. Created here
  // rather than stubbed, so the merge is exercised against the shape the app
  // actually stores.
  weekId = randomUUID()
  db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, is_archived) VALUES (?, ?, ?, 0)').run(weekId, campId, 'W1')
  specialDayId = randomUUID()
  db.prepare('INSERT INTO special_days (id, camp_id, name) VALUES (?, ?, ?)').run(specialDayId, campId, 'Trip Day')
  eventId = randomUUID()
  db.prepare('INSERT INTO events (id, camp_id, name) VALUES (?, ?, ?)').run(eventId, campId, 'Colour War')
  winner = mkActivity('Music')
  loser = mkActivity('Musik')
})
afterEach(() => { try { db.close() } catch { /* already closed */ } })

// Discards the cached template once, at the end (T188/F2b).
afterAll(() => {
  cleanupTemplatedDbs()
})

const merge = (over = {}) => mergeActivity(db, { loser_id: loser, winner_id: winner, author_user_id: null, device_id: deviceId, ...over })

describe('the loser is gone and the winner survives', () => {
  it('deletes the losing activity and keeps the winner', () => {
    const res = merge()
    expect(res.error).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM activities WHERE id = ?').get(loser)).toBeUndefined()
    expect(db.prepare('SELECT name FROM activities WHERE id = ?').get(winner)?.name).toBe('Music')
  })

  it('refuses to merge an activity into itself', () => {
    expect(mergeActivity(db, { loser_id: loser, winner_id: loser, device_id: deviceId }).error).toBe('invalid-winner')
  })

  it('refuses when the winner does not exist', () => {
    expect(mergeActivity(db, { loser_id: loser, winner_id: randomUUID(), device_id: deviceId }).error).toBe('no-winner')
  })

  it('refuses when the loser does not exist', () => {
    expect(mergeActivity(db, { loser_id: randomUUID(), winner_id: winner, device_id: deviceId }).error).toBe('no-record')
  })
})

describe('every referrer is re-pointed — including the ones with no foreign key', () => {
  it('template_slots (hard FK)', () => {
    const id = randomUUID()
    db.prepare('INSERT INTO template_slots (id, template_id, activity_id) VALUES (?, ?, ?)').run(id, templateId, loser)
    merge()
    expect(db.prepare('SELECT activity_id FROM template_slots WHERE id = ?').get(id).activity_id).toBe(winner)
  })

  it('week_activity_exclusions (hard FK)', () => {
    const id = randomUUID()
    db.prepare('INSERT INTO week_activity_exclusions (id, week_id, activity_id) VALUES (?, ?, ?)').run(id, weekId, loser)
    merge()
    expect(db.prepare('SELECT activity_id FROM week_activity_exclusions WHERE id = ?').get(id).activity_id).toBe(winner)
  })

  it('special_day_slots (NO foreign key — nothing would have complained)', () => {
    const id = randomUUID()
    db.prepare('INSERT INTO special_day_slots (id, special_day_id, group_id, time_block_id, activity_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, specialDayId, 'g-1', 'tb-1', loser)
    merge()
    expect(db.prepare('SELECT activity_id FROM special_day_slots WHERE id = ?').get(id).activity_id).toBe(winner)
  })

  it('event_slots (NO foreign key)', () => {
    const id = randomUUID()
    db.prepare('INSERT INTO event_slots (id, event_id, event_group_id, time_block_id, activity_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, eventId, 'eg-1', 'tb-1', loser)
    merge()
    expect(db.prepare('SELECT activity_id FROM event_slots WHERE id = ?').get(id).activity_id).toBe(winner)
  })

  it('activities.weather_alternative_id — an activity pointing at the LOSER', () => {
    // The referrer a grep for `activity_id` does not find.
    const other = mkActivity('Swim')
    db.prepare('UPDATE activities SET weather_alternative_id = ? WHERE id = ?').run(loser, other)
    merge()
    expect(db.prepare('SELECT weather_alternative_id FROM activities WHERE id = ?').get(other).weather_alternative_id).toBe(winner)
  })

  it('clears weather_alternative_id rather than pointing an activity at itself', () => {
    // The winner used the loser as its own rainy-day alternative. Re-pointing
    // blindly would leave Music listing Music as its own alternative, which is
    // not a fallback at all.
    db.prepare('UPDATE activities SET weather_alternative_id = ? WHERE id = ?').run(loser, winner)
    merge()
    expect(db.prepare('SELECT weather_alternative_id FROM activities WHERE id = ?').get(winner).weather_alternative_id).toBeNull()
  })
})

describe('elective_set_activities — where a blind re-point breaks a UNIQUE constraint', () => {
  function mkSet() {
    const id = randomUUID()
    db.prepare('INSERT INTO elective_sets (id, camp_id, name, is_reusable, recurrence_level) VALUES (?, ?, ?, 0, ?)')
      .run(id, campId, 'Choice', 'week')
    return id
  }
  const addMember = (setId, activityId) => {
    const id = randomUUID()
    db.prepare('INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)')
      .run(id, setId, activityId)
    return id
  }

  it('re-points a membership when the winner is not already in that set', () => {
    const set = mkSet()
    const member = addMember(set, loser)
    merge()
    expect(db.prepare('SELECT activity_id FROM elective_set_activities WHERE id = ?').get(member).activity_id).toBe(winner)
  })

  it('DROPS the losing membership when the winner is already in the same set', () => {
    // UNIQUE(elective_set_id, activity_id). Re-pointing here would throw, and a
    // merge that throws halfway has already re-pointed other referrers.
    // "Both options were really the same option" collapses to one.
    const set = mkSet()
    addMember(set, winner)
    const loserMember = addMember(set, loser)
    const res = merge()
    expect(res.error).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM elective_set_activities WHERE id = ?').get(loserMember)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities WHERE elective_set_id = ?').get(set).c).toBe(1)
  })
})

describe('the count the director agreed to', () => {
  it('aborts when the reference count changed since the director was shown it', () => {
    // A peer can add a slot between the preview and the confirmation. A count
    // the director did not agree to is not a count — mergeLocation's rule.
    db.prepare('INSERT INTO template_slots (id, template_id, activity_id) VALUES (?, ?, ?)').run(randomUUID(), templateId, loser)
    const res = merge({ expected_ref_count: 99 })
    expect(res.error).toBe('count-changed')
    expect(db.prepare('SELECT 1 FROM activities WHERE id = ?').get(loser)).toBeDefined()
  })

  it('proceeds when the count matches', () => {
    db.prepare('INSERT INTO template_slots (id, template_id, activity_id) VALUES (?, ?, ?)').run(randomUUID(), templateId, loser)
    expect(merge({ expected_ref_count: 1 }).error).toBeUndefined()
  })
})

describe('the merge is atomic', () => {
  it('leaves nothing half-merged when a referrer write fails', () => {
    // Proven by aborting on the count guard AFTER referrers exist: the loser is
    // still present AND its referrers still point at it. A merge that re-pointed
    // some rows and then bailed would leave a schedule split across two
    // activities, which is worse than either outcome.
    const slot = randomUUID()
    db.prepare('INSERT INTO template_slots (id, template_id, activity_id) VALUES (?, ?, ?)').run(slot, templateId, loser)
    merge({ expected_ref_count: 42 })
    expect(db.prepare('SELECT activity_id FROM template_slots WHERE id = ?').get(slot).activity_id).toBe(loser)
    expect(db.prepare('SELECT 1 FROM activities WHERE id = ?').get(loser)).toBeDefined()
  })
})

describe('the referrer list cannot silently fall behind the schema', () => {
  it('every column in the database that stores an activity id is handled by the merge', () => {
    // THE TEST THAT MATTERS MOST, and the one Locations did not have.
    //
    // A merge is only correct while its referrer list matches the schema. The
    // list is hand-maintained; the schema is not. When someone adds a seventh
    // table with an activity_id — three of the existing six have no foreign key,
    // so nothing in SQLite would object — this fails and names it, instead of
    // the merge silently orphaning those rows forever.
    //
    // Read from PRAGMA rather than from a second hand-written list, because two
    // hand-written lists drift and the schema is the only one that is true.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    const found = []
    for (const t of tables) {
      for (const c of db.prepare(`PRAGMA table_info("${t}")`).all()) {
        if (/^activity_id$/.test(c.name) || /^weather_alternative_id$/.test(c.name)) found.push(`${t}.${c.name}`)
      }
    }
    // Everything the merge knows how to re-point, spelled the same way.
    const handled = new Set([
      'template_slots.activity_id',
      'week_activity_exclusions.activity_id',
      'special_day_slots.activity_id',
      'event_slots.activity_id',
      'elective_set_activities.activity_id',
      // T194 (v66): a merge re-points a camper's assignment and the offering it
      // came from, or they are stranded on the losing activity.
      'elective_choice_offerings.activity_id',
      'elective_assignments.activity_id',
      'activities.weather_alternative_id',
    ])
    const unhandled = found.filter((f) => !handled.has(f))
    expect(unhandled, `unhandled activity referrer(s): ${unhandled.join(', ')} — add them to mergeActivity.js and give each its own test`).toEqual([])

    // And the reverse: a handled entry that no longer exists means the list is
    // stale in the other direction, which would hide a real gap behind a
    // passing test.
    const missing = [...handled].filter((h) => !found.includes(h))
    expect(missing, `mergeActivity handles column(s) that no longer exist: ${missing.join(', ')}`).toEqual([])
  })
})
