import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest, INGESTIBLE_ENTITIES } from './ingest.js'
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
    // The failure injected here is a real one rather than a mock: an activity
    // that already exists collides with UNIQUE(camp_id, name). That is not
    // hypothetical — it is what happens when someone adds a record in another
    // window between the preview and the confirm.
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, 'Drama')

    expect(() => commitIngest(db, {
      approved: { groups: ['Bunk 1', 'Bunk 2'], activities: ['Swim', 'Archery', 'Drama'] },
      camp_id: campId, device_id: deviceId,
    })).toThrow()

    // Nothing at all — not the groups, not the two activities that would have
    // succeeded, not the ops. Only the row that was there before.
    expect(count('groups')).toBe(0)
    expect(count('activities')).toBe(1)
    expect(db.prepare("SELECT name FROM activities").get().name).toBe('Drama')
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
    expect(result.fixedEvents).toEqual({ created: 2, skipped: [], partial: [] })
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
