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
})
