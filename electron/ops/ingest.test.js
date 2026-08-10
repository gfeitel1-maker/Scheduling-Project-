import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest, commitPlan, replaceScope, INGESTIBLE_ENTITIES, listImportEvidence } from './ingest.js'
import { INGESTIBLE_ENTITIES as RENDERER_WHITELIST } from '../../src/ingest/extractEntities.js'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §2, §4.
//
// The two guarantees this file exists for: only setup entities can be created,
// and an import either lands completely or not at all.

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ingest-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  // operations.device_id and .author_user_id are real foreign keys — an op
  // cannot be written by a device or a person the camp has never seen.
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c

describe('the whitelist (ADR §2)', () => {
  it('matches the renderer\'s list exactly', () => {
    // Two lists that can drift are one list too many: the preview would offer
    // something the writer refuses, or worse, the other way round.
    expect([...INGESTIBLE_ENTITIES].sort()).toEqual([...RENDERER_WHITELIST].sort())
  })

  it('refuses to create placements, loudly rather than silently', () => {
    // The placements are right there in every parsed grid. A silent skip would
    // hide a caller that has misunderstood the scope.
    expect(() => commitIngest(db, {
      approved: { activities: ['Swim'], template_slots: [{ id: 's1' }] },
      camp_id: campId, device_id: deviceId,
    })).toThrow(/template_slots cannot be created by an import/)
  })

  it('writes no template_slots row even when asked', () => {
    try {
      commitIngest(db, { approved: { template_slots: ['x'] }, camp_id: campId, device_id: deviceId })
    } catch { /* expected */ }
    expect(count('template_slots')).toBe(0)
  })

  it('refuses anchor_activities, which look like setup but are not', () => {
    expect(() => commitIngest(db, {
      approved: { anchor_activities: ['Flagpole'] }, camp_id: campId, device_id: deviceId,
    })).toThrow(/cannot be created by an import/)
  })
})

describe('creating the approved records', () => {
  it('creates what the director confirmed, and nothing else', () => {
    const result = commitIngest(db, {
      approved: {
        groups: ['Bunk 1', 'Bunk 2'],
        activities: ['Swim', 'Archery', 'Drama'],
        days_of_operation: ['Monday', 'Tuesday'],
      },
      camp_id: campId, device_id: deviceId,
    })

    expect(result.total).toBe(7)
    expect(count('groups')).toBe(2)
    expect(count('activities')).toBe(3)
    expect(count('days_of_operation')).toBe(2)
    expect(count('time_blocks')).toBe(0)
  })

  it('derives the day of the week rather than asking the director for it', () => {
    commitIngest(db, { approved: { days_of_operation: ['Wednesday'] }, camp_id: campId, device_id: deviceId })
    const row = db.prepare('SELECT label, day_of_week FROM days_of_operation').get()
    expect(row.label).toBe('Wednesday')
    expect(row.day_of_week).toBe(3)
  })

  it('parses a period label into a start and end time', () => {
    commitIngest(db, { approved: { time_blocks: ['08:40–09:00'] }, camp_id: campId, device_id: deviceId })
    const row = db.prepare('SELECT name, start_time, end_time FROM time_blocks').get()
    expect(row.start_time).toBe('08:40')
    expect(row.end_time).toBe('09:00')
  })

  it('keeps a period whose label is not a time range, without inventing times', () => {
    commitIngest(db, { approved: { time_blocks: ['Block 2'] }, camp_id: campId, device_id: deviceId })
    const row = db.prepare('SELECT name, start_time, end_time FROM time_blocks').get()
    expect(row.name).toBe('Block 2')
    expect(row.start_time).toBeNull()
  })

  it('records every creation in the op log, so the import is inspectable', () => {
    commitIngest(db, { approved: { activities: ['Swim'] }, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
    const ops = db.prepare("SELECT * FROM operations WHERE entity = 'activities'").all()
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.every((o) => o.author_user_id === 'u1')).toBe(true)
  })

  it('ignores blank names rather than creating empty records', () => {
    const result = commitIngest(db, {
      approved: { activities: ['Swim', '', '   ', null] }, camp_id: campId, device_id: deviceId,
    })
    expect(result.total).toBe(1)
    expect(count('activities')).toBe(1)
  })
})

describe('all or nothing (ADR §4)', () => {
  it('leaves the camp untouched when a write fails partway through', () => {
    // T16: "a partial ingest that half-populates a camp is worse than one that
    // fails cleanly."
    //
    // S1a note: a pre-existing same-name row is no longer the way to force this
    // — it is now RECOGNIZED (unchanged) or surfaced as a held conflict, never a
    // UNIQUE crash (that was the R4 defect S1a fixes; see ingestRecognition.test
    // .js). So the failure injected here is a genuine mid-write error: the second
    // activity's op-write throws after the groups and the first activity have
    // already been appended. Atomicity must still unwind all of it.
    const realPrepare = db.prepare.bind(db)
    // Groups are created before activities (INGESTIBLE_ENTITIES order), so
    // throwing on the first activity projection write injects the failure AFTER
    // the groups' ops are already appended — a genuine partway failure.
    db.prepare = (sql) => {
      if (/INSERT OR IGNORE INTO activities/i.test(sql)) throw new Error('boom: create half failed')
      return realPrepare(sql)
    }
    try {
      expect(() => commitIngest(db, {
        approved: { groups: ['Bunk 1', 'Bunk 2'], activities: ['Swim', 'Archery', 'Drama'] },
        camp_id: campId, device_id: deviceId,
      })).toThrow(/boom/)
    } finally {
      db.prepare = realPrepare
    }

    // Nothing at all — not the groups, not the activity that would have
    // succeeded, not the ops.
    expect(count('groups')).toBe(0)
    expect(count('activities')).toBe(0)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity IN ('groups','activities')").get().c).toBe(0)
  })

  it('refuses to run without a camp', () => {
    expect(() => commitIngest(db, { approved: { activities: ['Swim'] }, device_id: deviceId })).toThrow(/camp_id/)
  })

  it('refuses to run with nothing to commit', () => {
    expect(() => commitIngest(db, { approved: null, camp_id: campId, device_id: deviceId })).toThrow(/nothing to commit/)
  })
})

describe('filing a bunk under its unit', () => {
  it('creates the unit and files the bunk under it, in one transaction', () => {
    commitIngest(db, {
      approved: { tiers: ["Adom 4's"], groups: ['Matzo Balls'] },
      links: { groups: { 'Matzo Balls': "Adom 4's" } },
      camp_id: campId, device_id: deviceId,
    })
    const row = db.prepare('SELECT g.name AS g, t.name AS t FROM groups g JOIN tiers t ON t.id = g.tier_id').get()
    expect(row).toEqual({ g: 'Matzo Balls', t: "Adom 4's" })
  })

  it('reuses a unit the camp already has instead of duplicating it', () => {
    // A second import must not leave the director merging two "Lavan"s.
    db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run('t-existing', campId, 'Lavan')
    commitIngest(db, {
      approved: { groups: ['Chamsas'] },
      links: { groups: { Chamsas: 'lavan' } },
      camp_id: campId, device_id: deviceId,
    })
    expect(count('tiers')).toBe(1)
    expect(db.prepare('SELECT tier_id FROM groups').get().tier_id).toBe('t-existing')
  })

  it('leaves a bunk unfiled when the file named no unit for it', () => {
    commitIngest(db, {
      approved: { groups: ['Zahav'] }, links: { groups: {} },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT tier_id FROM groups').get().tier_id).toBeNull()
  })

  it('does not pull in a unit for a bunk the director unticked', () => {
    // The link map is keyed by group name, so a group that is not being
    // created cannot drag its unit in behind it.
    commitIngest(db, {
      approved: { groups: [] }, links: { groups: { Chamsas: 'Lavan' } },
      camp_id: campId, device_id: deviceId,
    })
    expect(count('tiers')).toBe(0)
    expect(count('groups')).toBe(0)
  })
})

// T33 — an import must file the Program-scoped entities under the active
// Program, or the Units/Time Blocks screens (which filter by cohort_id) never
// show them and a unit the director cannot see cannot appear tied to its
// groups. docs/work/tickets/T33-ingest-creates-cohort-orphaned-entities.md.
describe('filing imported units and time blocks under the active Program', () => {
  const coMain = 'co-main'
  const coOther = 'co-other'
  beforeEach(() => {
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(coMain, campId, 'Main')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(coOther, campId, 'Session 2')
  })

  it('files created units under the given Program', () => {
    commitIngest(db, {
      approved: { tiers: ['Yeladim'] }, links: { groups: {} },
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    expect(db.prepare('SELECT cohort_id FROM tiers').get().cohort_id).toBe(coMain)
  })

  it('files created time blocks under the given Program', () => {
    commitIngest(db, {
      approved: { time_blocks: ['9:00-9:40'] }, links: { groups: {} },
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    expect(db.prepare('SELECT cohort_id FROM time_blocks').get().cohort_id).toBe(coMain)
  })

  it('still creates camp-scoped groups (the groups table carries no Program of its own)', () => {
    // Groups are camp-scoped in this app — the table has no cohort_id column and
    // the Groups screen lists by camp_id — so passing a Program does not change
    // group creation; it only files tiers/time_blocks.
    commitIngest(db, {
      approved: { groups: ['Matzo Balls'] }, links: { groups: {} },
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    expect(count('groups')).toBe(1)
  })

  it('files the bunk under a unit created in the same Program', () => {
    commitIngest(db, {
      approved: { tiers: ["Adom 4's"], groups: ['Matzo Balls'] },
      links: { groups: { 'Matzo Balls': "Adom 4's" } },
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    const row = db.prepare('SELECT t.cohort_id AS c FROM groups g JOIN tiers t ON t.id = g.tier_id').get()
    expect(row.c).toBe(coMain)
  })

  it('does not reuse a same-named unit from a different Program — creates a fresh one here', () => {
    // A "Rimon" in Session 2 is a different unit than a "Rimon" in Main; reusing
    // it across Programs would file this import's bunks under one the director
    // cannot see in the Program they imported into.
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run('t-other', campId, 'Rimon', coOther)
    commitIngest(db, {
      approved: { tiers: ['Rimon'], groups: ['Chamsas'] }, links: { groups: { Chamsas: 'Rimon' } },
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    // A fresh Rimon is created in Main rather than the Session-2 one reused.
    expect(count('tiers')).toBe(2)
    const tierId = db.prepare('SELECT tier_id FROM groups').get().tier_id
    expect(tierId).not.toBe('t-other')
    expect(db.prepare('SELECT cohort_id FROM tiers WHERE id = ?').get(tierId).cohort_id).toBe(coMain)
  })

  it('reuses a same-named unit that is already in this Program', () => {
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run('t-main', campId, 'Lavan', coMain)
    commitIngest(db, {
      approved: { groups: ['Chamsas'] }, links: { groups: { Chamsas: 'lavan' } },
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    expect(count('tiers')).toBe(1)
    expect(db.prepare('SELECT tier_id FROM groups').get().tier_id).toBe('t-main')
  })

  it('without a Program (older callers) still writes null-cohort rows, unchanged', () => {
    commitIngest(db, {
      approved: { tiers: ['Yeladim'], time_blocks: ['9:00-9:40'] }, links: { groups: {} },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT cohort_id FROM tiers').get().cohort_id).toBeNull()
    expect(db.prepare('SELECT cohort_id FROM time_blocks').get().cohort_id).toBeNull()
  })
})

// T34 — ingest may propose recurring fixed events, which land as
// anchor_activities through a dedicated, validated commit branch (never the
// generic whitelist). docs/adr/2026-08-03-ingesting-recurring-fixed-events.md.
describe('fixed events land as anchor_activities (T34)', () => {
  const coMain = 'co-fx'
  beforeEach(() => {
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(coMain, campId, 'Main')
  })

  it('writes one cohort-scoped anchor per day, referencing the real rows it created', () => {
    const result = commitIngest(db, {
      approved: {
        groups: ['A', 'B'],
        days_of_operation: ['Monday', 'Tuesday'],
        time_blocks: ['09:00-09:30'],
      },
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday', 'Tuesday'],
        scope: { is_all_groups: true, groups: null },
      }],
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })

    // Per-day fan-out: two days -> two rows.
    expect(result.fixedEvents).toEqual({ created: 2, unchanged: 0, skipped: [], partial: [], rejected: [] })
    expect(count('anchor_activities')).toBe(2)

    const tbId = db.prepare('SELECT id FROM time_blocks').get().id
    const dayIds = db.prepare('SELECT id FROM days_of_operation').all().map((r) => r.id)
    const rows = db.prepare('SELECT * FROM anchor_activities').all()
    for (const r of rows) {
      expect(r.cohort_id).toBe(coMain)
      expect(r.camp_id).toBe(campId)
      expect(r.name).toBe('Mifkad')
      expect(r.time_block_id).toBe(tbId)   // a real, created time_block id
      expect(dayIds).toContain(r.day_id)   // a real, created day id
      expect(r.is_all_groups).toBe(1)
      expect(JSON.parse(r.group_ids)).toEqual([])
    }
    expect(new Set(rows.map((r) => r.day_id)).size).toBe(2)  // one per day
  })

  it('resolves a group-scoped event to the real group ids, serialized as AnchorsScreen does', () => {
    commitIngest(db, {
      approved: { groups: ['A', 'B', 'C'], days_of_operation: ['Monday'], time_blocks: ['12:00-12:30'] },
      fixedEvents: [{
        name: 'Lunch 1', time_block: '12:00-12:30', days: ['Monday'],
        scope: { is_all_groups: false, groups: ['A', 'B'] },
      }],
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    const row = db.prepare('SELECT is_all_groups, group_ids FROM anchor_activities').get()
    expect(row.is_all_groups).toBe(0)
    const aId = db.prepare('SELECT id FROM groups WHERE name = ?').get('A').id
    const bId = db.prepare('SELECT id FROM groups WHERE name = ?').get('B').id
    const cId = db.prepare('SELECT id FROM groups WHERE name = ?').get('C').id
    const ids = JSON.parse(row.group_ids)
    expect([...ids].sort()).toEqual([aId, bId].sort())
    expect(ids).not.toContain(cId)  // C was excluded
  })

  it('resolves against a block already in the camp (a skipped duplicate), not only freshly created ones', () => {
    // The block exists from a prior import; this run creates nothing new, yet the
    // fixed event still resolves to the existing row (seed-from-scope, §5.2).
    commitIngest(db, {
      approved: { groups: ['A'], days_of_operation: ['Monday'], time_blocks: ['09:00-09:30'] },
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    const result = commitIngest(db, {
      approved: {},
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'],
        scope: { is_all_groups: false, groups: ['A'] },
      }],
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    expect(result.fixedEvents.created).toBe(1)
    expect(count('anchor_activities')).toBe(1)
  })

  it('skips and reports an unresolvable event, without aborting the rest of the import', () => {
    const result = commitIngest(db, {
      approved: { groups: ['A'], days_of_operation: ['Monday'] },  // note: no time_blocks
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'],
        scope: { is_all_groups: true, groups: null },
      }],
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    expect(result.fixedEvents.created).toBe(0)
    expect(result.fixedEvents.skipped).toHaveLength(1)
    expect(result.fixedEvents.skipped[0].name).toBe('Mifkad')
    expect(count('anchor_activities')).toBe(0)
    // The rest of the import still committed.
    expect(count('groups')).toBe(1)
    expect(count('days_of_operation')).toBe(1)
  })

  it('writes the resolved subset but REPORTS the shortfall when only some days/groups were imported', () => {
    // The director ticked a Mon–Wed all-group event but imported only Mon+Tue
    // (Wednesday unticked) and only groups A,B (C unticked). Writing the subset
    // is correct — an un-imported day/group has no anchor — but the result must
    // say so, or it silently claims more than it created (ADR §1; Red Hat r1).
    const result = commitIngest(db, {
      approved: { groups: ['A', 'B'], days_of_operation: ['Monday', 'Tuesday'], time_blocks: ['09:00-09:30'] },
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday', 'Tuesday', 'Wednesday'],
        scope: { is_all_groups: false, groups: ['A', 'B', 'C'] },
      }],
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    // Two days resolved -> two anchor rows (not three); C excluded from group_ids.
    expect(result.fixedEvents.created).toBe(2)
    expect(count('anchor_activities')).toBe(2)
    expect(result.fixedEvents.skipped).toHaveLength(0)
    // The shortfall is surfaced, not silent.
    expect(result.fixedEvents.partial).toHaveLength(1)
    expect(result.fixedEvents.partial[0].name).toBe('Mifkad')
    expect(result.fixedEvents.partial[0].reason).toMatch(/1 of 3 days/)
    expect(result.fixedEvents.partial[0].reason).toMatch(/1 of 3 groups/)
  })

  it('writes zero template_slots even when it creates a fixed event', () => {
    commitIngest(db, {
      approved: { groups: ['A'], days_of_operation: ['Monday'], time_blocks: ['09:00-09:30'] },
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'],
        scope: { is_all_groups: false, groups: ['A'] },
      }],
      camp_id: campId, cohort_id: coMain, device_id: deviceId,
    })
    expect(count('anchor_activities')).toBe(1)
    expect(count('template_slots')).toBe(0)  // the standing boundary holds
  })

  it('rolls back both entities and anchors when a fixed-event write fails partway', () => {
    // Atomicity (ADR §4): the fixed-events branch runs in the same transaction,
    // so a throw while writing an anchor unwinds the entities too. The failure
    // is injected at the anchor write only.
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (/anchor_activities/i.test(sql)) throw new Error('boom: anchor write failed')
      return realPrepare(sql)
    }
    try {
      expect(() => commitIngest(db, {
        approved: { groups: ['A'], days_of_operation: ['Monday'], time_blocks: ['09:00-09:30'] },
        fixedEvents: [{
          name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'],
          scope: { is_all_groups: false, groups: ['A'] },
        }],
        camp_id: campId, cohort_id: coMain, device_id: deviceId,
      })).toThrow(/boom/)
    } finally {
      db.prepare = realPrepare
    }
    expect(count('groups')).toBe(0)
    expect(count('days_of_operation')).toBe(0)
    expect(count('time_blocks')).toBe(0)
    expect(count('anchor_activities')).toBe(0)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity IN ('groups','anchor_activities')").get().c).toBe(0)
  })
})

describe('activity rules resolved at commit (T35)', () => {
  it('writes min/max/priority and resolves eligible_group_ids from names to ids', () => {
    commitIngest(db, {
      approved: { groups: ['Yeladim', 'Bogrim'], activities: ['Swim'] },
      activityRules: {
        Swim: { eligible_group_names: ['Yeladim', 'Bogrim'], min_per_week: 2, max_per_week: 3, priority: 'high' },
      },
      camp_id: campId, device_id: deviceId,
    })
    const row = db.prepare('SELECT * FROM activities WHERE name = ?').get('Swim')
    expect(row.min_per_week).toBe(2)
    expect(row.max_per_week).toBe(3)
    expect(row.priority).toBe('high')
    const groupIds = db.prepare('SELECT id, name FROM groups').all()
    const ids = JSON.parse(row.eligible_group_ids).sort()
    expect(ids).toEqual(groupIds.map((g) => g.id).sort())
  })

  it('drops a group name the director unticked, keeping the ones that resolve', () => {
    commitIngest(db, {
      approved: { groups: ['Yeladim'], activities: ['Swim'] }, // Bogrim not approved
      activityRules: {
        Swim: { eligible_group_names: ['Yeladim', 'Bogrim'], min_per_week: 1, max_per_week: 2, priority: 'low' },
      },
      camp_id: campId, device_id: deviceId,
    })
    const row = db.prepare('SELECT * FROM activities WHERE name = ?').get('Swim')
    const yeladim = db.prepare("SELECT id FROM groups WHERE name = 'Yeladim'").get()
    expect(JSON.parse(row.eligible_group_ids)).toEqual([yeladim.id])
  })

  it('writes no eligible_group_ids (never "[]") when every name fails to resolve', () => {
    commitIngest(db, {
      approved: { activities: ['Swim'] }, // no groups approved at all
      activityRules: {
        Swim: { eligible_group_names: ['Yeladim', 'Bogrim'], min_per_week: 1, max_per_week: 2, priority: 'low' },
      },
      camp_id: campId, device_id: deviceId,
    })
    const row = db.prepare('SELECT * FROM activities WHERE name = ?').get('Swim')
    expect(row.eligible_group_ids).toBeNull()
  })

  it('writes no rule fields for an activity absent from activityRules', () => {
    commitIngest(db, {
      approved: { activities: ['Drama'] },
      activityRules: { Swim: { eligible_group_names: null, min_per_week: 1, max_per_week: 2, priority: 'high' } },
      camp_id: campId, device_id: deviceId,
    })
    const row = db.prepare('SELECT * FROM activities WHERE name = ?').get('Drama')
    expect(row.min_per_week).toBeNull()
    expect(row.max_per_week).toBeNull()
    expect(row.priority).toBeNull()
    expect(row.eligible_group_ids).toBeNull()
  })

  it('behaves exactly as before when no activityRules is passed at all', () => {
    const result = commitIngest(db, {
      approved: { activities: ['Swim'] }, camp_id: campId, device_id: deviceId,
    })
    expect(result.total).toBe(1)
    const row = db.prepare('SELECT * FROM activities WHERE name = ?').get('Swim')
    expect(row.min_per_week).toBeNull()
    expect(row.eligible_group_ids).toBeNull()
  })

  // Round 2 review, Fix 4 — the op log is the boundary that owns validation;
  // it must never trust a caller's priority/min/max blindly. This test
  // previously asserted `priority: 2` WAS written, which enshrined the bug
  // (buildSchedule.js's runRound never matches anything but 'high'/'low', so
  // that activity would have been silently unplaceable forever).
  it('writes priority only when it is exactly "high" or "low", ignoring anything else', () => {
    commitIngest(db, {
      approved: { activities: ['Swim', 'Drama', 'Archery'] },
      activityRules: {
        Swim: { eligible_group_names: null, min_per_week: 1, max_per_week: 2, priority: 2 },
        Drama: { eligible_group_names: null, min_per_week: 1, max_per_week: 2, priority: 'medium' },
        Archery: { eligible_group_names: null, min_per_week: 1, max_per_week: 2, priority: 'low' },
      },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT priority FROM activities WHERE name = ?').get('Swim').priority).toBeNull()
    expect(db.prepare('SELECT priority FROM activities WHERE name = ?').get('Drama').priority).toBeNull()
    expect(db.prepare('SELECT priority FROM activities WHERE name = ?').get('Archery').priority).toBe('low')
  })

  it('writes min/max only when they are positive integers, ignoring negative/zero/non-integer values', () => {
    commitIngest(db, {
      approved: { activities: ['Swim', 'Drama', 'Archery', 'Ceramics'] },
      activityRules: {
        Swim: { eligible_group_names: null, min_per_week: -1, max_per_week: 2, priority: 'high' },
        Drama: { eligible_group_names: null, min_per_week: 0, max_per_week: 2, priority: 'high' },
        Archery: { eligible_group_names: null, min_per_week: 1.5, max_per_week: 2, priority: 'high' },
        Ceramics: { eligible_group_names: null, min_per_week: 2, max_per_week: 3, priority: 'high' },
      },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Swim').min_per_week).toBeNull()
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Drama').min_per_week).toBeNull()
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Archery').min_per_week).toBeNull()
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Ceramics').min_per_week).toBe(2)
  })
})

// T61 — Replace-mode ingest runs in one main-process transaction.
// docs/work/specs/S-replace-ingest-atomic-transaction.md
//
// Two things are on trial here: that a Replace clears the camp's REPLACEABLE
// entities AND every dependent row that points at them, and that a failure
// anywhere after the first delete leaves the camp byte-for-byte as it was.

// Tables whose row counts must be identical before and after a failed Replace.
// Deliberately a literal list rather than sqlite_master: a table added later
// without being considered here should make someone read this test.
const ALL_TABLES = [
  'operations', 'groups', 'tiers', 'activities', 'cohorts', 'days_of_operation',
  'time_blocks', 'anchor_activities', 'schedule_templates', 'schedule_weeks',
  'day_override_templates', 'template_slots', 'template_overlays',
  'schedule_snapshots', 'day_override_template_slots',
  'week_activity_exclusions', 'week_group_exclusions',
]
const snapshotCounts = () => Object.fromEntries(ALL_TABLES.map((t) => [t, count(t)]))

// A camp with a real schedule hanging off it: rows in all six dependent
// tables the teardown has to clear, plus a snapshot (which survives) and a
// day-override template (whose slots go but whose shell survives).
function seedCampWithSchedule() {
  const id = (p) => `${p}-${randomUUID()}`
  const cohortId = 'co-seed'
  db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortId, campId, 'Main')

  const tierId = id('tier')
  db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(tierId, campId, 'Lavan', cohortId)
  const groupId = id('grp')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bunk 1', tierId)
  const dayId = id('day')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, ?, ?)').run(dayId, campId, 'Monday', 1)
  const blockId = id('tb')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(blockId, campId, 'Period 1', cohortId)
  const activityId = id('act')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, 'Swim')

  const weekId = id('week')
  db.prepare('INSERT INTO schedule_weeks (id, camp_id, name) VALUES (?, ?, ?)').run(weekId, campId, 'Week 1')
  const templateId = id('tpl')
  db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
    .run(templateId, campId, 'Generated', 'generated', weekId)

  db.prepare('INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('slot'), templateId, groupId, activityId, dayId, blockId)
  db.prepare('INSERT INTO template_overlays (id, template_id, day_id, label) VALUES (?, ?, ?, ?)')
    .run(id('ovl'), templateId, dayId, 'Rain')
  db.prepare('INSERT INTO week_activity_exclusions (id, week_id, activity_id) VALUES (?, ?, ?)')
    .run(id('wax'), weekId, activityId)
  db.prepare('INSERT INTO week_group_exclusions (id, week_id, group_id) VALUES (?, ?, ?)')
    .run(id('wgx'), weekId, groupId)

  const overrideId = id('dot')
  db.prepare('INSERT INTO day_override_templates (id, camp_id, cohort_id, name) VALUES (?, ?, ?, ?)')
    .run(overrideId, campId, cohortId, 'Rainy Day')
  db.prepare('INSERT INTO day_override_template_slots (id, day_override_template_id, time_block_id, activity_id) VALUES (?, ?, ?, ?)')
    .run(id('dots'), overrideId, blockId, activityId)

  db.prepare('INSERT INTO anchor_activities (id, camp_id, cohort_id, day_id, time_block_id, name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('anc'), campId, cohortId, dayId, blockId, 'Mifkad')

  db.prepare('INSERT INTO schedule_snapshots (id, template_id, name, created_at, slots, overlays) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('snap'), templateId, 'Before', new Date().toISOString(), '[]', '[]')

  return { cohortId, tierId, groupId, dayId, blockId, activityId, weekId, templateId, overrideId }
}

describe('replace mode tears the camp down inside the import transaction (T61)', () => {
  it('clears every dependent row and every REPLACEABLE entity, then creates the new set', () => {
    const seeded = seedCampWithSchedule()

    const result = commitIngest(db, {
      mode: 'replace',
      approved: { groups: ['Bunk 1'], activities: ['Swim'], days_of_operation: ['Monday'], time_blocks: ['Period 1'], tiers: ['Lavan'] },
      camp_id: campId, cohort_id: seeded.cohortId, author_user_id: 'u1', device_id: deviceId,
    })

    // Dependents: gone.
    expect(count('template_slots')).toBe(0)
    expect(count('template_overlays')).toBe(0)
    expect(count('week_activity_exclusions')).toBe(0)
    expect(count('week_group_exclusions')).toBe(0)
    expect(count('day_override_template_slots')).toBe(0)
    expect(count('anchor_activities')).toBe(0)

    // Entities: exactly the new set, none of the old ids.
    expect(count('groups')).toBe(1)
    expect(db.prepare('SELECT id FROM groups').get().id).not.toBe(seeded.groupId)
    expect(count('activities')).toBe(1)
    expect(count('days_of_operation')).toBe(1)
    expect(count('time_blocks')).toBe(1)
    expect(count('tiers')).toBe(1)
    // cohorts is never deleted — Programs are not part of the import's scope.
    expect(count('cohorts')).toBe(1)
    // The parents of the cleared dependents survive; only their rows went.
    expect(count('schedule_templates')).toBe(1)
    expect(count('schedule_weeks')).toBe(1)
    expect(count('day_override_templates')).toBe(1)
    expect(count('schedule_snapshots')).toBe(1)

    expect(result.total).toBe(5)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('reports what it destroyed, per entity and per dependent table', () => {
    seedCampWithSchedule()
    const result = commitIngest(db, {
      mode: 'replace', approved: { activities: ['Archery'] },
      camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })
    expect(result.replaced.entities).toEqual({
      activities: 1, groups: 1, time_blocks: 1, days_of_operation: 1, tiers: 1,
    })
    expect(result.replaced.dependents).toEqual({
      template_slots: 1, template_overlays: 1, week_activity_exclusions: 1,
      week_group_exclusions: 1, day_override_template_slots: 1, anchor_activities: 1,
    })
  })

  it('deletes through the op log, so every cleared row is in Trash and replicates', () => {
    seedCampWithSchedule()
    commitIngest(db, {
      mode: 'replace', approved: {}, camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })
    const deletes = db.prepare("SELECT entity FROM operations WHERE field = '__deleted__'").all()
    // 5 entities + 6 dependent rows.
    expect(deletes.length).toBe(11)
    expect(new Set(deletes.map((d) => d.entity))).toContain('day_override_template_slots')
  })

  it('unhooks weather_alternative_id before deleting activities, including a mutual A→B/B→A pair', () => {
    // schema.sql declares this column plain TEXT, but deleteRecord.js treats it
    // as a blocking self-reference and a migrated db may carry the real FK. A
    // mutual pair has no safe deletion order at all unless it is nulled first.
    const a = randomUUID()
    const b = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(a, campId, 'Swim')
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(b, campId, 'Gaga')
    db.prepare('UPDATE activities SET weather_alternative_id = ? WHERE id = ?').run(b, a)
    db.prepare('UPDATE activities SET weather_alternative_id = ? WHERE id = ?').run(a, b)

    commitIngest(db, {
      mode: 'replace', approved: { activities: ['Swim'] },
      camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })

    expect(count('activities')).toBe(1)
    expect(db.prepare('SELECT weather_alternative_id FROM activities').get().weather_alternative_id).toBeNull()
    // The unhook is an ordinary op, not a raw UPDATE — peers must replay it.
    const nulls = db.prepare("SELECT COUNT(*) c FROM operations WHERE field = 'weather_alternative_id' AND value IS NULL").get().c
    expect(nulls).toBe(2)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('is a plain create on an empty camp — the teardown finds nothing and reports zeroes', () => {
    const result = commitIngest(db, {
      mode: 'replace', approved: { activities: ['Swim', 'Drama'] },
      camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })
    expect(result.total).toBe(2)
    expect(count('activities')).toBe(2)
    expect(result.replaced.entities.activities).toBe(0)
    expect(result.replaced.dependents.template_slots).toBe(0)
  })

  it('creates records with the same names the camp already had — the deletes precede the creates', () => {
    // UNIQUE(camp_id, name) is only satisfied because both halves are in one
    // transaction, in this order. A second transaction would collide.
    seedCampWithSchedule()
    commitIngest(db, {
      mode: 'replace', approved: { groups: ['Bunk 1'], activities: ['Swim'] },
      camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })
    expect(count('groups')).toBe(1)
    expect(db.prepare('SELECT name FROM groups').get().name).toBe('Bunk 1')
  })

  it('does not reuse an id from the set it is about to destroy when filing a bunk under its unit', () => {
    // The name->id maps are seeded AFTER the teardown; seeding them before it
    // would file a new bunk under a tier that no longer exists.
    const seeded = seedCampWithSchedule()
    commitIngest(db, {
      mode: 'replace', approved: { tiers: ['Lavan'], groups: ['Bunk 1'] },
      links: { groups: { 'Bunk 1': 'Lavan' } },
      camp_id: campId, cohort_id: seeded.cohortId, author_user_id: 'u1', device_id: deviceId,
    })
    const row = db.prepare('SELECT tier_id FROM groups').get()
    expect(row.tier_id).not.toBe(seeded.tierId)
    expect(count('tiers')).toBe(1)
    expect(db.prepare('SELECT id FROM tiers').get().id).toBe(row.tier_id)
  })

  it('leaves EVERY table exactly as it was when the create half throws after the deletes', () => {
    // The whole point of T61. The failure is injected in the create half, i.e.
    // after hundreds of delete ops have already been appended.
    seedCampWithSchedule()
    const before = snapshotCounts()

    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (/INSERT OR IGNORE INTO groups/i.test(sql)) throw new Error('boom: create half failed')
      return realPrepare(sql)
    }
    try {
      expect(() => commitIngest(db, {
        mode: 'replace', approved: { groups: ['Bunk 9'], activities: ['Swim'] },
        camp_id: campId, author_user_id: 'u1', device_id: deviceId,
      })).toThrow(/boom/)
    } finally {
      db.prepare = realPrepare
    }

    expect(snapshotCounts()).toEqual(before)
  })

  it('leaves EVERY table exactly as it was when a delete partway through the teardown throws', () => {
    seedCampWithSchedule()
    const before = snapshotCounts()

    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (/DELETE FROM anchor_activities/i.test(sql)) throw new Error('boom: teardown failed')
      return realPrepare(sql)
    }
    try {
      expect(() => commitIngest(db, {
        mode: 'replace', approved: { activities: ['Swim'] },
        camp_id: campId, author_user_id: 'u1', device_id: deviceId,
      })).toThrow(/boom/)
    } finally {
      db.prepare = realPrepare
    }

    expect(snapshotCounts()).toEqual(before)
  })

  it('aborts rather than committing a torn camp when a foreign key survives the teardown', () => {
    // replaceScope's own backstop: if a future dependent table is added and
    // not cleared here, the FK check inside the transaction must stop the
    // import rather than let it commit.
    seedCampWithSchedule()
    const before = snapshotCounts()
    const realPragma = db.pragma.bind(db)
    db.pragma = (sql, opts) => {
      if (/foreign_key_check/i.test(sql)) return [{ table: 'template_slots', rowid: 1, parent: 'groups', fkid: 0 }]
      return realPragma(sql, opts)
    }
    try {
      expect(() => commitIngest(db, {
        mode: 'replace', approved: { activities: ['Swim'] },
        camp_id: campId, author_user_id: 'u1', device_id: deviceId,
      })).toThrow(/foreign key/i)
    } finally {
      db.pragma = realPragma
    }
    expect(snapshotCounts()).toEqual(before)
  })

  it('never touches a thing in add mode, however much schedule data the camp holds', () => {
    // The Add-mode regression guard: `mode` omitted must be byte-identical to
    // the behaviour before T61.
    const seeded = seedCampWithSchedule()
    const result = commitIngest(db, {
      approved: { activities: ['Archery'] },
      camp_id: campId, cohort_id: seeded.cohortId, author_user_id: 'u1', device_id: deviceId,
    })
    expect(result.replaced).toBeUndefined()
    expect(count('activities')).toBe(2)
    expect(count('template_slots')).toBe(1)
    expect(count('anchor_activities')).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE field = '__deleted__'").get().c).toBe(0)
  })

  it('treats any mode that is not the literal "replace" as add', () => {
    seedCampWithSchedule()
    for (const mode of ['add', 'REPLACE', 'Replace', null, undefined, 'nonsense']) {
      const result = commitIngest(db, {
        mode, approved: {}, camp_id: campId, author_user_id: 'u1', device_id: deviceId,
      })
      expect(result.replaced).toBeUndefined()
    }
    expect(count('template_slots')).toBe(1)
  })

  it('replaceScope on its own clears the camp and reports the counts', () => {
    seedCampWithSchedule()
    const replaced = db.transaction(() =>
      replaceScope(db, { camp_id: campId, author_user_id: 'u1', device_id: deviceId })
    )()
    expect(replaced.entities.groups).toBe(1)
    expect(count('groups')).toBe(0)
    expect(count('template_slots')).toBe(0)
  })
})

describe('replace mode on a camp big enough to hurt (T61 perf gate)', () => {
  it('finishes a 400-group camp inside the wall-clock budget', () => {
    // better-sqlite3 transactions are synchronous on the main-process thread,
    // which also serves the sync server's message loop — a Replace that takes
    // minutes stalls every connected staff device.
    //
    // MEASURED, not guessed, 2026-08-07. The cost was ~15ms of blocked main
    // thread per row, essentially all of it inside appendOp (~4 db.prepare()
    // calls per op at ~1.3ms each). That was a pre-existing property of the
    // op-log write path, shared with deleteRecord.js — replaceScope adds no
    // per-row work of its own beyond one enumerating SELECT per table.
    //
    // FIXED by T66 (electron/ops/stmtCache.js): appendOp and applyProjection
    // now prepare each statement once per db handle per process instead of
    // once per op, so this budget is tightened from the original 15000ms to
    // reflect the new floor — see the T66 gate below for the full-schedule
    // (~2400-op) scale test this repo couldn't run before the fix without
    // exceeding its 20s testTimeout under full-suite contention.
    //
    // Scale note: a 400-group camp with a FULL five-day schedule (2000 slots)
    // measured ~37s pre-fix. This gate deliberately keeps the 400 groups and
    // uses one day of slots so it still exercises the same per-row path and
    // still catches an order-of-magnitude regression, without needing the
    // 20s+ testTimeout the full-schedule scale requires — see the T66 gate
    // below for that scale.
    const weekId = randomUUID()
    const templateId = randomUUID()
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name) VALUES (?, ?, ?)').run(weekId, campId, 'Week 1')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
      .run(templateId, campId, 'Generated', 'generated', weekId)

    const insertGroup = db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)')
    const insertDay = db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, ?, ?)')
    const insertActivity = db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
    const insertSlot = db.prepare('INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)')

    db.transaction(() => {
      const dayIds = []
      for (let d = 0; d < 1; d += 1) {
        const dayId = randomUUID()
        insertDay.run(dayId, campId, `Day ${d}`, d)
        dayIds.push(dayId)
      }
      const activityId = randomUUID()
      insertActivity.run(activityId, campId, 'Swim')
      for (let g = 0; g < 400; g += 1) {
        const groupId = randomUUID()
        insertGroup.run(groupId, campId, `Bunk ${g}`)
        for (const dayId of dayIds) {
          insertSlot.run(randomUUID(), templateId, groupId, activityId, dayId, 'tb-1')
        }
      }
    })()
    expect(count('template_slots')).toBe(400)

    const startedAt = Date.now()
    const result = commitIngest(db, {
      mode: 'replace',
      approved: { groups: Array.from({ length: 400 }, (_, i) => `Bunk ${i}`), activities: ['Swim'] },
      camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })
    const elapsed = Date.now() - startedAt

    expect(result.replaced.dependents.template_slots).toBe(400)
    expect(count('template_slots')).toBe(0)
    expect(count('groups')).toBe(400)
    // Tightened from 15000ms (T66). Clean-machine measurement post-fix is
    // under 1s; observed up to ~6.5s under this sandbox's own full-suite
    // contention (this repo has a documented history of load flakiness —
    // T25/T44). 10000ms keeps meaningful headroom over the worst loaded
    // reading actually observed while still catching a regression back
    // toward the old per-op-prepare cost, which pushed this same scale past
    // 15s even before hitting the discontinued 37s full-schedule scale.
    expect(elapsed).toBeLessThan(10000)
  })

  it('finishes a 400-group camp with a FULL five-day schedule inside a tight wall-clock budget (T66)', () => {
    // T66: the scenario the 400-group/one-day gate above deliberately did NOT
    // cover, because at full 5-day scale (~2400 ops through appendOp) it took
    // 37s pre-fix — and as a TEST, that exceeded this repo's global 20s
    // testTimeout (vite.config.js) before the assertion below could even run,
    // so a regression would have surfaced as an illegible framework timeout
    // rather than a clean "took Nms, budget was Mms" failure. Fixed by giving
    // THIS test its own longer per-test timeout (3rd arg to `it`, below) —
    // the assertion's budget stays well under that timeout, not equal to it,
    // so the assertion is what actually fails on a regression.
    //
    // MEASURED post-fix, clean single run (no contention): ~1.6s. Under this
    // sandbox's own documented load-flakiness (T25/T44 — full-suite
    // contention observed pushing the SAME 2400-op run as high as ~10.2s),
    // 30000ms keeps ~3x headroom over the worst reading actually observed
    // while still catching an order-of-magnitude regression back toward the
    // pre-fix per-op-prepare cost (which was 37s at this exact scale).
    const weekId = randomUUID()
    const templateId = randomUUID()
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name) VALUES (?, ?, ?)').run(weekId, campId, 'Week 1')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
      .run(templateId, campId, 'Generated', 'generated', weekId)

    const insertGroup = db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)')
    const insertDay = db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, ?, ?)')
    const insertActivity = db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
    const insertSlot = db.prepare('INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)')

    db.transaction(() => {
      const dayIds = []
      for (let d = 0; d < 5; d += 1) {
        const dayId = randomUUID()
        insertDay.run(dayId, campId, `Day ${d}`, d)
        dayIds.push(dayId)
      }
      const activityId = randomUUID()
      insertActivity.run(activityId, campId, 'Swim')
      for (let g = 0; g < 400; g += 1) {
        const groupId = randomUUID()
        insertGroup.run(groupId, campId, `Bunk ${g}`)
        for (const dayId of dayIds) {
          insertSlot.run(randomUUID(), templateId, groupId, activityId, dayId, 'tb-1')
        }
      }
    })()
    expect(count('template_slots')).toBe(2000)

    const startedAt = Date.now()
    const result = commitIngest(db, {
      mode: 'replace',
      approved: { groups: Array.from({ length: 400 }, (_, i) => `Bunk ${i}`), activities: ['Swim'] },
      camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })
    const elapsed = Date.now() - startedAt

    expect(result.replaced.dependents.template_slots).toBe(2000)
    expect(count('template_slots')).toBe(0)
    expect(count('groups')).toBe(400)
    console.log(`T66 2400-op scale: ${elapsed}ms`)
    expect(elapsed).toBeLessThan(30000)
  }, 60000)
})

describe('an imported activity that somebody can do runs at least once a week (T61)', () => {
  it('floors min_per_week to 1 when the activity has eligible groups and the rule says 0', () => {
    // min_per_week 0 with eligible groups schedules the activity zero times —
    // correct and silently useless. Observed as every Friday slot UNFILLABLE.
    commitIngest(db, {
      approved: { groups: ['Yeladim'], activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Yeladim'], min_per_week: 0, max_per_week: 2, priority: 'high' } },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Swim').min_per_week).toBe(1)
  })

  it('floors a null min_per_week the same way', () => {
    commitIngest(db, {
      approved: { groups: ['Yeladim'], activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Yeladim'], min_per_week: null, max_per_week: 2, priority: 'high' } },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Swim').min_per_week).toBe(1)
  })

  it('applies in replace mode too', () => {
    commitIngest(db, {
      mode: 'replace',
      approved: { groups: ['Yeladim'], activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Yeladim'], min_per_week: 0, max_per_week: 2, priority: 'low' } },
      camp_id: campId, author_user_id: 'u1', device_id: deviceId,
    })
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Swim').min_per_week).toBe(1)
  })

  it('leaves min_per_week unwritten when no group resolved — nobody can do it, so it needs no floor', () => {
    commitIngest(db, {
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Nobody'], min_per_week: 0, max_per_week: 2, priority: 'high' } },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Swim').min_per_week).toBeNull()
  })

  it('does not lower a min_per_week the director actually set', () => {
    commitIngest(db, {
      approved: { groups: ['Yeladim'], activities: ['Swim'] },
      activityRules: { Swim: { eligible_group_names: ['Yeladim'], min_per_week: 3, max_per_week: 4, priority: 'high' } },
      camp_id: campId, device_id: deviceId,
    })
    expect(db.prepare('SELECT min_per_week FROM activities WHERE name = ?').get('Swim').min_per_week).toBe(3)
  })
})

// B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md). The acceptance
// set: (a) creates write readable evidence, (c) latest-wins upsert on
// re-import, (d) a held commit writes NO evidence (rolled back with everything).
describe('import evidence persistence (B4)', () => {
  const evidenceRows = (entity_type) =>
    db.prepare('SELECT * FROM import_evidence WHERE camp_id = ? AND entity_type = ?').all(campId, entity_type)

  it('(a) writes readable evidence for an inferred activity AND an inferred fixed event', () => {
    commitIngest(db, {
      approved: { groups: ['Yeladim', 'Bogrim'], activities: ['Swim'], days_of_operation: ['Monday'], time_blocks: ['09:00-09:30'] },
      activityRules: {
        Swim: {
          eligible_group_names: ['Yeladim', 'Bogrim'], eligibility_known: true, min_per_week: 2, max_per_week: 3, priority: 'high',
          support: { matched_groups: ['Yeladim', 'Bogrim'], appearances: 8, eligible_group_count: 2 },
        },
      },
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'],
        scope: { is_all_groups: true, groups: null }, confidence: 'high',
        support: { days: ['Monday'], occupied_days: 1, operating_days: 1, groups_in_scope: ['Yeladim', 'Bogrim'] },
      }],
      camp_id: campId, device_id: deviceId,
    })

    const activityId = db.prepare('SELECT id FROM activities WHERE name = ?').get('Swim').id
    const anchorId = db.prepare('SELECT id FROM anchor_activities WHERE name = ?').get('Mifkad').id

    const activityEvidence = listImportEvidence(db, campId, { entity_type: 'activities', entity_id: activityId })
    expect(activityEvidence.map((r) => r.field).sort()).toEqual(['eligible_group_names', 'min_per_week'])
    expect(activityEvidence[0].tag).toBe('inferred')
    expect(activityEvidence[0].confidence).toBe('high')
    expect(activityEvidence.every((r) => r.support.matched_groups)).toBe(true)

    const anchorEvidence = listImportEvidence(db, campId, { entity_type: 'anchor_activities', entity_id: anchorId })
    expect(anchorEvidence.map((r) => r.field).sort()).toEqual(['days', 'scope'])
    expect(anchorEvidence[0].confidence).toBe('high')
    expect(anchorEvidence[0].support.groups_in_scope).toEqual(['Yeladim', 'Bogrim'])
  })

  it('(c) a re-import of a recognized activity upserts its evidence in place — one row per key, support replaced', () => {
    commitIngest(db, {
      approved: { groups: ['Yeladim'], activities: ['Swim'] },
      activityRules: {
        Swim: {
          eligible_group_names: ['Yeladim'], eligibility_known: true, min_per_week: 1, max_per_week: 2, priority: 'high',
          support: { matched_groups: ['Yeladim'], appearances: 4, eligible_group_count: 1 },
        },
      },
      camp_id: campId, device_id: deviceId,
    })
    const activityId = db.prepare('SELECT id FROM activities WHERE name = ?').get('Swim').id
    const first = listImportEvidence(db, campId, { entity_type: 'activities', entity_id: activityId })
    expect(first.map((r) => r.field).sort()).toEqual(['eligible_group_names', 'min_per_week'])
    const firstRunId = first[0].import_run_id

    // Re-import: the same activity is recognized (unchanged/update) against
    // the live camp, but the source's observation differs this time.
    const result = commitIngest(db, {
      approved: { groups: ['Yeladim'], activities: ['Swim'] },
      activityRules: {
        Swim: {
          eligible_group_names: ['Yeladim'], eligibility_known: true, min_per_week: 1, max_per_week: 2, priority: 'high',
          support: { matched_groups: ['Yeladim'], appearances: 9, eligible_group_count: 1 },
        },
      },
      camp_id: campId, device_id: deviceId,
    })
    expect(result.held).toBe(false)

    const second = evidenceRows('activities')
    // Still exactly one row PER FIELD — latest-wins, not append-only.
    expect(second).toHaveLength(2)
    const eligibleRow = second.find((r) => r.field === 'eligible_group_names')
    expect(JSON.parse(eligibleRow.support).appearances).toBe(9)
    expect(eligibleRow.import_run_id).not.toBe(firstRunId)
  })

  it('(d) a HELD commit writes no import_evidence rows — rolled back with everything else', () => {
    const heldPlan = {
      plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
      sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
      unresolved: [],
      items: [
        {
          op: 'create', entity: 'activities', entity_id: null,
          fields: { name: { from: null, to: 'Swim', source: 'import' } },
          evidence: { tier: 'new' }, _name: 'Swim', _humanFields: [],
          _rule: {
            eligible_group_names: null, eligibility_known: false, min_per_week: 1, max_per_week: 2,
            support: { matched_groups: [], appearances: 0, eligible_group_count: 0 },
          },
        },
        // A conflict item forces the whole commit to hold (ADR §4).
        {
          op: 'conflict', entity: 'groups', entity_id: null, reason: 'ambiguous_identity',
          fields: {}, evidence: { tier: 'exact_name', candidates: [] }, _name: 'Bunk 1',
        },
      ],
    }
    const result = commitPlan(db, heldPlan, { device_id: deviceId })
    expect(result.held).toBe(true)
    expect(count('activities')).toBe(0)
    expect(count('import_evidence')).toBe(0)
  })

  it('read-after-write: listImportEvidence returns what commitIngest just wrote', () => {
    commitIngest(db, {
      approved: { activities: ['Drama'] },
      activityRules: {
        Drama: {
          eligible_group_names: null, eligibility_known: false, min_per_week: 1, max_per_week: 2,
          support: { matched_groups: [], appearances: 3, eligible_group_count: 0 },
        },
      },
      camp_id: campId, device_id: deviceId,
    })
    const activityId = db.prepare('SELECT id FROM activities WHERE name = ?').get('Drama').id
    const rows = listImportEvidence(db, campId, { entity_type: 'activities', entity_id: activityId })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.support).toEqual({ matched_groups: [], appearances: 3, eligible_group_count: 0 })
      expect(row.confidence).toBe('low') // eligibility_known:false -> honestly low
    }
  })
})
