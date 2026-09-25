// T245 — the draft move/lock write path. Fixtures are fabricated; no real
// camper data is in this repo and none may be added.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { setElectiveAssignment } from './setElectiveAssignment.js'
import { deriveElectiveAssignmentId } from './electiveDerivedIds.js'
import { electiveGenerationVisibleFragment } from './electiveGenerationPredicate.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-setasgn-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const PARSED = {
  campers: [
    { id: 'cam-1', display_name: 'Ari Green', external_id: null },
    { id: 'cam-2', display_name: 'Noa Katz', external_id: 'CM-2' },
  ],
  choices: [{ label: 'Archery', labelKey: 'archery' }, { label: 'Gaga', labelKey: 'gaga' }],
  preferences: [
    { camper_id: 'cam-1', label: 'Gaga', labelKey: 'gaga', rank: 1 },
    { camper_id: 'cam-2', label: 'Archery', labelKey: 'archery', rank: 1 },
  ],
  sameNameCampers: [],
  skippedRows: [],
}
const OCCURRENCES = [
  { id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
]
// cam-2 already sits in act-archery; cam-1 sits in act-gaga. The move under
// test is cam-1 -> act-archery.
const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: 'occ-1', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 },
  { camper_id: 'cam-2', occurrence_id: 'occ-1', labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1 },
]

function seedRun(db, campId, { capacityMode = 'limited', capacityLimit = 5 } = {}) {
  const runId = randomUUID()
  const out = commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
    parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES,
  })
  expect(out.ok).toBe(true)
  for (const activityId of ['act-archery', 'act-gaga']) {
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), 'set-1', activityId, capacityMode, capacityLimit, 'confirmed')
  }
  return runId
}

const move = (db, runId, over = {}) =>
  setElectiveAssignment(db, {
    runId, camperId: 'cam-1', occurrenceId: 'occ-1', activityId: 'act-archery',
    locked: true, deviceId: 'dev-1', ...over,
  })

describe('setElectiveAssignment', () => {
  it('writes the derived row with source=manual, is_locked and the run marker', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const gen = db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(runId).solver_generation

    const out = move(db, runId)
    expect(out).toEqual({ ok: true, assignmentId: deriveElectiveAssignmentId(runId, 'cam-1', 'occ-1') })

    const row = db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(out.assignmentId)
    expect(row.activity_id).toBe('act-archery')
    expect(row.source).toBe('manual')
    expect(row.is_locked).toBe(1)
    expect(row.solver_generation).toBe(gen)
    expect(row.run_id).toBe(runId)
    db.close()
  })

  // The property that makes integration scenario 31 (two devices converging on
  // one row with a per-field conflict) apply to THIS handler: it writes the
  // same derived id the solver writes, so the move lands on the existing row.
  it('re-writing the same (run, camper, occurrence) updates the one derived row', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const before = db.prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ?').get(runId).c

    expect(move(db, runId).ok).toBe(true)
    expect(move(db, runId, { activityId: 'act-gaga', locked: false }).ok).toBe(true)

    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ?').get(runId).c).toBe(before)
    const row = db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(deriveElectiveAssignmentId(runId, 'cam-1', 'occ-1'))
    expect(row.activity_id).toBe('act-gaga')
    expect(row.is_locked).toBe(0)
    db.close()
  })

  // H3: a manual row survives regeneration by being EXEMPT from the generation
  // predicate, never by having its marker carried forward.
  it('keeps a manual row visible after the run is regenerated to a new marker', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const out = move(db, runId)
    const stampedAtWrite = db.prepare('SELECT solver_generation FROM elective_assignments WHERE id = ?').get(out.assignmentId).solver_generation

    expect(commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
      parsed: PARSED, assignments: [], occurrences: OCCURRENCES,
    }).ok).toBe(true)
    const gen = db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(runId).solver_generation
    expect(gen).not.toBe(stampedAtWrite)

    const visible = db
      .prepare(`SELECT a.id FROM elective_assignments a WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}`)
      .all({ runId, gen })
    expect(visible.map((r) => r.id)).toContain(out.assignmentId)

    // And the marker was NOT re-stamped by anything.
    expect(db.prepare('SELECT solver_generation FROM elective_assignments WHERE id = ?').get(out.assignmentId).solver_generation)
      .toBe(stampedAtWrite)
    db.close()
  })

  it('returns OCCURRENCE_FULL with capacity and filled when the offering is full', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId, { capacityLimit: 1 })
    // cam-2 already occupies the one act-archery seat.
    expect(move(db, runId)).toEqual({ ok: false, error: 'OCCURRENCE_FULL', capacity: 1, filled: 1 })
    db.close()
  })

  it('does not count the row being written against its own capacity', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId, { capacityLimit: 1 })
    // cam-1 into act-gaga, where cam-1's own solver row already sits.
    expect(move(db, runId, { activityId: 'act-gaga' }).ok).toBe(true)
    db.close()
  })

  it('returns CAMPER_INELIGIBLE for a camper who is not a participant of the run', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    expect(move(db, runId, { camperId: 'cam-99' })).toEqual({ ok: false, error: 'CAMPER_INELIGIBLE' })
    db.close()
  })

  it('returns RUN_NOT_DRAFT on a final run', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    db.prepare("UPDATE elective_assignment_runs SET status = 'final' WHERE id = ?").run(runId)
    expect(move(db, runId)).toEqual({ ok: false, error: 'RUN_NOT_DRAFT' })
    db.close()
  })

  it('refuses an activity that is not a confirmed offering of the occurrence set', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const out = move(db, runId, { activityId: 'act-nothing' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/offering/)
    db.close()
  })
})
