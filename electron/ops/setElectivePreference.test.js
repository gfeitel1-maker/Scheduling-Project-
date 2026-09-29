// T297 — the preference EDIT write path. Fixtures are fabricated; no real
// camper data is in this repo and none may be added.
//
// THE FIXTURE IS A PLANNER GRID, NOT A RANKED TABLE, and that is the whole
// point of it. `commit()` (AssignmentPanel) passes the UNRESOLVED `parsed`, and
// coordinate->occurrence binding is solve-time and template-scoped
// (resolvePreferenceCoordinates.js), so a planner sheet's stored rows carry
// `occurrence_id` NULL and a coordinate instead. An edit that superseded only
// rows matching `occurrence_id` would therefore leave the imported row live,
// both rows would resolve to the same cell at solve time, and the director's
// correction would tie with the value they were correcting — silently defeated.
// Two further teeth: the sheet writes the day lowercase and the period as a
// bare number while the camp names them 'Monday' and 'Period 1', so an exact
// string match on the labels also fails to find the row.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { setElectivePreference, removeElectivePreference } from './setElectivePreference.js'
import { deriveElectiveChoiceId } from './electiveDerivedIds.js'
import { isHumanOwned } from './fieldProvenance.js'
import { DELETE_FIELD, latestOp } from './operations.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-setpref-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-mon', campId, 'Monday')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-tue', campId, 'Tuesday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-1', campId, 'Period 1')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-2', campId, 'Period 2')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

// The camp calls them 'Monday'/'Period 1'; the child wrote 'monday'/'1'.
const MON_P1 = { dayName: 'monday', periodLabel: '1' }
const TUE_P2 = { dayName: 'Tuesday', periodLabel: 'Period 2' }

const PARSED = {
  campers: [
    { id: 'cam-1', display_name: 'Ari Green', external_id: null },
    { id: 'cam-2', display_name: 'Noa Katz', external_id: 'CM-2' },
    // cam-3 answered the OTHER way a real sheet can be shaped: a whole-run
    // ranked list, no cell named. Present so the scope-inheritance case has a
    // row of that shape to correct.
    { id: 'cam-3', display_name: 'Tal Bar', external_id: 'CM-3' },
  ],
  choices: [
    { label: 'Gaga', labelKey: 'gaga' },
    { label: 'Archery', labelKey: 'archery' },
    { label: 'Ceramics', labelKey: 'ceramics' },
  ],
  // PLANNER GRID: a cell is CHOSEN, rank 1 by construction, occurrence_id
  // absent because no template existed when the sheet was read.
  preferences: [
    { camper_id: 'cam-1', occurrence_id: null, coordinate: MON_P1, label: 'Gaga', labelKey: 'gaga', rank: 1, rank_kind: 'cell-choice' },
    { camper_id: 'cam-2', occurrence_id: null, coordinate: TUE_P2, label: 'Ceramics', labelKey: 'ceramics', rank: 1, rank_kind: 'cell-choice' },
    { camper_id: 'cam-3', occurrence_id: null, coordinate: null, label: 'Gaga', labelKey: 'gaga', rank: 1, rank_kind: 'ordered-fallback' },
  ],
  sameNameCampers: [],
  skippedRows: [],
}
const OCCURRENCES = [
  { id: 'occ-a', elective_set_id: 'set-1', day_id: 'day-mon', time_block_id: 'tb-1', tier_id: 'tier-1' },
  { id: 'occ-b', elective_set_id: 'set-1', day_id: 'day-tue', time_block_id: 'tb-2', tier_id: 'tier-1' },
]
const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: 'occ-a', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 },
  { camper_id: 'cam-2', occurrence_id: 'occ-b', labelKey: 'ceramics', activity_id: 'act-ceramics', preference_rank: 1 },
  { camper_id: 'cam-3', occurrence_id: 'occ-a', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 },
]

function seedRun(db, campId) {
  const runId = randomUUID()
  const out = commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
    parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES,
  })
  // toMatchObject, not `out.ok === true`: a refusal prints its own reason, so a
  // broken fixture says what is wrong instead of only that something is.
  expect(out).toMatchObject({ ok: true })
  for (const [activityId, name] of [['act-gaga', 'Gaga'], ['act-archery', 'Archery'], ['act-ceramics', 'Ceramics']]) {
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, name)
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, status) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), 'set-1', activityId, 'unlimited', 'confirmed')
  }
  return runId
}

const prefsFor = (db, runId, camperId) =>
  db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').all(runId, camperId)

describe('setElectivePreference', () => {
  it('supersedes the coordinate-only imported row for that cell instead of adding a second one', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const ceramics = deriveElectiveChoiceId(runId, 'ceramics')

    // Before: exactly the imported Gaga row, coordinate-keyed, no occurrence.
    const before = prefsFor(db, runId, 'cam-1')
    expect(before).toHaveLength(1)
    expect(before[0].occurrence_id).toBe(null)

    const out = setElectivePreference(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-a', choiceId: ceramics,
      rank: 1, rankKind: 'cell-choice', deviceId: 'dev-1',
    })
    expect(out.ok).toBe(true)

    // THE ASSERTION THAT MATTERS: one row for that cell, naming Ceramics. A
    // surviving Gaga row would tie with it at solve time.
    const after = prefsFor(db, runId, 'cam-1')
    expect(after).toHaveLength(1)
    expect(after[0].choice_id).toBe(ceramics)
    expect(after[0].occurrence_id).toBe('occ-a')
  })

  it('leaves the same camper’s OTHER cells alone', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const archery = deriveElectiveChoiceId(runId, 'archery')

    // cam-1 also wrote a Tuesday cell, so there is something to preserve.
    const mondayGaga = prefsFor(db, runId, 'cam-1')[0]
    expect(mondayGaga.coordinate_day_label).toBe('monday')

    const out = setElectivePreference(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-b', choiceId: archery,
      rank: 1, rankKind: 'cell-choice', deviceId: 'dev-1',
    })
    expect(out.ok).toBe(true)

    const after = prefsFor(db, runId, 'cam-1')
    expect(after).toHaveLength(2)
    expect(after.find((r) => r.occurrence_id === 'occ-b').choice_id).toBe(archery)
    // The Monday row is untouched — same id, same choice.
    expect(after.find((r) => r.id === mondayGaga.id).choice_id).toBe(mondayGaga.choice_id)
  })

  it('records the cell’s coordinate as the camp names it, so the row is legible without a template', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const out = setElectivePreference(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-a',
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rankKind: 'cell-choice', deviceId: 'dev-1',
    })
    expect(out.ok).toBe(true)
    const row = prefsFor(db, runId, 'cam-1')[0]
    expect(row.coordinate_day_label).toBe('Monday')
    expect(row.coordinate_period_label).toBe('Period 1')
    expect(row.rank).toBe(1)
    expect(row.rank_kind).toBe('cell-choice')
  })

  it('stamps every field human-owned, and an imported row is not', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const imported = prefsFor(db, runId, 'cam-2')[0]
    // The import must hand ownership to the importer, or the marker means
    // nothing: appendOp defaults source=null and isHumanOwned decodes NULL as
    // human, so an unstamped import would read as a director's edit.
    expect(isHumanOwned(db, 'elective_preferences', imported.id, 'choice_id')).toBe(false)

    const out = setElectivePreference(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-a',
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rankKind: 'cell-choice', deviceId: 'dev-1',
    })
    expect(out.ok).toBe(true)
    for (const field of ['choice_id', 'rank', 'occurrence_id']) {
      expect(isHumanOwned(db, 'elective_preferences', out.preferenceId, field)).toBe(true)
    }
  })

  // THE CASE THAT CHANGED THE DESIGN. A whole-run ranked list ("Gaga 1st,
  // Archery 2nd") has occurrence_id NULL and NO coordinate. Correcting it with a
  // CELL-scoped row would leave the Gaga fallback live at rank 1 beside a
  // cell-scoped Ceramics at rank 1, and the engine's rankAt has no reason to
  // prefer either — two different choices at equal rank simply tie, so the
  // correction could lose to the value being corrected. Inheriting the replaced
  // row's scope is what makes a whole-run correction actually take effect.
  it('inherits the scope of the row being corrected, so a whole-run answer stays whole-run', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    // cam-2's row is the whole-run kind: no occurrence, no coordinate.
    const wholeRun = db
      .prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?')
      .get(runId, 'cam-3')
    expect(wholeRun.occurrence_id).toBe(null)
    expect(wholeRun.coordinate_day_label).toBe(null)

    const out = setElectivePreference(db, {
      runId, camperId: 'cam-3', occurrenceId: 'occ-a',
      choiceId: deriveElectiveChoiceId(runId, 'archery'),
      rank: 2, rankKind: 'ordered-fallback',
      replacesPreferenceId: wholeRun.id,
      deviceId: 'dev-1',
    })
    expect(out).toMatchObject({ ok: true })

    const after = prefsFor(db, runId, 'cam-3')
    expect(after).toHaveLength(1)
    expect(after[0].choice_id).toBe(deriveElectiveChoiceId(runId, 'archery'))
    // STILL whole-run. An occurrence_id here would be this function imposing a
    // cell on an answer that named none.
    expect(after[0].occurrence_id).toBe(null)
    expect(after[0].coordinate_day_label).toBe(null)
    expect(after[0].rank).toBe(2)
    expect(after[0].rank_kind).toBe('ordered-fallback')
  })

  it('a replace touches only the named row, leaving the camper’s other answers alone', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const monday = prefsFor(db, runId, 'cam-1').find((r) => r.coordinate_day_label === 'monday')

    const out = setElectivePreference(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-a',
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rankKind: 'cell-choice',
      replacesPreferenceId: monday.id,
      deviceId: 'dev-1',
    })
    expect(out).toMatchObject({ ok: true, supersededIds: [monday.id] })

    const after = prefsFor(db, runId, 'cam-1')
    expect(after).toHaveLength(1)
    // The coordinate the CHILD wrote is carried over, not rewritten to the
    // camp's spelling: this is a correction of their statement, not a new one.
    expect(after[0].coordinate_day_label).toBe('monday')
    expect(after[0].coordinate_period_label).toBe('1')
  })

  it('refuses to correct a row belonging to another camper', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const othersRow = prefsFor(db, runId, 'cam-2')[0]
    expect(setElectivePreference(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-a',
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rankKind: 'cell-choice',
      replacesPreferenceId: othersRow.id,
      deviceId: 'dev-1',
    })).toEqual({ ok: false, error: 'PREFERENCE_NOT_IN_RUN' })
  })

  it('refuses a finalized run, a choice this run does not know, and an occurrence from elsewhere', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const ceramics = deriveElectiveChoiceId(runId, 'ceramics')
    const base = { runId, camperId: 'cam-1', occurrenceId: 'occ-a', choiceId: ceramics, rank: 1, rankKind: 'cell-choice', deviceId: 'dev-1' }

    expect(setElectivePreference(db, { ...base, choiceId: 'echo1:nope' }))
      .toEqual({ ok: false, error: 'CHOICE_NOT_IN_RUN' })
    expect(setElectivePreference(db, { ...base, occurrenceId: 'occ-elsewhere' }))
      .toEqual({ ok: false, error: 'OCCURRENCE_NOT_IN_RUN' })
    expect(setElectivePreference(db, { ...base, camperId: 'cam-stranger' }))
      .toEqual({ ok: false, error: 'CAMPER_NOT_IN_RUN' })

    db.prepare("UPDATE elective_assignment_runs SET status = 'final' WHERE id = ?").run(runId)
    expect(setElectivePreference(db, base)).toEqual({ ok: false, error: 'RUN_NOT_DRAFT' })
  })
})

describe('removeElectivePreference', () => {
  it('removes the row and leaves a human tombstone, so a re-import cannot quietly re-create it', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const row = prefsFor(db, runId, 'cam-1')[0]

    const out = removeElectivePreference(db, { runId, preferenceId: row.id, deviceId: 'dev-1' })
    expect(out.ok).toBe(true)
    expect(prefsFor(db, runId, 'cam-1')).toHaveLength(0)

    // The precedent is ingest.js's rejectedSlotKeys: a director's deliberate
    // deletion is an EXPLICIT source==='human' DELETE_FIELD op, which an
    // import teardown's null-source delete is excluded from by a === check.
    const latest = latestOp(db, 'elective_preferences', row.id, DELETE_FIELD)
    expect(latest?.source).toBe('human')
  })

  it('refuses a preference from another run and a finalized run', () => {
    const { db, campId } = freshDb()
    const runId = seedRun(db, campId)
    const row = prefsFor(db, runId, 'cam-1')[0]

    expect(removeElectivePreference(db, { runId, preferenceId: 'pref-nope', deviceId: 'dev-1' }))
      .toEqual({ ok: false, error: 'PREFERENCE_NOT_IN_RUN' })

    db.prepare("UPDATE elective_assignment_runs SET status = 'final' WHERE id = ?").run(runId)
    expect(removeElectivePreference(db, { runId, preferenceId: row.id, deviceId: 'dev-1' }))
      .toEqual({ ok: false, error: 'RUN_NOT_DRAFT' })
  })
})
