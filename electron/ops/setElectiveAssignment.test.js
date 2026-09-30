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
    { camper_id: 'cam-1', occurrence_id: 'occ-1', label: 'Gaga', labelKey: 'gaga', rank: 1 },
    { camper_id: 'cam-2', occurrence_id: 'occ-1', label: 'Archery', labelKey: 'archery', rank: 1 },
    { camper_id: 'cam-1', occurrence_id: 'occ-1', label: 'Archery', labelKey: 'archery', rank: 2 },
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
  for (const [activityId, name] of [['act-archery', 'Archery'], ['act-gaga', 'Gaga']]) {
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, name)
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
  // T265 (v78) — the bug the fixture's collision count could only demonstrate
  // indirectly: the SAME camper ranking the SAME choice differently in two
  // occurrences (a linked choice spanning two cells) must resolve to the
  // rank for the occurrence being placed into, not whichever row the old
  // 3-tuple id's LIMIT 1 happened to keep.
  it('picks the rank for the occurrence being placed into, not the other one', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)

    // A second occurrence of the same elective set, so 'act-archery' is a
    // confirmed offering there too.
    db.prepare(
      'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id, tier_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('occ-2', runId, 'set-1', 'day-2', 'tb-1', 'tier-1')

    // cam-1 ranks Archery differently per cell: 1st choice in occ-1, 3rd in
    // occ-2. commitElectiveRun's seedRun already wrote the occ-1 row (rank 2,
    // via PARSED above); add the occ-2 row directly.
    db.prepare(
      "INSERT INTO elective_preferences (id, run_id, camper_id, occurrence_id, choice_id, rank) VALUES (?, ?, 'cam-1', 'occ-2', (SELECT id FROM elective_choices WHERE run_id = ? AND label = 'Archery'), 3)"
    ).run(randomUUID(), runId, runId)

    const inOcc1 = move(db, runId, { occurrenceId: 'occ-1' })
    expect(inOcc1.ok).toBe(true)
    expect(db.prepare('SELECT preference_rank FROM elective_assignments WHERE id = ?').get(inOcc1.assignmentId).preference_rank).toBe(2)

    const inOcc2 = move(db, runId, { occurrenceId: 'occ-2' })
    expect(inOcc2.ok).toBe(true)
    expect(db.prepare('SELECT preference_rank FROM elective_assignments WHERE id = ?').get(inOcc2.assignmentId).preference_rank).toBe(3)
    db.close()
  })

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

  // H3, stated at its true width: the row is EXEMPT FROM THE GENERATION
  // PREDICATE, because its marker is stamped once at this write and never
  // carried forward. That is a claim about VISIBILITY only. It is NOT a claim
  // that a manual row survives regeneration intact — a regeneration that
  // re-emits this (run, camper, occurrence) writes source:'solver' back over
  // it, which is T246's scope (the ADR has commitElectiveRun pass locked rows
  // in as lockedAssignments; that is not implemented yet). The regeneration
  // below deliberately re-emits NO assignments, so it measures the predicate
  // alone.
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

  // T316 round 3, owner-ruled in scope: a confirmed ('limited', NULL) offering
  // is a misconfiguration, not a full room. A manual move into it must be
  // refused distinctly (never OCCURRENCE_FULL, never capacity: 0) and the
  // refusal must name the offering the way findBlankCapacities does.
  it('refuses INVALID_CAPACITY, naming the offering, for a confirmed limited offering with a blank capacity', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId, { capacityLimit: null })
    const setActivityId = db
      .prepare('SELECT id FROM elective_set_activities WHERE elective_set_id = ? AND activity_id = ?')
      .get('set-1', 'act-archery').id
    const out = move(db, runId)
    expect(out).toEqual({
      ok: false,
      error: 'INVALID_CAPACITY',
      activityId: 'act-archery',
      setActivityId,
      message: '"Archery" is set to limited capacity but the number is blank — fill it in first.',
    })
    db.close()
  })

  // T316 round 4: the activity lookup at line 110 is a plain SELECT with no
  // guarantee the row still exists — an elective_set_activities row can name
  // an activity_id that no longer resolves. That leaves activityName
  // undefined, and the INVALID_CAPACITY message interpolated it unguarded,
  // putting the literal string "undefined" in front of a director.
  it('refuses INVALID_CAPACITY without the literal string "undefined" when the offering names a deleted activity', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    // No corresponding row in `activities` for this id — elective_set_activities
    // has no FK on activity_id, so this is a legitimate dangling reference,
    // not a constraint violation.
    const setActivityId = randomUUID()
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(setActivityId, 'set-1', 'act-ghost', 'limited', null, 'confirmed')

    const out = move(db, runId, { activityId: 'act-ghost' })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('INVALID_CAPACITY')
    expect(out.message).not.toMatch(/undefined/)
    expect(out.message).toBe('This offering is set to limited capacity but the number is blank — fill it in first.')
    db.close()
  })

  // T316 round 5 (Red Hat finding 1): writeAssignment (DraftRunView.jsx) is the
  // single call path for THREE director actions — a move, a Lock toggle, and
  // releaseLock — and this capacity gate runs on ALL of them, including a lock
  // toggle where the camper is ALREADY the occupant and moves nowhere. The
  // refusal message must therefore not claim a move happened. This seeds
  // cam-1 already placed in act-gaga (a blank-capacity offering) and toggles
  // only `locked`, proving the gate fires on a pure lock and that the message
  // stays action-neutral.
  it('refuses INVALID_CAPACITY on a lock toggle of an already-placed camper, without claiming a move', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId, { capacityLimit: null })
    // cam-1's solver row already sits in act-gaga (seeded via ASSIGNMENTS).
    const before = db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(deriveElectiveAssignmentId(runId, 'cam-1', 'occ-1'))
    expect(before.activity_id).toBe('act-gaga')

    const out = move(db, runId, { activityId: 'act-gaga', locked: !before.is_locked })

    expect(out.ok).toBe(false)
    expect(out.error).toBe('INVALID_CAPACITY')
    expect(out.message).not.toMatch(/mov(e|ing)/i)
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

  // FIX 1 (round 2). A move overwrites an existing SOLVER row, so any field the
  // move does not write keeps describing the PRE-MOVE activity. choice_id and
  // preference_rank are exactly that: left alone, the row says "archery, the
  // camper's 1st choice" while activity_id says gaga.
  it('re-derives preference_rank and choice_id for the activity moved TO', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    // cam-1's solver row is gaga (their rank 1). Move to archery, their rank 2.
    const out = move(db, runId)
    expect(out.ok).toBe(true)

    const row = db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(out.assignmentId)
    const archery = db.prepare("SELECT id FROM elective_choices WHERE run_id = ? AND label = 'Archery'").get(runId)
    expect(row.activity_id).toBe('act-archery')
    expect(row.preference_rank).toBe(2)
    expect(row.choice_id).toBe(archery.id)
    db.close()
  })

  // SOLVER PARITY on the row shape: choice_id names the choice the ACTIVITY
  // belongs to (commitElectiveRun takes it from the solver's labelKey), and
  // preference_rank is the CAMPER's rank. They are independent, so an unranked
  // manual placement keeps the choice and carries a null rank — writing both
  // null would make this handler's row a different shape from the solver's.
  it('keeps the matched choice with a null rank when the camper did not rank the activity moved to', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    // cam-2 ranked Archery only, and their solver row records exactly that.
    const before = db
      .prepare('SELECT * FROM elective_assignments WHERE id = ?')
      .get(deriveElectiveAssignmentId(runId, 'cam-2', 'occ-1'))
    expect(before.preference_rank).toBe(1)
    expect(before.choice_id).not.toBe(null)

    const out = move(db, runId, { camperId: 'cam-2', activityId: 'act-gaga' })
    expect(out.ok).toBe(true)

    const row = db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(out.assignmentId)
    const gaga = db.prepare("SELECT id FROM elective_choices WHERE run_id = ? AND label = 'Gaga'").get(runId)
    expect(row.activity_id).toBe('act-gaga')
    expect(row.preference_rank).toBe(null)
    expect(row.choice_id).toBe(gaga.id)
    db.close()
  })

  // Collision discipline: two choices in one run canonicalizing to one key are
  // AMBIGUOUS, and an ambiguous match is no match — never a guessed one.
  it('treats a canonically ambiguous choice label as no match rather than guessing', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    // 'Arch ery' keys the same as 'Archery' (whitespace is deleted, not
    // collapsed), so the run now holds two choices under one key.
    db.prepare('INSERT INTO elective_choices (id, run_id, label, is_linked) VALUES (?, ?, ?, 0)')
      .run(randomUUID(), runId, 'Arch ery')

    const out = move(db, runId)
    expect(out.ok).toBe(true)
    const row = db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(out.assignmentId)
    expect(row.choice_id).toBe(null)
    expect(row.preference_rank).toBe(null)
    db.close()
  })

  // FIX 2 (round 2). deriveElectiveAssignmentId's opaque() guard throws on a
  // malformed component. The declared failure shape is {ok:false, error:string}
  // — a rejected IPC promise is a different contract, and every caller that
  // reads result.error would see undefined instead.
  it('returns a refusal, not a throw, for a malformed id component', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    // A participant row for a camper id carrying a space, so the handler
    // reaches the derivation rather than refusing earlier.
    const camperId = 'cam 1'
    db.prepare('INSERT INTO elective_preferences (id, run_id, camper_id, occurrence_id, choice_id, rank) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), runId, camperId, 'occ-1', null, 1)

    let out
    expect(() => { out = move(db, runId, { camperId }) }).not.toThrow()
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/opaque id/)
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
