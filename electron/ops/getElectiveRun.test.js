// T320 (docs/adr/2026-09-30-elective-run-durability.md) — durable derivations
// read by getElectiveRun.js: dangling-assignment survives a cold reopen (item
// 2), snapshot completeness (item 1, cross-handler parity with
// getElectiveRunOuterSchedule.js), and live draft-run resource conflicts
// (item 4).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { setElectiveAssignment } from './setElectiveAssignment.js'
import { getElectiveRun } from './getElectiveRun.js'
import { getElectiveRunOuterSchedule } from './getElectiveRunOuterSchedule.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-getrun-'))
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
  return { db, campId }
}
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
const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: 'occ-1', labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1, flags: [] },
]
const OCCURRENCE_FIXTURE = [
  { id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
]

// S5 — DANGLING_MANUAL_ASSIGNMENT derives durably on a COLD read, with no
// commit response in play (this is a plain getElectiveRun call, not the
// return value of commitElectiveRun).
describe('getElectiveRun — S5, durable dangling derivation survives a cold reopen', () => {
  it('derives DANGLING_MANUAL_ASSIGNMENT purely from a read, after regeneration pruned the occurrence', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    const GONE = [
      ...OCCURRENCE_FIXTURE,
      { id: 'occ-2', elective_set_id: 'set-1', day_id: 'day-2', time_block_id: 'tb-1', tier_id: 'tier-1' },
    ]
    expect(commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed: PARSED, assignments: ASSIGNMENTS, occurrences: GONE,
    }).ok).toBe(true)
    expect(setElectiveAssignment(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-2', activityId: 'act-gaga', locked: true, deviceId: 'dev-1',
    }).ok).toBe(true)
    expect(commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    }).ok).toBe(true)

    // A COLD read — no commit response is consulted here at all.
    const cold = getElectiveRun(db, { runId })
    expect(cold.danglingFindings).toEqual([
      expect.objectContaining({ kind: 'DANGLING_MANUAL_ASSIGNMENT', camper_id: 'cam-1', occurrence_id: 'occ-2' }),
    ])
  })

  it('clears once the move is written through replacesAssignmentId (S6)', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    const GONE = [
      ...OCCURRENCE_FIXTURE,
      { id: 'occ-2', elective_set_id: 'set-1', day_id: 'day-2', time_block_id: 'tb-1', tier_id: 'tier-1' },
    ]
    commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed: PARSED, assignments: ASSIGNMENTS, occurrences: GONE,
    })
    const moved = setElectiveAssignment(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-2', activityId: 'act-gaga', locked: true, deviceId: 'dev-1',
    })
    commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(getElectiveRun(db, { runId }).danglingFindings).toHaveLength(1)

    const move = setElectiveAssignment(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-1', activityId: 'act-archery',
      locked: true, deviceId: 'dev-1', replacesAssignmentId: moved.assignmentId,
    })
    expect(move.ok).toBe(true)

    expect(getElectiveRun(db, { runId }).danglingFindings).toEqual([])
  })
})

// S1 — cross-handler parity: getElectiveRun and getElectiveRunOuterSchedule
// must agree on snapshotIncomplete/expectedSnapshotRows/heldSnapshotRows for
// the same fixture.
describe('cross-handler parity — S1, snapshot completeness', () => {
  it('getElectiveRun and getElectiveRunOuterSchedule report identical completeness for a partially-synced final run', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    // Simulate a finalized run whose snapshot's expectation was recorded but
    // whose row never fully arrived (a partial sync) — same stub-seed shape
    // projections.js produces.
    db.prepare("UPDATE elective_assignment_runs SET status = 'final', snapshot_expected_rows = 1, snapshot_digest = 'deadbeef' WHERE id = ?").run(runId)
    db.prepare(
      'INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run('snap-1', runId, 'cam-1', 'day-1', 'tb-1')

    const a = getElectiveRun(db, { runId })
    const b = getElectiveRunOuterSchedule(db, { runId })
    expect(a.snapshotIncomplete).toBe(true)
    expect(b.snapshotIncomplete).toBe(true)
    expect(a.expectedSnapshotRows).toBe(b.expectedSnapshotRows)
    expect(a.heldSnapshotRows).toBe(b.heldSnapshotRows)
  })
})
