// T320 round 2, F1 (docs/adr/2026-09-30-elective-run-durability.md item 1) —
// the end-to-end proof round 1's tests never wrote: a REAL finalizeElectiveRun
// call, against a real in-memory-backed sqlite db, read back by the REAL
// getElectiveRun / getElectiveRunOuterSchedule. Round 1's unit tests
// (electiveRunSnapshotCompleteness.test.js, getElectiveRun.test.js) both
// hand-seeded is_linked_choice as an already-coerced 0/1 integer on both the
// "expected" and "held" sides, which is exactly why they stayed green while
// electiveRunOuterSchedule.js's derive side produces a JS BOOLEAN
// (`!!row.is_linked_choice` / a literal `false`) and the held side re-reads
// an INTEGER column back from SQLite — two different string representations
// of the same logical value, hashed as if they disagreed.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { finalizeElectiveRun } from './finalizeElectiveRun.js'
import { getElectiveRun } from './getElectiveRun.js'
import { getElectiveRunOuterSchedule } from './getElectiveRunOuterSchedule.js'
import { deriveElectiveOccurrenceId } from './electiveDerivedIds.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-finalize-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

// Builds a run with two snapshot rows deliberately chosen to span the value
// classes named in the round-2 brief: is_linked_choice TRUE (camper 1, via a
// real elective_choices row with is_linked=1) and FALSE (camper 2, no choice
// at all — the `!!undefined` arm); a non-null location_id (camper 1) and a
// NULL one (camper 2, activity with no location); a non-null span_blocks on
// both, with two different integer values (1 and 2) so a coincidental match
// can't hide a bug.
function buildFinalizableRun(db, campId) {
  const runId = randomUUID()
  const templateId = 'tpl-1'
  const groupId = randomUUID()
  const tierId = randomUUID()
  const setId = randomUUID()
  const camper1 = randomUUID()
  const camper2 = randomUUID()
  const activityLinked = randomUUID()
  const activityPlain = randomUUID()
  const locationId = randomUUID()
  const day1 = 'day-1'
  const day2 = 'day-2'
  const tb = 'tb-1'

  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bunk Alpha', tierId)
  db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id) VALUES (?, ?, ?, ?)').run(camper1, campId, 'Camper One', groupId)
  db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id) VALUES (?, ?, ?, ?)').run(camper2, campId, 'Camper Two', groupId)
  db.prepare('INSERT INTO locations (id, camp_id, name) VALUES (?, ?, ?)').run(locationId, campId, 'Field')
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, ?)').run(activityLinked, campId, 'Archery', locationId, 1)
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, ?)').run(activityPlain, campId, 'Pottery', null, 2)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'AM Electives')

  const occ1 = deriveElectiveOccurrenceId(runId, setId, day1, tb, tierId)
  const occ2 = deriveElectiveOccurrenceId(runId, setId, day2, tb, tierId)
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), templateId, groupId, setId, day1, tb)
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), templateId, groupId, setId, day2, tb)

  db.prepare(
    'INSERT INTO elective_assignment_runs (id, camp_id, name, status, schedule_template_id, solver_generation) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(runId, campId, 'Week 1', 'draft', templateId, 'gen-1')

  db.prepare(
    'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id, tier_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(occ1, runId, setId, day1, tb, tierId)
  db.prepare(
    'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id, tier_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(occ2, runId, setId, day2, tb, tierId)

  const choiceId = randomUUID()
  db.prepare('INSERT INTO elective_choices (id, run_id, label, is_linked) VALUES (?, ?, ?, 1)').run(choiceId, runId, 'Archery')

  // source='manual' on both so electiveGenerationVisibleFragment shows them
  // regardless of solver_generation — this test is not about the generation
  // predicate.
  db.prepare(
    `INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id, choice_id, source, is_locked)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', 0)`
  ).run(randomUUID(), runId, occ1, camper1, activityLinked, choiceId)
  db.prepare(
    `INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id, choice_id, source, is_locked)
     VALUES (?, ?, ?, ?, ?, NULL, 'manual', 0)`
  ).run(randomUUID(), runId, occ2, camper2, activityPlain)

  return { runId }
}

describe('finalizeElectiveRun -> getElectiveRun / getElectiveRunOuterSchedule — snapshot digest self-agreement (F1)', () => {
  it('reports snapshotIncomplete false for a real finalize whose rows mix boolean and integer is_linked_choice', () => {
    const { db, campId } = freshDb()
    const { runId } = buildFinalizableRun(db, campId)

    const result = finalizeElectiveRun(db, { runId, deviceId: 'dev-1' })
    expect(result.ok).toBe(true)
    expect(result.snapshotRows).toBe(2)

    const fromGetRun = getElectiveRun(db, { runId })
    const fromOuter = getElectiveRunOuterSchedule(db, { runId })

    expect(fromGetRun.snapshotIncomplete).toBe(false)
    expect(fromOuter.snapshotIncomplete).toBe(false)
  })

  it('still reports incomplete when a held snapshot row is entirely missing', () => {
    const { db, campId } = freshDb()
    const { runId } = buildFinalizableRun(db, campId)
    expect(finalizeElectiveRun(db, { runId, deviceId: 'dev-1' }).ok).toBe(true)

    const [row] = db.prepare('SELECT id FROM elective_run_outer_snapshots WHERE run_id = ? ORDER BY id LIMIT 1').all(runId)
    db.prepare('DELETE FROM elective_run_outer_snapshots WHERE id = ?').run(row.id)

    expect(getElectiveRun(db, { runId }).snapshotIncomplete).toBe(true)
    expect(getElectiveRunOuterSchedule(db, { runId }).snapshotIncomplete).toBe(true)
  })

  it('still reports incomplete when one field of one held row is mutated after finalize — the digest, not just the count, is catching this', () => {
    const { db, campId } = freshDb()
    const { runId } = buildFinalizableRun(db, campId)
    expect(finalizeElectiveRun(db, { runId, deviceId: 'dev-1' }).ok).toBe(true)

    const [row] = db.prepare('SELECT id FROM elective_run_outer_snapshots WHERE run_id = ? ORDER BY id LIMIT 1').all(runId)
    db.prepare("UPDATE elective_run_outer_snapshots SET activity_name = 'Mutated' WHERE id = ?").run(row.id)

    // Row count is unchanged (still 2) — only content differs. If this ever
    // starts passing (snapshotIncomplete === false) after normalization work,
    // the digest has been over-normalized into not comparing content at all.
    const held = db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?').get(runId).c
    expect(held).toBe(2)
    expect(getElectiveRun(db, { runId }).snapshotIncomplete).toBe(true)
    expect(getElectiveRunOuterSchedule(db, { runId }).snapshotIncomplete).toBe(true)
  })
})
