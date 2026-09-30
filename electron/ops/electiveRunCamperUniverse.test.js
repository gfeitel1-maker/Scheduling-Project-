// @vitest-environment node
//
// T320 part 2 item 3 (docs/adr/2026-09-30-elective-run-durability.md) — the
// run's camper universe, made true. getElectiveRun derived it as
// (preferences ∪ assignments), so a camper who was on the director's sheet and
// ranked nothing was invisible to a cold regenerate. commitElectiveRun now
// writes one elective_run_findings row of kind SHEET_CAMPER_WITHOUT_PREFERENCE
// for each of them, and the read joins it in.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { getElectiveRun } from './getElectiveRun.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-universe-'))
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

// cam-3 is on the sheet and in NEITHER parsed.preferences nor assignments.
const PARSED = {
  campers: [
    { id: 'cam-1', display_name: 'Ari Green', external_id: null },
    { id: 'cam-2', display_name: 'Noa Katz', external_id: null },
    { id: 'cam-3', display_name: 'Tal Bar', external_id: null },
  ],
  choices: [{ label: 'Archery', labelKey: 'archery' }, { label: 'Gaga', labelKey: 'gaga' }],
  preferences: [
    { camper_id: 'cam-1', occurrence_id: 'occ-1', label: 'Archery', labelKey: 'archery', rank: 1 },
  ],
  sameNameCampers: [],
  skippedRows: [],
}
const ASSIGNMENTS = [
  { camper_id: 'cam-2', occurrence_id: 'occ-1', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: null, flags: [] },
]
const OCCURRENCES = [{ id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' }]

function commit(db, campId, runId, extra = {}) {
  return commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1', runId,
    parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES, ...extra,
  })
}

describe('getElectiveRun — the sheet is the run\'s camper universe', () => {
  it('a sheet camper with neither a preference nor a placement is in campers, and named by sheetOnlyCampers', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    expect(commit(db, campId, runId).ok).toBe(true)

    // The ROW the derivation now rests on, asserted directly.
    const finding = db
      .prepare("SELECT camper_id, message FROM elective_run_findings WHERE run_id = ? AND kind = 'SHEET_CAMPER_WITHOUT_PREFERENCE'")
      .all(runId)
    expect(finding.map((f) => f.camper_id)).toEqual(['cam-3'])
    expect(finding[0].message).toMatch(/no ranked choice and no placement/)

    const out = getElectiveRun(db, { runId })
    expect(out.campers.map((c) => c.id).sort()).toEqual(['cam-1', 'cam-2', 'cam-3'])
    expect(out.sheetOnlyCampers).toEqual(['cam-3'])
    db.close()
  })

  it('the roster is CUMULATIVE across generations: a camper recorded on one generation survives the next', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    expect(commit(db, campId, runId).ok).toBe(true)
    const gen1 = db.prepare('SELECT solver_generation g FROM elective_assignment_runs WHERE id = ?').get(runId).g

    // A regeneration whose sheet no longer mentions cam-3 at all, so NO roster
    // row is written for the new generation. cam-3 was in scope for this run
    // and stays in scope: a roster is cumulative across generations by
    // definition, which is why the roster UNION arm carries no generation
    // filter (unlike eligibilityFindings).
    const narrowed = { ...PARSED, campers: PARSED.campers.filter((c) => c.id !== 'cam-3') }
    expect(commit(db, campId, runId, { parsed: narrowed }).ok).toBe(true)
    const gen2 = db.prepare('SELECT solver_generation g FROM elective_assignment_runs WHERE id = ?').get(runId).g
    expect(gen2).not.toBe(gen1)
    expect(db.prepare(
      "SELECT COUNT(*) c FROM elective_run_findings WHERE run_id = ? AND solver_generation = ? AND kind = 'SHEET_CAMPER_WITHOUT_PREFERENCE'"
    ).get(runId, gen2).c).toBe(0)

    const out = getElectiveRun(db, { runId })
    expect(out.campers.map((c) => c.id).sort()).toEqual(['cam-1', 'cam-2', 'cam-3'])
    expect(out.sheetOnlyCampers).toEqual(['cam-3'])
    db.close()
  })

  it('the roster kind is NOT in the eligibility bucket', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    expect(commit(db, campId, runId).ok).toBe(true)
    const out = getElectiveRun(db, { runId })
    expect(out.eligibilityFindings.map((f) => f.kind)).not.toContain('SHEET_CAMPER_WITHOUT_PREFERENCE')
    db.close()
  })
})
