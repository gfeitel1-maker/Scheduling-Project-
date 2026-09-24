// T196/T226 — committing a parsed sheet and a solved assignment to the
// participant tables. Fixtures are fabricated; no real camper data is in this
// repo and none may be added.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
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
    { camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 },
    { camper_id: 'cam-2', label: 'Gaga', labelKey: 'gaga', rank: 1 },
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
})
