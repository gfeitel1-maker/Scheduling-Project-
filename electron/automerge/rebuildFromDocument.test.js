// @vitest-environment node
//
// THE SYSTEM PROPERTY, not an entity-by-entity unit behaviour (T151).
//
// The architecture's strongest promise is "SQLite is a rebuildable projection:
// delete it, rebuild from the document, get the camp back." Everything else
// here tests a piece of that. This tests the whole sentence, in the shape the
// promise is actually made in: a camp built through the REAL write paths, a
// document seeded from it, and a projection into a genuinely EMPTY database of
// the current schema — not the same database with its tables wiped, which is
// what the existing round-trip in generalize.test.js does and which cannot
// catch anything that depends on a row already being there.
//
// It covers what an entity-by-entity test structurally cannot: parent-scoped
// children, the bulk-replace primitive (whose rows live in a different document
// collection from the entity's own), `camps`/`users`, and a tombstone.
//
// AND IT PINS THE PRECONDITION, which is the part the promise does not say out
// loud: the fresh database must already hold the camps row, with the matching
// id. Document replay never creates it (projector.js's camps comment), and the
// projection guard rejects every camp_id write whose value does not match this
// device's camp — so against a TRULY empty database the rebuild does not
// degrade, it fails outright. The second test measures that, so the precondition
// can never quietly become false.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, appendBulkReplaceOp, DELETE_FIELD } from '../ops/operations.js'
import { commitIngest } from '../ops/ingest.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { PROJECTIONS } from '../ops/projections.js'
import { seedAllFromSqlite } from './seed.js'
import { projectAll } from './projector.js'

let files = []
function newDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-rebuild-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}

// Every table the document claims authority over — direct-camp entities, their
// parent-scoped children, and the two modeled outside both registries.
const MODELED_TABLES = [...DIRECT_CAMP_ENTITIES, ...Object.keys(PARENT_SCOPED_ENTITIES), 'camps', 'users']

function snapshot(db) {
  const out = {}
  for (const entity of MODELED_TABLES) {
    const fields = PROJECTIONS[entity]?.fields ?? []
    out[entity] = db.prepare(`SELECT id, ${fields.join(', ')} FROM ${entity} ORDER BY id`).all()
  }
  return out
}

// A camp with enough shape to be worth rebuilding: a real import, both kinds of
// child row, the bulk-replace primitive, and something deleted.
function buildRichCamp(db, campId, deviceId) {
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Probe', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device One')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)

  commitIngest(db, {
    approved: {
      cohorts: ['Main'], tiers: ['Aleph', 'Bet'], groups: ['Bunk 1', 'Bunk 2'],
      days_of_operation: ['Monday', 'Tuesday'], time_blocks: ['09:00-09:40', 'Block 2'],
      activities: ['Swim', 'Archery'],
    },
    links: { groups: { 'Bunk 1': 'Aleph', 'Bunk 2': 'Bet' } },
    activityRules: {
      Swim: { eligible_group_names: ['Bunk 1', 'Bunk 2'], min_per_week: 2, max_per_week: 3, priority: 'high' },
      Archery: { eligible_group_names: ['Bunk 1'], min_per_week: 0, max_per_week: 1, priority: 'low' },
    },
    fixedEvents: [{ name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'], scope: { is_all_groups: true, groups: [] } }],
    camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add',
  })

  const op = (entity, entity_id, field, value) =>
    appendOp(db, { entity, entity_id, field, value, device_id: deviceId, author_user_id: 'u1' })

  const weekId = randomUUID()
  op('schedule_weeks', weekId, 'camp_id', campId)
  op('schedule_weeks', weekId, 'name', 'Week 1')

  // `kind` FIRST — projections.js's documented write-ordering contract for
  // schedule_templates, not incidental ordering.
  const tplId = randomUUID()
  op('schedule_templates', tplId, 'kind', 'manual')
  op('schedule_templates', tplId, 'camp_id', campId)
  op('schedule_templates', tplId, 'week_id', weekId)
  op('schedule_templates', tplId, 'name', 'Manual v1')

  const locId = randomUUID()
  op('locations', locId, 'camp_id', campId)
  op('locations', locId, 'name', 'Lake')
  op('locations', locId, 'capacity', 2)

  const sdId = randomUUID()
  op('special_days', sdId, 'camp_id', campId)
  op('special_days', sdId, 'name', 'Color War')

  const esId = randomUUID()
  op('elective_sets', esId, 'camp_id', campId)
  op('elective_sets', esId, 'name', 'Afternoon')

  const evId = randomUUID()
  op('events', evId, 'camp_id', campId)
  op('events', evId, 'name', 'Visiting Day')

  const activity = db.prepare("SELECT id FROM activities WHERE name = 'Swim'").get()

  // Parent-scoped children: rows with no camp_id of their own, reachable only
  // through a parent. These are the ones a direct-entity test never reaches.
  const sdtb = randomUUID()
  op('special_day_time_blocks', sdtb, 'special_day_id', sdId)
  op('special_day_time_blocks', sdtb, 'name', 'SD Block')
  op('special_day_time_blocks', sdtb, 'sort_order', 0)

  const esa = randomUUID()
  op('elective_set_activities', esa, 'elective_set_id', esId)
  op('elective_set_activities', esa, 'activity_id', activity.id)

  const wae = randomUUID()
  op('week_activity_exclusions', wae, 'week_id', weekId)
  op('week_activity_exclusions', wae, 'activity_id', activity.id)

  // The bulk-replace primitive — its rows live under `template_slots_scopes` in
  // the document, a different collection from `template_slots` itself.
  const day = db.prepare("SELECT id FROM days_of_operation WHERE label = 'Monday'").get()
  const block = db.prepare('SELECT id FROM time_blocks LIMIT 1').get()
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Bunk 1'").get()
  appendBulkReplaceOp(db, {
    entity: 'template_slots', scope_id: tplId, device_id: deviceId, author_user_id: 'u1',
    rows: [{ id: randomUUID(), template_id: tplId, group_id: group.id, day_id: day.id, time_block_id: block.id, activity_id: activity.id }],
  })

  // A tombstone: deleted state has to rebuild as deleted, not reappear.
  const archery = db.prepare("SELECT id FROM activities WHERE name = 'Archery'").get()
  op('activities', archery.id, DELETE_FIELD, '1')
}

beforeEach(() => { files = [] })
afterEach(() => {
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

describe('rebuild from the document into a FRESH database', () => {
  it('reproduces every modeled table identically, including parent-scoped rows, bulk-replace slots and a tombstone', () => {
    const source = newDb('source')
    const campId = randomUUID()
    buildRichCamp(source, campId, 'device-1')
    const before = snapshot(source)
    const doc = seedAllFromSqlite(source)

    const fresh = newDb('fresh')
    // THE PRECONDITION (see the file comment): the camps row is bootstrapped
    // first. In production that is bootstrapCamp or the join flow, never
    // document replay.
    fresh.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Probe')

    projectAll(fresh, doc)

    // Compared per table so a failure names WHICH one diverged.
    for (const entity of MODELED_TABLES) {
      expect({ entity, rows: snapshot(fresh)[entity] }).toEqual({ entity, rows: before[entity] })
    }
    source.close()
    fresh.close()
    // A PER-TEST TIMEOUT, for the same reason parentScoped.test.js's 480-slot
    // case has one. This builds a whole camp through the REAL write paths — a
    // full commitIngest plus ~40 further ops, each mirrored into the Automerge
    // document — and then projects all of it into a second database. Measured
    // at ~22s in isolation on this machine, i.e. already past the suite's 20s
    // default before any load at all, and it died at 29s inside a gate.
    //
    // That is the nature of the test, not a regression: it is a system property
    // (T151), and the whole point is that it exercises the expensive path
    // end to end rather than a unit of it. Scoped here rather than raising the
    // global budget, which would hide genuinely stuck tests elsewhere.
  }, 120_000)

  it('REFUSES to rebuild into a database with no camps row — the precondition is load-bearing, not incidental', () => {
    const source = newDb('source2')
    const campId = randomUUID()
    buildRichCamp(source, campId, 'device-1')
    const doc = seedAllFromSqlite(source)

    const empty = newDb('empty')
    // No camps row. Every camp_id write is rejected by the projection guard
    // (it cannot match a camp this device does not have), and the rows that
    // depend on them then violate foreign keys. It fails loudly rather than
    // producing a half-camp, which is the behaviour worth keeping.
    expect(() => projectAll(empty, doc)).toThrow()
    expect(empty.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(0)
    source.close()
    empty.close()
  }, 120_000)
})
