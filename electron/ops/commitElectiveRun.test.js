// T196/T226 — committing a parsed sheet and a solved assignment to the
// participant tables. Fixtures are fabricated; no real camper data is in this
// repo and none may be added.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun, describeElectiveRunRefusal } from './commitElectiveRun.js'
import { setElectiveAssignment } from './setElectiveAssignment.js'
import {
  deriveElectiveAssignmentId,
  deriveElectiveOccurrenceId,
  deriveLinkedElectiveChoiceId,
  electiveChoiceLabelKey,
} from './electiveDerivedIds.js'
import { buildElectiveAssignments } from '../../src/engine/buildElectiveAssignments.js'
import { deriveChoices } from '../../src/screens/elective/assignment/deriveChoices.js'
import {
  electiveGenerationVisibleFragment,
  electiveGenerationStaleSolverFragment,
} from './electiveGenerationPredicate.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-run-'))
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

const PARSED = {
  campers: [
    { id: 'cam-1', display_name: 'Ari Green', external_id: null, division: 'Arad' },
    { id: 'cam-2', display_name: 'Noa Katz', external_id: 'CM-2', division: 'Bogrim' },
  ],
  choices: [{ label: 'Archery', labelKey: 'archery' }, { label: 'Gaga', labelKey: 'gaga' }],
  preferences: [
    { camper_id: 'cam-1', occurrence_id: 'occ-1', label: 'Archery', labelKey: 'archery', rank: 1 },
    { camper_id: 'cam-2', occurrence_id: 'occ-1', label: 'Gaga', labelKey: 'gaga', rank: 1 },
  ],
  sameNameCampers: [],
  skippedRows: [],
}
const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: 'occ-1', labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1, flags: [] },
  { camper_id: 'cam-2', occurrence_id: 'occ-1', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1, flags: [] },
]
const OCCURRENCE_FIXTURE = [
  { id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
]

describe('commitElectiveRun', () => {
  it('writes the run, campers, choices, preferences and assignments', () => {
    const { db, campId } = freshDb()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 electives',
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(out.ok).toBe(true)
    const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    expect(count('elective_assignment_runs')).toBe(1)
    expect(count('campers')).toBe(2)
    expect(count('elective_choices')).toBe(2)
    expect(count('elective_preferences')).toBe(2)
    expect(count('elective_assignments')).toBe(2)

    // Assert the ROW, not the call: the values actually landed.
    const camper = db.prepare('SELECT * FROM campers WHERE id = ?').get('cam-1')
    expect(camper.display_name).toBe('Ari Green')
    expect(camper.camp_id).toBe(campId)
    const a = db.prepare('SELECT * FROM elective_assignments WHERE camper_id = ?').get('cam-1')
    expect(a.activity_id).toBe('act-archery')
    expect(a.preference_rank).toBe(1)
    expect(a.run_id).toBe(out.runId)
    db.close()
  })

  // The T226 property, enforced where it counts. A parser that reports the
  // collision is not enough if the writer accepts it anyway.
  it('refuses to commit a sheet with unresolved same-name campers', () => {
    const { db } = freshDb()
    const out = commitElectiveRun(db, {
      campId: 'x', deviceId: 'dev-1', name: 'n',
      parsed: { ...PARSED, sameNameCampers: [{ display_name: 'Ari Green', rowNumbers: [2, 3] }] },
      assignments: ASSIGNMENTS,
    })
    expect(out.ok).toBe(false)
    // The message must name the child and the rows — a director cannot act on
    // "an import error occurred".
    expect(out.error).toMatch(/more than one row/i)
    expect(out.error).toContain('Ari Green')
    expect(out.error).toContain('rows 2, 3')
    // L1 — "1 camper name(s) appear" reads wrong at count 1: singular noun,
    // singular verb.
    expect(out.error).toMatch(/^1 camper name appears\b/)
    // Nothing written — a refusal is a refusal.
    expect(db.prepare('SELECT COUNT(*) c FROM campers').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(0)
    db.close()
  })

  it('pluralizes the same-name refusal correctly at count 2', () => {
    const { db } = freshDb()
    const out = commitElectiveRun(db, {
      campId: 'x', deviceId: 'dev-1', name: 'n',
      parsed: {
        ...PARSED,
        sameNameCampers: [
          { display_name: 'Ari Green', rowNumbers: [2, 3] },
          { display_name: 'Noa Katz', rowNumbers: [5, 6] },
        ],
      },
      assignments: ASSIGNMENTS,
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/^2 camper names appear\b/)
    db.close()
  })

  it('refuses a sheet where one camper holds the same rank twice', () => {
    const { db } = freshDb()
    const out = commitElectiveRun(db, {
      campId: 'x', deviceId: 'dev-1', name: 'n',
      parsed: {
        ...PARSED,
        preferences: [
          { camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 },
          { camper_id: 'cam-1', label: 'Gaga', labelKey: 'gaga', rank: 1 },
        ],
      },
      assignments: [],
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/rank/i)
    expect(db.prepare('SELECT COUNT(*) c FROM campers').get().c).toBe(0)
    db.close()
  })

  // Every write goes through the op log, which is what makes it replicate and
  // what backs Trash/Restore and entity history.
  it('records every write in the op log', () => {
    const { db } = freshDb()
    commitElectiveRun(db, { campId: 'x', deviceId: 'dev-1', name: 'n', parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE })
    const ops = db.prepare("SELECT DISTINCT entity FROM operations WHERE entity LIKE '%camper%' OR entity LIKE 'elective_%'").all()
    expect(ops.map((o) => o.entity).sort()).toEqual([
      'campers', 'elective_assignment_runs', 'elective_assignments', 'elective_choices',
      'elective_occurrences', 'elective_preferences',
    ])
    db.close()
  })

  it('is atomic — a failure part-way leaves nothing behind', () => {
    const { db } = freshDb()
    const out = commitElectiveRun(db, {
      campId: 'x', deviceId: 'dev-1', name: 'n',
      parsed: PARSED,
      // An assignment naming a camper the sheet never contained.
      assignments: [{ ...ASSIGNMENTS[0], camper_id: 'ghost' }],
    })
    expect(out.ok).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM campers').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(0)
    db.close()
  })

  // T229 additive contract: occurrences, schedule linkage, and validation
  // that an assignment's occurrence actually exists.
  const OCCURRENCES = [
    { id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
  ]

  it('writes one elective_occurrences row per occurrence, and the run carries schedule linkage and the single tier', () => {
    const { db, campId } = freshDb()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1',
      parsed: PARSED, assignments: ASSIGNMENTS,
      occurrences: OCCURRENCES, scheduleWeekId: 'week-1', scheduleTemplateId: 'tpl-1',
    })
    expect(out.ok).toBe(true)
    const occRow = db.prepare('SELECT * FROM elective_occurrences WHERE id = ?').get('occ-1')
    expect(occRow).toMatchObject({ run_id: out.runId, elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' })
    const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(out.runId)
    expect(run.schedule_week_id).toBe('week-1')
    expect(run.schedule_template_id).toBe('tpl-1')
    expect(run.tier_id).toBe('tier-1')
    db.close()
  })

  it('leaves the run tier_id null when occurrences span more than one tier', () => {
    const { db, campId } = freshDb()
    const occs = [
      { id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
      { id: 'occ-2', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-2', tier_id: 'tier-2' },
    ]
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1',
      parsed: PARSED, assignments: [],
      occurrences: occs,
    })
    expect(out.ok).toBe(true)
    const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(out.runId)
    expect(run.tier_id).toBeNull()
    db.close()
  })

  // H1 — the renderer mints a runId per solve and passes it through, so a
  // retried commit of the SAME solve (double-tap, or a retry after a
  // transient failure) hits the SAME run row rather than minting a second one.
  it('uses a caller-supplied runId, so a retried commit of the same run is idempotent', () => {
    const { db, campId } = freshDb()
    const runId = 'run-caller-1'
    const first = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1',
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES, runId,
    })
    const second = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1',
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES, runId,
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.runId).toBe(runId)
    expect(second.runId).toBe(runId)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(1)
    db.close()
  })

  it('rejects a caller-supplied runId that is not an opaque id', () => {
    const { db, campId } = freshDb()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1',
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES, runId: 'has a space',
    })
    expect(out.ok).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(0)
    db.close()
  })

  it('throws (and rolls back) when an assignment names an occurrence not in the occurrence list', () => {
    const { db, campId } = freshDb()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1',
      parsed: PARSED, assignments: ASSIGNMENTS,
      occurrences: [], // occ-1 referenced by ASSIGNMENTS is unknown
    })
    expect(out.ok).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_occurrences').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM campers').get().c).toBe(0)
    db.close()
  })

  // T244 round 2 (Red Hat HIGH, docs/adr/2026-09-23-elective-run-lifecycle-
  // and-remaining-slices.md D5): the marker must be non-null and must match
  // on BOTH the run row and every solver-produced assignment row from the
  // same commit — a mismatch between the two halves is exactly the trap that
  // would instantly hide every solver row under the shared generation-
  // visibility predicate.
  it('stamps a non-null solver_generation on the run row and on every assignment row, matching', () => {
    const { db, campId } = freshDb()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 electives',
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(out.ok).toBe(true)

    const run = db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(out.runId)
    expect(run.solver_generation).toEqual(expect.any(String))
    expect(run.solver_generation.length).toBeGreaterThan(0)

    const assignments = db.prepare('SELECT solver_generation FROM elective_assignments WHERE run_id = ?').all(out.runId)
    expect(assignments.length).toBeGreaterThan(0)
    for (const a of assignments) expect(a.solver_generation).toBe(run.solver_generation)
  })

  // Regeneration = commitElectiveRun called again with the same runId (T199's
  // flow). Each call mints its OWN fresh marker — this is what leaves a
  // superseded generation's rows behind, unchanged, at their old marker,
  // which the shared predicate then treats as stale. No separate re-stamp
  // step exists or should be added (ADR decision (b)/Red Hat H3 deleted that
  // mechanism deliberately).
  it('regeneration (same runId, called again) mints a NEW generation, different from the first', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    const first = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(first.ok).toBe(true)
    const gen1 = db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(runId).solver_generation

    const second = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(second.ok).toBe(true)
    const gen2 = db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(runId).solver_generation

    expect(gen2).not.toBe(gen1)
    const assignments = db.prepare('SELECT solver_generation FROM elective_assignments WHERE run_id = ?').all(runId)
    for (const a of assignments) expect(a.solver_generation).toBe(gen2)
  })

  // T244 round 2 (Red Hat HIGH, the H2 hazard in miniature): a regeneration
  // against an EXISTING run must never re-assert status='draft' — that would
  // silently clobber an already-'final' status the moment a late-arriving
  // regeneration op (from another device that never saw the finalize) merges
  // in, via ordinary per-field LWW. status is only ever asserted on first
  // creation.
  it('does not touch status on a regeneration of an existing run — a final run stays final through it', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    const first = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(first.ok).toBe(true)
    db.prepare("UPDATE elective_assignment_runs SET status = 'final' WHERE id = ?").run(runId)

    const second = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(second.ok).toBe(true)

    const run = db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(runId)
    expect(run.status).toBe('final')
  })

  it('a genuinely NEW run (no existing row) still gets status=draft on its first commit', () => {
    const { db, campId } = freshDb()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1',
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(out.ok).toBe(true)
    const run = db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(out.runId)
    expect(run.status).toBe('draft')
  })

  // Backward compatibility: a run that existed before this fix has NULL on
  // the run row AND NULL on its assignment rows. Under `IS` (not `=`), NULL
  // matches NULL, so those pre-existing rows must stay fully visible under
  // the shared predicate rather than being hidden by the fix meant to
  // detect staleness.
  it('back-compat: a pre-existing run with NULL solver_generation on both halves still matches under IS', () => {
    const { db, campId } = freshDb()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Legacy run',
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(out.ok).toBe(true)
    // Simulate a pre-fix row: force both halves back to NULL, as a run
    // committed before this change would have on disk today.
    db.prepare('UPDATE elective_assignment_runs SET solver_generation = NULL WHERE id = ?').run(out.runId)
    db.prepare('UPDATE elective_assignments SET solver_generation = NULL WHERE run_id = ?').run(out.runId)

    const rows = db
      .prepare(`SELECT id FROM elective_assignments a WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}`)
      .all({ runId: out.runId, gen: null })
    expect(rows.length).toBe(ASSIGNMENTS.length)
    db.close()
  })

  // The MIXED legacy transition (Red Hat round 2, LOW — reasoned correct but
  // untested, which is the same gap category the round-1 HIGH came from). A
  // run committed BEFORE the stamping fix has NULL on both halves; the first
  // regeneration after the upgrade moves the RUN to a fresh uuid while any
  // old solver row the new solve does not re-write keeps its NULL. The
  // question this pins is whether such a row goes correctly STALE or is
  // silently lost: `NULL IS '<uuid>'` is false, so it is excluded from the
  // visible set and counted by the stale-solver fragment — stale, not lost.
  // A regression here is what a well-meaning `IS` -> `=` "cleanup" would
  // cause, and nothing else in the suite would catch it.
  it('legacy transition: regenerating a NULL-generation run leaves its untouched old rows stale, not lost', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    const first = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Legacy run', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(first.ok).toBe(true)
    // Force the pre-fix on-disk state: no marker anywhere.
    db.prepare('UPDATE elective_assignment_runs SET solver_generation = NULL WHERE id = ?').run(runId)
    db.prepare('UPDATE elective_assignments SET solver_generation = NULL WHERE run_id = ?').run(runId)

    // Regenerate with only ONE of the two campers, so cam-2's legacy row is
    // genuinely left untouched rather than overwritten by the same derived id.
    const second = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Legacy run', runId,
      parsed: PARSED, assignments: [ASSIGNMENTS[0]], occurrences: OCCURRENCE_FIXTURE,
    })
    expect(second.ok).toBe(true)

    const gen = db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(runId).solver_generation
    expect(gen).toEqual(expect.any(String))

    // The untouched legacy row still exists — it was not deleted.
    const legacy = db
      .prepare('SELECT solver_generation FROM elective_assignments WHERE run_id = ? AND camper_id = ?')
      .get(runId, 'cam-2')
    expect(legacy).toBeDefined()
    expect(legacy.solver_generation).toBeNull()

    // ...and it is excluded from the visible set, while the re-written row is in it.
    const visible = db
      .prepare(`SELECT camper_id FROM elective_assignments a WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}`)
      .all({ runId, gen })
      .map((r) => r.camper_id)
    expect(visible).toEqual(['cam-1'])

    // ...and it is counted as stale, not silently dropped from every tally.
    const stale = db
      .prepare(`SELECT COUNT(*) AS n FROM elective_assignments a WHERE a.run_id = :runId AND ${electiveGenerationStaleSolverFragment('a')}`)
      .get({ runId, gen })
    expect(stale.n).toBe(1)
    db.close()
  })

  // Documents the invariant the status guard rests on (Red Hat round 2, LOW).
  // The guard reads "a row exists LOCALLY" as "this is a regeneration". If a
  // future flow ever commits against a providedRunId this device has not
  // synced, that read is wrong and status is re-asserted as 'draft'. This
  // test states that behaviour deliberately, so such a flow breaks a named
  // expectation instead of silently reintroducing the reverted-status hazard.
  it('a providedRunId with no local row is treated as a CREATION (status=draft) — the guard is local-existence, not identity', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Never synced here', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(out.ok).toBe(true)
    const run = db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(runId)
    expect(run.status).toBe('draft')
  })

  // ---- T246: a locked row survives a regeneration, and a manual row pointing
  // at a deleted occurrence is reported rather than silently kept.
  //
  // `seedForLock` gives the move path what it validates against: the set, the
  // activities, and a confirmed unlimited offering for each.
  function seedForLock(db, campId) {
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
    for (const [activityId, name] of [['act-archery', 'Archery'], ['act-gaga', 'Gaga']]) {
      db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, name)
      db.prepare(
        'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, status) VALUES (?, ?, ?, ?, ?)'
      ).run(randomUUID(), 'set-1', activityId, 'unlimited', 'confirmed')
    }
  }

  it('leaves a locked row untouched when the same run is regenerated', () => {
    const { db, campId } = freshDb()
    seedForLock(db, campId)
    const runId = randomUUID()
    const commit = (assignments) => commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
      parsed: PARSED, assignments, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(commit(ASSIGNMENTS).ok).toBe(true)

    // The director moves cam-1 to Gaga and locks it.
    const moved = setElectiveAssignment(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-1', activityId: 'act-gaga',
      locked: true, deviceId: 'dev-1',
    })
    expect(moved.ok).toBe(true)
    const lockedId = deriveElectiveAssignmentId(runId, 'cam-1', 'occ-1')
    const read = () => db.prepare('SELECT source, is_locked, activity_id, solver_generation FROM elective_assignments WHERE id = ?').get(lockedId)
    const before = read()
    expect(before).toMatchObject({ source: 'manual', is_locked: 1, activity_id: 'act-gaga' })

    // Regeneration against the SAME runId, whose solver output puts cam-1 back
    // in Archery. The locked row must not be written at all.
    expect(commit(ASSIGNMENTS).ok).toBe(true)
    expect(read()).toEqual(before)
    // ...and the unlocked row WAS rewritten by this regeneration, so the test
    // is not passing because the commit did nothing.
    const other = db.prepare('SELECT source, solver_generation FROM elective_assignments WHERE id = ?')
      .get(deriveElectiveAssignmentId(runId, 'cam-2', 'occ-1'))
    expect(other.source).toBe('solver')
    expect(other.solver_generation).not.toBe(before.solver_generation)
  })

  it('reports a manual row whose occurrence no longer exists as DANGLING_MANUAL_ASSIGNMENT', () => {
    const { db, campId } = freshDb()
    seedForLock(db, campId)
    const runId = randomUUID()
    const GONE = [
      ...OCCURRENCE_FIXTURE,
      { id: 'occ-2', elective_set_id: 'set-1', day_id: 'day-2', time_block_id: 'tb-1', tier_id: 'tier-1' },
    ]
    const first = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: GONE,
    })
    expect(first.ok).toBe(true)
    expect(first.findings).toEqual([])

    // The director locks cam-1 into occ-2, then occ-2 is dropped from the
    // template — the regeneration below no longer derives it.
    const moved = setElectiveAssignment(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-2', activityId: 'act-gaga',
      locked: true, deviceId: 'dev-1',
    })
    expect(moved.ok).toBe(true)

    const again = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCE_FIXTURE,
    })
    expect(again.ok).toBe(true)
    expect(again.findings).toEqual([
      expect.objectContaining({
        kind: 'DANGLING_MANUAL_ASSIGNMENT',
        assignment_id: deriveElectiveAssignmentId(runId, 'cam-1', 'occ-2'),
        camper_id: 'cam-1',
        occurrence_id: 'occ-2',
      }),
    ])
    // The rest of the commit went through around it.
    expect(again.counts.assignments).toBe(ASSIGNMENTS.length)
    const survivor = db.prepare('SELECT source FROM elective_assignments WHERE id = ?')
      .get(deriveElectiveAssignmentId(runId, 'cam-2', 'occ-1'))
    expect(survivor.source).toBe('solver')
  })
})

// T265 ROUND 5 — owner ruling: "we are reading someone's data. we are not
// choosing how they import it." A whole-run ranked list (no occurrence_id at
// all) is exactly as legitimate a source shape as a per-cell grid. The round-3
// refusal below was WRONG under this ruling — it rejected a real camp's
// whole-run sheet as if it were malformed. Replaced by two tests: refusal
// no longer fires for an absent occurrence_id, and still fires for a
// genuinely malformed one (present but empty/wrong-typed).
describe('describeElectiveRunRefusal — whole-run fallback preferences are legitimate (T265 round 5)', () => {
  it('does NOT refuse a preference with no occurrence_id at all (a legitimate whole-run row)', () => {
    const parsed = {
      ...PARSED,
      preferences: [
        { camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 },
      ],
    }
    expect(describeElectiveRunRefusal(parsed)).toBeNull()
  })

  it('still refuses a preference whose occurrence_id is present but malformed (empty string)', () => {
    const parsed = {
      ...PARSED,
      preferences: [
        { camper_id: 'cam-1', occurrence_id: '', label: 'Archery', labelKey: 'archery', rank: 1 },
      ],
    }
    expect(describeElectiveRunRefusal(parsed)).not.toBeNull()
  })

  it('still refuses a preference whose occurrence_id is present but not a string', () => {
    const parsed = {
      ...PARSED,
      preferences: [
        { camper_id: 'cam-1', occurrence_id: 42, label: 'Archery', labelKey: 'archery', rank: 1 },
      ],
    }
    expect(describeElectiveRunRefusal(parsed)).not.toBeNull()
  })
})

// T265 ROUND 3 — Red Hat found this gap: no test exercised
// describeElectiveRunRefusal with the SAME camper ranking #1 in two DIFFERENT
// occurrences, which is the normal shape of a per-cell grid (ADR Decision 1),
// not a contradiction. Before the fix, hasContradictoryRanks' key had no
// occurrence dimension, so this call refused the ENTIRE run with a false
// claim. A unit test on hasContradictoryRanks alone would not have caught
// this — the bug was in what the CALLER fed it.
describe('describeElectiveRunRefusal — same camper, same rank, different occurrences (T265 round 3)', () => {
  it('does not refuse a camper ranking #1 in two different occurrences', () => {
    const parsed = {
      ...PARSED,
      preferences: [
        { camper_id: 'cam-1', occurrence_id: 'occ-mon-p3', label: 'Archery', labelKey: 'archery', rank: 1 },
        { camper_id: 'cam-1', occurrence_id: 'occ-mon-p6', label: 'Swim', labelKey: 'swim', rank: 1 },
      ],
    }
    expect(describeElectiveRunRefusal(parsed)).toBeNull()
  })

  it('still refuses a camper ranking #1 twice within the SAME occurrence', () => {
    const parsed = {
      ...PARSED,
      preferences: [
        { camper_id: 'cam-1', occurrence_id: 'occ-mon-p3', label: 'Archery', labelKey: 'archery', rank: 1 },
        { camper_id: 'cam-1', occurrence_id: 'occ-mon-p3', label: 'Gaga', labelKey: 'gaga', rank: 1 },
      ],
    }
    expect(describeElectiveRunRefusal(parsed)).not.toBeNull()
  })
})

// NON-VACUITY (T265 round 5). Round 1's fallback path in
// buildElectiveAssignments.js was only ever exercised by hand-built in-memory
// fixtures — the exact T62 failure shape this repo has already had once (an
// exclusion Set that was empty in production for a month behind a green unit
// test). This test writes a whole-run preference through the REAL write path
// (commitElectiveRun), reads the row back from SQLite exactly as any real
// caller would, and solves from what was read — proving a fallback row can
// actually exist end to end, not just inside a fixture literal.
//
// SYSTEM-LEVEL PREDICATE this proves: a whole-run (occurrence_id-less)
// preference (a) is accepted by the write path, (b) persists in
// elective_preferences with occurrence_id actually NULL (not discarded, not
// coerced to some placeholder), and (c) is honoured by the engine as a
// fallback for EVERY occurrence the camper attends that has no scoped row —
// the same rank in every one of them, because there is only one row to read.
describe('whole-run fallback preferences survive the real write path (T265 round 5, non-vacuity)', () => {
  it('writes a whole-run preference, reads it back, and the engine honours it as a fallback in every occurrence', () => {
    const { db, campId } = freshDb()
    const occurrences = [
      { id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
      { id: 'occ-2', elective_set_id: 'set-1', day_id: 'day-2', time_block_id: 'tb-1', tier_id: 'tier-1' },
    ]
    const parsed = {
      campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null }],
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      // NO occurrence_id at all — a whole-run ranked list, exactly the shape
      // a camp's third-party portal export or a paper ranked list produces.
      preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }],
      sameNameCampers: [],
      skippedRows: [],
    }

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Whole-run sheet',
      parsed, assignments: [], occurrences,
    })
    expect(out.ok).toBe(true)

    // (a)+(b): the row landed, and occurrence_id is genuinely NULL — not
    // discarded, not a placeholder string.
    const rows = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ?').all(out.runId)
    expect(rows.length).toBe(1)
    expect(rows[0].occurrence_id).toBeNull()
    expect(rows[0].camper_id).toBe('cam-1')
    expect(rows[0].rank).toBe(1)

    // (c): read the row back exactly as a caller would (raw columns, no
    // special-casing for "this one has no occurrence"), plus the choice it
    // points at, and solve.
    const choiceRow = db.prepare('SELECT * FROM elective_choices WHERE run_id = ?').get(out.runId)
    const readBackPreferences = rows.map((r) => ({
      camper_id: r.camper_id,
      choice_id: r.choice_id,
      occurrence_id: r.occurrence_id,
      rank: r.rank,
    }))

    const solved = buildElectiveAssignments({
      campers: [{ id: 'cam-1' }],
      occurrences: [{ id: 'occ-1' }, { id: 'occ-2' }],
      offerings: [
        { occurrence_id: 'occ-1', labelKey: electiveChoiceLabelKey(choiceRow.label), activity_id: 'act-archery', capacity: 5 },
        { occurrence_id: 'occ-2', labelKey: electiveChoiceLabelKey(choiceRow.label), activity_id: 'act-archery', capacity: 5 },
      ],
      preferences: readBackPreferences,
      choices: [{ id: choiceRow.id, labelKey: electiveChoiceLabelKey(choiceRow.label) }],
    })

    const byOcc = Object.fromEntries(solved.assignments.map((a) => [a.occurrence_id, a]))
    expect(byOcc['occ-1'].activity_id).toBe('act-archery')
    expect(byOcc['occ-1'].preference_rank).toBe(1)
    expect(byOcc['occ-2'].activity_id).toBe('act-archery')
    expect(byOcc['occ-2'].preference_rank).toBe(1)
    expect(byOcc['occ-1'].flags).toEqual([])
    expect(byOcc['occ-2'].flags).toEqual([])

    db.close()
  })
})

// T301 slice 3 (docs/adr/2026-09-29-linked-elective-bundles.md D6) — a
// director-authored bundle supersedes a plain sheet choice sharing its label:
// a camper's preference for that label must resolve to the bundle's own
// per-tier choice for the CAMPER'S OWN tier, never a separately-minted plain
// elective_choices row. Mechanism chosen: bundles are read from the db and
// re-derived fresh via deriveChoices (same module solve-time uses, per ADR
// D10 — never trust a stale definition), right here in commitElectiveRun,
// before the transaction opens.
function seedBundleFixture(db, campId, { scopeMode = 'all', bundleTiers = [] } = {}) {
  const tierId = 'tier-jr'
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(tierId, campId, 'Juniors')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run('grp-1', campId, 'Bunk 1', tierId)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Afternoon Electives')
  db.prepare(
    'INSERT INTO elective_bundles (id, elective_set_id, activity_id, name, scope_mode) VALUES (?, ?, ?, ?, ?)'
  ).run('bundle-1', 'set-1', 'act-archery', 'Archery', scopeMode)
  db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
    .run('bp-1', 'bundle-1', 'day-1', 'tb-1')
  db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
    .run('bp-2', 'bundle-1', 'day-1', 'tb-2')
  for (const t of bundleTiers) {
    db.prepare('INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES (?, ?, ?)').run(randomUUID(), 'bundle-1', t)
  }
  return { tierId }
}

// The occurrence ids MUST be the real derived ones, not convenient literals:
// deriveChoices computes each choiceOffering's occurrence_id via
// deriveElectiveOccurrenceId internally, so a hand-picked 'occ-1' would not
// match it and would trip tier 1's case (a) ("lists a period that is not
// part of this run") as a false positive in the FIXTURE, not a real defect.
// A function of runId, not a module-level constant, because the id is
// keyed on it.
function bundleOccurrences(runId) {
  return [
    {
      id: deriveElectiveOccurrenceId(runId, 'set-1', 'day-1', 'tb-1', 'tier-jr'),
      elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-jr',
    },
    {
      id: deriveElectiveOccurrenceId(runId, 'set-1', 'day-1', 'tb-2', 'tier-jr'),
      elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-2', tier_id: 'tier-jr',
    },
  ]
}

describe("T301 slice 3 (ADR D6) — a bundle's label supersedes a plain sheet choice", () => {
  it("routes a camper's preference for the bundle's label to the bundle's own per-tier choice, mints no plain choice for that label, and persists the bundle's member offerings", () => {
    const { db, campId } = freshDb()
    seedBundleFixture(db, campId)
    const runId = randomUUID()
    const parsed = {
      campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null, group_id: 'grp-1' }],
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }],
      sameNameCampers: [],
      skippedRows: [],
    }

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed, assignments: [], occurrences: bundleOccurrences(runId),
    })
    expect(out.ok).toBe(true)

    // D6: exactly ONE choice for this label — the bundle's, not a plain one.
    const choiceRows = db.prepare('SELECT * FROM elective_choices WHERE run_id = ?').all(out.runId)
    expect(choiceRows).toHaveLength(1)
    const expectedChoiceId = deriveLinkedElectiveChoiceId(out.runId, 'bundle-1', 'tier-jr')
    expect(choiceRows[0].id).toBe(expectedChoiceId)
    expect(choiceRows[0].is_linked).toBe(1)

    // The bundle's two member periods were persisted as real offerings —
    // slice 1 left this table's only writer a no-op parent stub (the ticket's
    // finding #3); this is the write path that finally exercises it.
    const offeringRows = db.prepare('SELECT * FROM elective_choice_offerings WHERE choice_id = ?').all(expectedChoiceId)
    expect(offeringRows).toHaveLength(2)
    expect(offeringRows.map((o) => o.activity_id)).toEqual(['act-archery', 'act-archery'])

    // The camper's preference resolved to the BUNDLE's choice.
    const prefRow = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ?').get(out.runId)
    expect(prefRow.choice_id).toBe(expectedChoiceId)
  })

  // T318 round 2 — CI found what the fixture above could not: it never
  // committed an ASSIGNMENT for the bundle-claimed label, only a preference.
  // The write loops are two separate blocks (preference ~:474, assignment
  // ~:590) and only the preference loop resolved a bundle label to the
  // camper's own tier's choice id; the assignment loop still read
  // `choiceIdByKey`, which line 468's `continue` never populates for a
  // bundle-claimed label — so a solver PLACEMENT on that label persisted with
  // `choice_id: null`. buildPreferenceLookup (camperElectiveWeek.js) keys on
  // (camper_id, choice_id, occurrence_id) and returns null outright when
  // choice_id is null, so every such placement read back with NO ordering
  // evidence — including a camper's actual rank-1 choice.
  it("persists the SOLVER'S ASSIGNMENT on a bundle-claimed label with the camper's own tier's bundle choice id, not null", () => {
    const { db, campId } = freshDb()
    seedBundleFixture(db, campId)
    const runId = randomUUID()
    const occurrences = bundleOccurrences(runId)
    const parsed = {
      campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null, group_id: 'grp-1' }],
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }],
      sameNameCampers: [],
      skippedRows: [],
    }
    const assignments = [
      { camper_id: 'cam-1', occurrence_id: occurrences[0].id, labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1, flags: [] },
    ]

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed, assignments, occurrences,
    })
    expect(out.ok).toBe(true)

    const expectedChoiceId = deriveLinkedElectiveChoiceId(out.runId, 'bundle-1', 'tier-jr')
    const assignmentRow = db
      .prepare('SELECT * FROM elective_assignments WHERE run_id = ? AND camper_id = ?')
      .get(out.runId, 'cam-1')
    expect(assignmentRow.choice_id).toBe(expectedChoiceId)
  })

  it("skips (never throws) a camper whose tier the bundle's scope does not cover, so one mismatch cannot fail the whole commit", () => {
    const { db, campId } = freshDb()
    // scope_mode 'all' still only resolves to tiers PRESENT in this run's
    // occurrences (ADR D2) — both fixture occurrences are Juniors-only, so an
    // UNTIERED camper (no group at all) matches no tier, the same real-world
    // shape as a camper the roster never assigned a bunk.
    seedBundleFixture(db, campId)
    const runId = randomUUID()
    const parsed = {
      campers: [
        { id: 'cam-1', display_name: 'Ari Green', external_id: null, group_id: 'grp-1' },
        { id: 'cam-2', display_name: 'Bo Katz', external_id: null, group_id: null },
      ],
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      preferences: [
        { camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 },
        { camper_id: 'cam-2', label: 'Archery', labelKey: 'archery', rank: 1 },
      ],
      sameNameCampers: [],
      skippedRows: [],
    }

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed, assignments: [], occurrences: bundleOccurrences(runId),
    })
    expect(out.ok).toBe(true)
    const prefRows = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ?').all(out.runId)
    expect(prefRows).toHaveLength(1)
    expect(prefRows[0].camper_id).toBe('cam-1')

    // Review round 2 — the skip is not silent: named per camper, like
    // PREFERENCE_EDIT_HELD above it, not summarized as a count.
    const mismatch = out.findings.find((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(mismatch).toBeTruthy()
    expect(mismatch.camper_id).toBe('cam-2')
    expect(mismatch.message).toContain('Bo Katz')
    expect(mismatch.message).toContain('Archery')
  })

  // T318 round 2 — the ASSIGNMENT-side mirror of the mismatch above.
  //
  // ROUND 2 CORRECTION. This test originally asserted a hard throw here, on
  // the premise that a solver placement naming a bundle-claimed label the
  // camper's own tier cannot resolve is unreachable ("the solver only ever
  // offers a camper a choice their own tier has"). Driving the real §6
  // acceptance fixture through this fix proved that premise false:
  // buildElectiveAssignments's `attends` predicate does not gate placement by
  // tier, so a camper whose sheet division matched no camp group (group_id
  // stays null, T279 §12.2a) is routinely FALLBACK-placed into whatever
  // capacity remains — including a bundle-claimed occurrence, exactly this
  // shape. A hard throw there failed the WHOLE commit over an ordinary roster
  // gap. So this now asserts the graceful-degrade the fix settled on instead:
  // the placement is real and is kept, its choice_id falls back to null
  // (never worse than the pre-fix baseline, and never wrongly non-null), and
  // the director is told via the same BUNDLE_TIER_NOT_COVERED finding the
  // preference loop already emits.
  it("falls back to a null choice_id (and reports BUNDLE_TIER_NOT_COVERED) when a solver assignment names a bundle-claimed label the camper's own tier does not cover", () => {
    const { db, campId } = freshDb()
    seedBundleFixture(db, campId)
    const runId = randomUUID()
    const occurrences = bundleOccurrences(runId)
    const parsed = {
      campers: [{ id: 'cam-2', display_name: 'Bo Katz', external_id: null, group_id: null }],
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      preferences: [],
      sameNameCampers: [],
      skippedRows: [],
    }
    const assignments = [
      { camper_id: 'cam-2', occurrence_id: occurrences[0].id, labelKey: 'archery', activity_id: 'act-archery', preference_rank: null, flags: [] },
    ]

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed, assignments, occurrences,
    })
    expect(out.ok).toBe(true)

    // The placement is real and is KEPT — the camper genuinely sits in this
    // seat — with choice_id null rather than a wrong or invented value.
    const row = db.prepare('SELECT * FROM elective_assignments WHERE run_id = ? AND camper_id = ?').get(runId, 'cam-2')
    expect(row).toBeTruthy()
    expect(row.activity_id).toBe('act-archery')
    expect(row.choice_id).toBeNull()

    const mismatch = out.findings.find((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(mismatch).toBeTruthy()
    expect(mismatch.camper_id).toBe('cam-2')
    expect(mismatch.message).toContain('Bo Katz')
  })

  it('a label no bundle claims still mints an ordinary plain choice, unaffected', () => {
    const { db, campId } = freshDb()
    seedBundleFixture(db, campId)
    const runId = randomUUID()
    const occurrences = bundleOccurrences(runId)
    const parsed = {
      campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null, group_id: 'grp-1' }],
      choices: [{ label: 'Archery', labelKey: 'archery' }, { label: 'Gaga', labelKey: 'gaga' }],
      preferences: [{ camper_id: 'cam-1', occurrence_id: occurrences[0].id, label: 'Gaga', labelKey: 'gaga', rank: 1 }],
      sameNameCampers: [],
      skippedRows: [],
    }
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed, assignments: [], occurrences,
    })
    expect(out.ok).toBe(true)
    const gagaChoice = db.prepare('SELECT * FROM elective_choices WHERE label = ?').get('Gaga')
    expect(gagaChoice).toBeTruthy()
    expect(gagaChoice.is_linked).toBe(0)
  })
})

// T301 slice 3 — the invariant the ticket exists to prove: a bundle must
// place identically whether the solve runs on the freshly-parsed path or on
// a re-solve from stored rows (AssignmentPanel.jsx's `solve()`, both call
// sites). Exercises the same two engine-call SHAPES AssignmentPanel.jsx
// builds — deriveChoices called fresh plus each path's own choices source —
// against the REAL write/read-back path in between, so this is not only an
// engine fixture claim but a claim about what actually round-trips through
// SQLite.
describe('T301 slice 3 — a bundle places identically on the parsed-first-solve path and the re-solve-from-stored-rows path', () => {
  it('produces the same elective_assignments both ways', () => {
    const { db, campId } = freshDb()
    seedBundleFixture(db, campId)
    const runId = randomUUID()
    const bundleTables = {
      bundles: [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-archery', name: 'Archery', scope_mode: 'all' }],
      bundlePeriods: [
        { bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' },
        { bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-2' },
      ],
      bundleTiers: [],
    }
    const occurrences = bundleOccurrences(runId)
    const offerings = [
      { occurrence_id: occurrences[0].id, labelKey: 'archery', activity_id: 'act-archery', capacity: 5 },
      { occurrence_id: occurrences[1].id, labelKey: 'archery', activity_id: 'act-archery', capacity: 5 },
    ]
    const parsed = {
      campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null, group_id: 'grp-1' }],
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      preferences: [{ camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 }],
      sameNameCampers: [],
      skippedRows: [],
    }

    // ---- PATH 1: parsed-first-solve shape. deriveChoices called fresh,
    // unioned with nothing (no runChoices exist yet — first solve). ----
    const firstDerivation = deriveChoices({ ...bundleTables, occurrences, runId })
    const firstSolve = buildElectiveAssignments({
      campers: parsed.campers,
      occurrences,
      offerings,
      preferences: parsed.preferences,
      choices: firstDerivation.choices,
      choiceOfferings: firstDerivation.choiceOfferings,
    })
    expect(firstSolve.findings).toEqual([])
    // All-or-nothing (ADR success predicate): both member periods, one camper.
    expect(firstSolve.assignments).toHaveLength(2)
    expect(firstSolve.assignments.every((a) => a.camper_id === 'cam-1' && a.activity_id === 'act-archery')).toBe(true)

    // ---- COMMIT: the real write path, including the D6 mechanism under test. ----
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed, assignments: firstSolve.assignments, occurrences,
    })
    expect(out.ok).toBe(true)

    // A NO-CONTENTION fixture (one camper, no competing rank) cannot tell
    // "routed to the bundle's tier-1 choice" apart from "fell through to
    // tier 2 and got placed anyway" by assignments alone — both land the
    // same camper in both periods either way. This is the assertion that
    // actually distinguishes them: the persisted preference's choice_id must
    // be the BUNDLE's, not a plain fallback's, independent of what the
    // solver did with it.
    const persistedChoiceId = db.prepare('SELECT choice_id FROM elective_preferences WHERE run_id = ?').get(runId).choice_id
    expect(persistedChoiceId).toBe(deriveLinkedElectiveChoiceId(runId, 'bundle-1', 'tier-jr'))

    // ---- PATH 2: re-solve-from-stored-rows shape. deriveChoices called
    // fresh AGAIN (D10 — never read a bundle's definition back from storage),
    // unioned with the run's OWN persisted choices, against preferences read
    // back exactly as getElectiveRunHandler/AssignmentPanel's regenerate do. ----
    const secondDerivation = deriveChoices({ ...bundleTables, occurrences, runId })
    const runChoiceRows = db.prepare('SELECT id, label, is_linked FROM elective_choices WHERE run_id = ?').all(runId)
    const runPreferenceRows = db
      .prepare('SELECT camper_id, choice_id, occurrence_id, rank FROM elective_preferences WHERE run_id = ?')
      .all(runId)

    const secondSolve = buildElectiveAssignments({
      campers: parsed.campers,
      occurrences,
      offerings,
      preferences: runPreferenceRows,
      choices: [
        ...secondDerivation.choices,
        ...runChoiceRows.map((c) => ({ id: c.id, labelKey: electiveChoiceLabelKey(c.label), is_linked: c.is_linked ?? 0 })),
      ],
      choiceOfferings: secondDerivation.choiceOfferings,
    })
    expect(secondSolve.findings).toEqual([])

    const norm = (list) =>
      [...list]
        .map((a) => ({ camper_id: a.camper_id, occurrence_id: a.occurrence_id, activity_id: a.activity_id, preference_rank: a.preference_rank }))
        .sort((a, b) => (a.occurrence_id < b.occurrence_id ? -1 : a.occurrence_id > b.occurrence_id ? 1 : 0))
    expect(norm(secondSolve.assignments)).toEqual(norm(firstSolve.assignments))

    db.close()
  })
})
