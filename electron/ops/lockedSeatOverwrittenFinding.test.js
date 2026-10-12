// T264 (docs/adr/2026-10-11-locked-elective-seat-survives-unmerged-regeneration.md).
// LOCKED_SEAT_OVERWRITTEN is derived from the merged projection, so every
// state here is built the way a merge leaves it: a row with is_locked=1 and
// whatever mix of source / activity_id / solver_generation won, plus the
// pending activity_id conflict reconcile.js records for it.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { setElectiveAssignment } from './setElectiveAssignment.js'
import { getElectiveRun } from './getElectiveRun.js'
import { deriveElectiveAssignmentId } from './electiveDerivedIds.js'
import { recordConflicts } from '../automerge/conflictStore.js'
import { deriveLockedSeatOverwrittenFindings } from './lockedSeatOverwrittenFinding.js'

const dirs = []
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const PARSED = {
  campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null }],
  choices: [{ label: 'Archery', labelKey: 'archery' }],
  preferences: [{ camper_id: 'cam-1', occurrence_id: 'occ-1', label: 'Archery', labelKey: 'archery', rank: 1 }],
  sameNameCampers: [],
  skippedRows: [],
}
const SOLVER_PLACES_GAGA = [
  { camper_id: 'cam-1', occurrence_id: 'occ-1', labelKey: 'archery', activity_id: 'act-gaga', preference_rank: 1, flags: [] },
]
const OCCURRENCES = [{ id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' }]
const SEAT = deriveElectiveAssignmentId('run-1', 'cam-1', 'occ-1')

function committedRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-lockedseat-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
  for (const [activityId, name] of [['act-archery', 'Archery'], ['act-gaga', 'Gaga']]) {
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, name)
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, status) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), 'set-1', activityId, 'unlimited', 'confirmed')
  }
  const out = commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1', runId: 'run-1', parsed: PARSED,
    assignments: SOLVER_PLACES_GAGA, occurrences: OCCURRENCES,
  })
  expect(out.ok).toBe(true)
  return db
}

const currentGen = (db) => db.prepare('SELECT solver_generation g FROM elective_assignment_runs WHERE id = ?').get('run-1').g

// The merged states, as the projection leaves the row.
function mergeLeft(db, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE elective_assignments SET ${sets} WHERE id = @id`).run({ id: SEAT, ...fields })
}
function activityConflict(db, { lockedFirst = true, annotated = true } = {}) {
  const lock = { opId: '9@lock', value: 'act-archery', ...(annotated ? { source: 'manual' } : {}) }
  const solver = { opId: '9@solver', value: 'act-gaga', ...(annotated ? { source: 'solver' } : {}) }
  recordConflicts(db, [{
    entity: 'elective_assignments', entityId: SEAT, field: 'activity_id',
    values: lockedFirst ? [lock, solver] : [solver, lock],
  }])
}

describe('deriveLockedSeatOverwrittenFindings', () => {
  it('outcome 1: every solver key won over the lock -> one item naming camper, locked and solver activity', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-gaga', solver_generation: currentGen(db) })
    activityConflict(db)
    expect(deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))).toEqual([{
      kind: 'LOCKED_SEAT_OVERWRITTEN',
      assignment_id: SEAT,
      camper_id: 'cam-1',
      camper_name: 'Ari Green',
      occurrence_id: 'occ-1',
      locked_activity_id: 'act-archery',
      locked_activity_name: 'Archery',
      solver_activity_id: 'act-gaga',
      solver_activity_name: 'Gaga',
    }])
  })

  it('names the sides by who wrote them, not by their order in the conflict row', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-gaga', solver_generation: currentGen(db) })
    activityConflict(db, { lockedFirst: false })
    const [item] = deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))
    expect([item.locked_activity_id, item.solver_activity_id]).toEqual(['act-archery', 'act-gaga'])
  })

  it('outcome 2: source is the solver\'s and the generation is stale, so the seat is hidden -> still one item', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-archery', solver_generation: 'G0-stale' })
    activityConflict(db)
    const found = deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ locked_activity_id: 'act-archery', solver_activity_id: 'act-gaga' })
  })

  it('outcome 3: source manual holding the solver\'s activity is left to the activity card -> no item', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'manual', activity_id: 'act-gaga', solver_generation: 'G0-stale' })
    activityConflict(db)
    expect(deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))).toEqual([])
  })

  it('a lock that survived raises nothing (non-vacuity)', () => {
    const db = committedRun()
    expect(setElectiveAssignment(db, {
      runId: 'run-1', camperId: 'cam-1', occurrenceId: 'occ-1', activityId: 'act-archery', locked: true, deviceId: 'dev-1',
    }).ok).toBe(true)
    expect(deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))).toEqual([])
  })

  it('an unlocked solver seat raises nothing', () => {
    const db = committedRun()
    expect(deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))).toEqual([])
  })

  it('once the activity card has been answered there is no conflict row: still one item, but the lock\'s activity is not known', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-archery', solver_generation: currentGen(db) })
    const [item] = deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))
    expect(item).toMatchObject({
      locked_activity_id: null, locked_activity_name: null, solver_activity_id: null, solver_activity_name: null,
    })
  })

  it('an unannotated conflict row cannot say which side was the lock: the lock\'s activity is not known, never the row\'s', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-gaga', solver_generation: currentGen(db) })
    activityConflict(db, { annotated: false })
    const [item] = deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))
    expect(item).toMatchObject({ locked_activity_id: null, solver_activity_id: null })
  })

  it('one-tap Restore through setElectiveAssignment clears it', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-gaga', solver_generation: currentGen(db) })
    activityConflict(db)
    const [item] = deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))
    expect(setElectiveAssignment(db, {
      runId: 'run-1', camperId: item.camper_id, occurrenceId: item.occurrence_id,
      activityId: item.locked_activity_id, locked: true, deviceId: 'dev-1',
    }).ok).toBe(true)
    expect(deriveLockedSeatOverwrittenFindings(db, 'run-1', currentGen(db))).toEqual([])
    const row = db.prepare('SELECT source, is_locked, activity_id FROM elective_assignments WHERE id = ?').get(SEAT)
    expect(row).toEqual({ source: 'manual', is_locked: 1, activity_id: 'act-archery' })
  })

  it('Restore closes the seat\'s conflict cards whose competing values it answered, on this device, and leaves the rest', () => {
    const db = committedRun()
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-gaga', solver_generation: currentGen(db) })
    activityConflict(db)
    const archeryChoice = db.prepare("SELECT id FROM elective_choices WHERE run_id = 'run-1' AND label = 'Archery'").get().id
    recordConflicts(db, [{
      entity: 'elective_assignments', entityId: SEAT, field: 'choice_id',
      values: [{ opId: '8@lock', value: archeryChoice }, { opId: '8@solver', value: 'c-b' }],
    }])
    recordConflicts(db, [{
      entity: 'elective_assignments', entityId: SEAT, field: 'preference_rank',
      values: [{ opId: '8@x', value: 7 }, { opId: '8@y', value: 8 }],
    }])
    recordConflicts(db, [{
      entity: 'elective_assignments', entityId: 'some-other-seat', field: 'activity_id',
      values: [{ opId: '8@lock', value: 'x' }, { opId: '8@solver', value: 'y' }],
    }])
    const pending = () => db.prepare(
      "SELECT entity_id, field FROM conflicts WHERE resolved_at IS NULL ORDER BY entity_id, field"
    ).all()
    expect(pending()).toHaveLength(4)
    expect(setElectiveAssignment(db, {
      runId: 'run-1', camperId: 'cam-1', occurrenceId: 'occ-1', activityId: 'act-archery', locked: true, deviceId: 'dev-1',
    }).ok).toBe(true)
    expect(pending()).toEqual([
      { entity_id: SEAT, field: 'preference_rank' },
      { entity_id: 'some-other-seat', field: 'activity_id' },
    ])
  })

  it('is exposed on getElectiveRun as lockedSeatFindings', () => {
    const db = committedRun()
    expect(getElectiveRun(db, { runId: 'run-1' }).lockedSeatFindings).toEqual([])
    mergeLeft(db, { is_locked: 1, source: 'solver', activity_id: 'act-gaga', solver_generation: currentGen(db) })
    expect(getElectiveRun(db, { runId: 'run-1' }).lockedSeatFindings).toHaveLength(1)
  })
})
