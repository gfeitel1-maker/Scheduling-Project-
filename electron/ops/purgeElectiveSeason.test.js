// @vitest-environment node
//
// T343 — director-triggered end-of-season purge: every elective run goes, with
// the exact per-run cascade deleteElectiveRun owns, in one runAtomic frame;
// the offerings setup and every non-elective table stay byte-identical.
// Real better-sqlite3, real appendOp/projection; no mocks.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as Automerge from '@automerge/automerge'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { deriveElectiveOccurrenceId } from './electiveDerivedIds.js'
import { purgeElectiveSeason } from './purgeElectiveSeason.js'
import { createEmptyDoc, applyWrite, applyWrites } from '../automerge/campDocument.js'
import { projectAll } from '../automerge/projector.js'

const dirs = []
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const RUN_SCOPED = [
  'elective_run_findings', 'elective_run_outer_snapshots', 'elective_assignments',
  'elective_preferences', 'elective_choices', 'elective_occurrences',
]
const KEPT = [
  'elective_sets', 'elective_set_activities', 'elective_bundles', 'elective_bundle_periods',
  'elective_bundle_tiers', 'campers', 'groups', 'tiers', 'activities', 'days_of_operation',
  'schedule_templates', 'template_slots', 'fixed_events', 'locations',
]
const ctx = { author_user_id: null, device_id: 'dev-1' }

const dump = (db, tables) =>
  JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]))

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-purge-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')

  const f = {
    campId, groupId: randomUUID(), tierId: randomUUID(), setId: randomUUID(), activityId: randomUUID(),
    locationId: randomUUID(), camperId: randomUUID(), dayId: 'day-1', timeBlockId: 'tb-1',
    templateId: 'tpl-1', bundleId: randomUUID(),
  }
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES (?, ?, ?, 1, 1)').run(f.dayId, campId, 'Monday')
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(f.tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(f.groupId, campId, 'Bogrim A', f.tierId)
  db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(f.locationId, campId, 'Field', 5)
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)').run(f.activityId, campId, 'Archery', f.locationId)
  db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id) VALUES (?, ?, ?, ?)').run(f.camperId, campId, 'Ari Green', f.groupId)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(f.setId, campId, 'AM Electives')
  db.prepare(
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), f.setId, f.activityId, 'unlimited', null)
  db.prepare('INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES (?, ?, ?, ?)').run(f.bundleId, f.setId, f.activityId, 'Bundle')
  db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)').run(randomUUID(), f.bundleId, f.dayId, f.timeBlockId)
  db.prepare('INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES (?, ?, ?)').run(randomUUID(), f.bundleId, f.tierId)
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), f.templateId, f.groupId, f.setId, f.dayId, f.timeBlockId)
  db.prepare('INSERT INTO fixed_events (id, camp_id, day_id, time_block_id, name) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), campId, f.dayId, f.timeBlockId, 'Flag raising')
  return { db, f }
}

function buildRun(db, f, { runId = randomUUID(), rosterOnlyId = randomUUID() } = {}) {
  const occurrenceId = deriveElectiveOccurrenceId(runId, f.setId, f.dayId, f.timeBlockId, f.tierId)
  const occurrences = [{ id: occurrenceId, elective_set_id: f.setId, day_id: f.dayId, time_block_id: f.timeBlockId, tier_id: f.tierId }]
  const campers = [{ id: f.camperId, name: 'Ari Green' }]
  const parsed = {
    campers: [...campers, { id: rosterOnlyId, name: 'Tal Bar' }].map((c) => ({ id: c.id, display_name: c.name, external_id: null })),
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: campers.map((c) => ({ camper_id: c.id, occurrence_id: occurrenceId, label: 'Archery', labelKey: 'archery', rank: 1 })),
    sameNameCampers: [],
    skippedRows: [],
  }
  const assignments = campers.map((c) => ({
    camper_id: c.id, occurrence_id: occurrenceId, labelKey: 'archery', activity_id: f.activityId, preference_rank: 1, flags: [],
  }))
  const out = commitElectiveRun(db, {
    campId: f.campId, deviceId: 'dev-1', name: `Run ${runId.slice(0, 4)}`, parsed, assignments, occurrences,
    scheduleTemplateId: f.templateId, runId,
  })
  expect(out.ok).toBe(true)
  return out.runId
}

function twoPopulatedRuns() {
  const { db, f } = seed()
  const runs = [buildRun(db, f), buildRun(db, f)]
  for (const runId of runs) {
    for (const t of ['elective_assignments', 'elective_preferences', 'elective_choices', 'elective_occurrences', 'elective_run_findings']) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE run_id = ?`).get(runId).c).toBeGreaterThan(0)
    }
  }
  expect(db.prepare('SELECT COUNT(*) c FROM elective_choice_offerings').get().c).toBeGreaterThan(0)
  return { db, f, runs }
}

describe('purgeElectiveSeason', () => {
  it('clear-all: every run-scoped row of every run is gone and no run remains', () => {
    const { db, runs } = twoPopulatedRuns()
    const out = purgeElectiveSeason(db, ctx)
    expect(out.ok).toBe(true)
    expect(out.runsDeleted).toBe(2)

    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(0)
    for (const runId of runs) {
      for (const t of RUN_SCOPED) {
        expect(db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE run_id = ?`).get(runId).c).toBe(0)
      }
    }
    expect(db.prepare('SELECT COUNT(*) c FROM elective_choice_offerings').get().c).toBe(0)
    db.close()
  })

  it('kept-untouched: offerings setup and all non-elective tables are byte-identical', () => {
    const { db } = twoPopulatedRuns()
    const before = dump(db, KEPT)
    purgeElectiveSeason(db, ctx)
    expect(dump(db, KEPT)).toBe(before)
    db.close()
  })

  it('kept-untouched check can catch an over-broad delete (sanity: deleting an elective_bundles row changes the dump)', () => {
    const { db, f } = twoPopulatedRuns()
    const before = dump(db, KEPT)
    purgeElectiveSeason(db, ctx)
    appendOp(db, { entity: 'elective_bundles', entity_id: f.bundleId, field: DELETE_FIELD, value: 1, ...ctx })
    expect(dump(db, KEPT)).not.toBe(before)
    db.close()
  })

  it('resurrection-safety (local): a child write on a purged run does not re-create the run', () => {
    const { db, runs } = twoPopulatedRuns()
    purgeElectiveSeason(db, ctx)
    for (const runId of runs) {
      appendOp(db, { entity: 'elective_preferences', entity_id: randomUUID(), field: 'run_id', value: runId, ...ctx })
    }
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(0)
    db.close()
  })

  it('resurrection-safety (merge): a peer child write racing the purge leaves no run after projectAll', () => {
    const { db, f } = seed()
    const runId = buildRun(db, f)
    let doc = createEmptyDoc()
    const history = db.prepare('SELECT entity, entity_id, field, value FROM operations ORDER BY seq').all()
    doc = applyWrites(doc, history.map((o) => ({ entity: o.entity, entity_id: o.entity_id, field: o.field, value: o.value })))
    const peer = Automerge.clone(doc)

    const before = db.prepare('SELECT COUNT(*) c FROM operations').get().c
    const out = purgeElectiveSeason(db, ctx)
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBeGreaterThan(before)
    doc = applyWrites(doc, out.ops.map((o) => ({ entity: o.entity, entity_id: o.entity_id, field: o.field, value: 1 })))
    const racing = applyWrite(peer, { entity: 'elective_preferences', entity_id: randomUUID(), field: 'run_id', value: runId })

    projectAll(db, Automerge.merge(doc, racing))
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(0)
    db.close()
  })

  it('atomicity: a failure mid-clear leaves every elective table and the op log unchanged', () => {
    const { db, runs } = twoPopulatedRuns()
    const all = [...RUN_SCOPED, 'elective_choice_offerings', 'elective_assignment_runs', 'operations']
    const before = dump(db, all)
    db.exec(`CREATE TEMP TRIGGER boom BEFORE DELETE ON elective_assignment_runs
      WHEN OLD.id = '${runs[1]}' BEGIN SELECT RAISE(ABORT, 'injected'); END;`)
    expect(() => purgeElectiveSeason(db, ctx)).toThrow()
    db.exec('DROP TRIGGER boom')
    expect(dump(db, all)).toBe(before)
    db.close()
  })

  it('idempotent: a second purge is a no-op that does not throw', () => {
    const { db } = twoPopulatedRuns()
    purgeElectiveSeason(db, ctx)
    const out = purgeElectiveSeason(db, ctx)
    expect(out).toEqual({ ok: true, runsDeleted: 0, ops: [] })
    db.close()
  })
})
