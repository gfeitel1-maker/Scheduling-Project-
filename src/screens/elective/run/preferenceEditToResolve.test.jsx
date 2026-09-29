// @vitest-environment jsdom
//
// T297's archive_when, the clause that cannot be faked:
//
//   "a test drives the real path from edit to re-solve and asserts the changed
//    placement"
//
// WHAT IS REAL HERE. The run is written to a real SQLite file by the real
// commitElectiveRun op. The edit goes through the real setElectivePreference op,
// reached by CLICKING the real affordance on the real CamperWeekPanel inside the
// real DraftRunView — the path a director actually uses, not a direct call. The
// re-solve runs the real resolvePreferenceCoordinates and the real
// buildElectiveAssignments over preferences read back out of that SQLite file.
// The assertion is the PLACEMENT the engine produces, before and after.
//
// localClient is stubbed, and that is the architecture rather than a shortcut:
// the renderer never touches SQLite (CLAUDE.md), so IPC is the only seam a jsdom
// test can stand at. Each stub calls the real op or the real query behind it and
// invents nothing.
//
// THE FIXTURE IS A PLANNER GRID. A ranked-table fixture would exercise a
// different and easier path — T296's ordering assertion was vacuous for exactly
// that kind of reason — and the planner path is where the stored row carries a
// coordinate instead of an occurrence, which is what an edit has to recognise.
// The child writes the day lowercase and the period as a bare number while the
// camp says 'Monday' and 'Period 1'.
//
// Fabricated names only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../../../../electron/db/localDb.js'
import { commitElectiveRun } from '../../../../electron/ops/commitElectiveRun.js'
import { setElectivePreference, removeElectivePreference } from '../../../../electron/ops/setElectivePreference.js'
import { deriveElectiveChoiceId } from '../../../../electron/ops/electiveDerivedIds.js'
import { buildElectiveAssignments } from '../../../engine/buildElectiveAssignments.js'
import { resolvePreferenceCoordinates } from '../assignment/resolvePreferenceCoordinates.js'
import { buildOfferings } from '../assignment/buildOfferings.js'
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'

vi.mock('../../../localClient', () => ({
  localClient: {
    getElectiveRun: vi.fn(),
    setElectivePreference: vi.fn(),
    removeElectivePreference: vi.fn(),
    setElectiveAssignment: vi.fn(),
  },
}))

import { localClient } from '../../../localClient'
import DraftRunView from './DraftRunView.jsx'

const DAYS = [{ id: 'day-mon', label: 'Monday', sort_order: 1 }]
const TIME_BLOCKS = [{ id: 'tb-1', name: 'Period 1', sort_order: 1 }]
const ACTIVITIES = [
  { id: 'act-gaga', name: 'Gaga' },
  { id: 'act-ceramics', name: 'Ceramics' },
]
const SET_ACTIVITIES = [
  { id: 'esa-1', elective_set_id: 'set-1', activity_id: 'act-gaga', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null },
  { id: 'esa-2', elective_set_id: 'set-1', activity_id: 'act-ceramics', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null },
]
const OCCURRENCES = [
  { id: 'occ-a', elective_set_id: 'set-1', day_id: 'day-mon', time_block_id: 'tb-1', tier_id: 'tier-1' },
]

let dir
let db
let campId
let runId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t297-loop-'))
  db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-mon', campId, 'Monday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-1', campId, 'Period 1')
  for (const a of ACTIVITIES) {
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(a.id, campId, a.name)
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, status) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), 'set-1', a.id, 'unlimited', 'confirmed')
  }

  runId = randomUUID()
  const out = commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
    parsed: {
      campers: [{ id: 'cam-1', display_name: 'Testcamper Alpha', external_id: null }],
      choices: [{ label: 'Gaga', labelKey: 'gaga' }, { label: 'Ceramics', labelKey: 'ceramics' }],
      preferences: [{
        camper_id: 'cam-1', occurrence_id: null,
        coordinate: { dayName: 'monday', periodLabel: '1' },
        label: 'Gaga', labelKey: 'gaga', rank: 1, rank_kind: 'cell-choice',
      }],
      sameNameCampers: [],
      skippedRows: [],
    },
    assignments: [{ camper_id: 'cam-1', occurrence_id: 'occ-a', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 }],
    occurrences: OCCURRENCES,
  })
  expect(out).toMatchObject({ ok: true })

  // The stubs each stand in front of the REAL thing.
  localClient.getElectiveRun.mockImplementation(async () => readRun())
  localClient.setElectivePreference.mockImplementation(async (args) =>
    setElectivePreference(db, { ...args, deviceId: 'dev-1' }))
  localClient.removeElectivePreference.mockImplementation(async (args) =>
    removeElectivePreference(db, { ...args, deviceId: 'dev-1' }))
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

// The same projection getElectiveRunHandler performs (electron/main.js), run
// against this file. Not a hand-written payload: the point is that what the
// screen reads is what the database holds.
function readRun() {
  const rows = db
    .prepare(
      `SELECT a.id, a.occurrence_id, a.camper_id, a.activity_id, a.preference_rank,
              a.source, a.is_locked, a.choice_id, c.display_name AS camper_name
         FROM elective_assignments a
         LEFT JOIN campers c ON c.id = a.camper_id
        WHERE a.run_id = ? ORDER BY a.occurrence_id`
    )
    .all(runId)
  const preferences = db
    .prepare(
      `SELECT id, camper_id, choice_id, occurrence_id, rank, rank_kind,
              coordinate_day_label, coordinate_period_label
         FROM elective_preferences WHERE run_id = ? ORDER BY id`
    )
    .all(runId)
    .map((p) => ({
      id: p.id, camper_id: p.camper_id, choice_id: p.choice_id, occurrence_id: p.occurrence_id,
      rank: p.rank, rank_kind: p.rank_kind,
      coordinate: p.coordinate_day_label == null && p.coordinate_period_label == null
        ? null
        : { dayName: p.coordinate_day_label, periodLabel: p.coordinate_period_label },
    }))
  return {
    rows,
    occurrences: db.prepare('SELECT id, elective_set_id, day_id, time_block_id, tier_id FROM elective_occurrences WHERE run_id = ? ORDER BY id').all(runId),
    preferences,
    choices: db.prepare('SELECT id, label, is_linked FROM elective_choices WHERE run_id = ? ORDER BY label').all(runId),
    staleCount: 0,
    finalizedAgainstStaleGeneration: false,
    overCapacityOccurrences: [],
  }
}

/**
 * The re-solve, exactly as AssignmentPanel's solve() composes it: resolve each
 * preference's coordinate against this template's occurrences, then run the
 * engine. Fed from the DATABASE rather than from a parsed sheet — which is the
 * whole point of the ticket, since no file is re-imported.
 */
function resolveFromDatabase() {
  const { preferences, choices } = readRun()
  // EXACTLY AssignmentPanel's solve() composition on the re-solve path: the
  // stored rows unchanged, plus the run's choices mapped to {id, labelKey} so the
  // engine can resolve each row's choice_id. Remapping the preferences instead
  // would prove a route the app does not take — and the engine would rank nothing
  // if `choices` were omitted, which is the failure this composition exists to
  // avoid.
  const resolved = resolvePreferenceCoordinates({
    preferences, occurrences: OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS, templateId: 'tpl-1',
  })
  const { assignments } = buildElectiveAssignments({
    campers: [{ id: 'cam-1' }],
    occurrences: OCCURRENCES,
    offerings: buildOfferings({ occurrences: OCCURRENCES, setActivities: SET_ACTIVITIES, activities: ACTIVITIES }),
    preferences: resolved.preferences,
    choices: choices.map((c) => ({ id: c.id, labelKey: electiveChoiceLabelKey(c.label), is_linked: c.is_linked ?? 0 })),
  })
  return assignments
}

const props = (over = {}) => ({
  run: { id: runId, name: 'Week 1 electives', status: 'draft' },
  activities: ACTIVITIES,
  days: DAYS,
  timeBlocks: TIME_BLOCKS,
  templateOccurrences: OCCURRENCES,
  ...over,
})

async function openCamper(over = {}) {
  render(<DraftRunView {...props(over)} />)
  return await openCamperIn()
}

// For a test that has already rendered the view itself.
async function openCamperIn() {
  fireEvent.click(await screen.findByTestId('camper-week-open-cam-1'))
  return await screen.findByTestId('camper-week')
}

const rowIdIn = (week) => week
  .querySelector('[data-testid^="camper-week-row-"]')
  .getAttribute('data-testid').replace('camper-week-row-', '')

describe('T297 — edit a preference, re-solve, and the placement changes', () => {
  it('places the camper where the DIRECTOR said, not where the file said', async () => {
    // BEFORE: solving from the database puts cam-1 in Gaga, because that is what
    // the sheet said. Derived, not asserted as a literal — if the fixture ever
    // stops meaning this, the test says so instead of quietly testing nothing.
    const before = resolveFromDatabase()
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ camper_id: 'cam-1', activity_id: 'act-gaga' })

    const week = await openCamper()
    const assignmentId = rowIdIn(week)

    // THE DIRECTOR'S PATH: reveal the editor on that row, pick Ceramics.
    fireEvent.click(screen.getByTestId(`camper-week-edit-${assignmentId}`))
    const select = await screen.findByTestId(`camper-week-choice-${assignmentId}`)
    fireEvent.change(select, { target: { value: deriveElectiveChoiceId(runId, 'ceramics') } })

    await waitFor(() => expect(localClient.setElectivePreference).toHaveBeenCalled())

    // The edit CORRECTED the imported row rather than adding a second one: the
    // call names the preference the week row was showing. Without that, the
    // planner sheet's coordinate row survives and ties with the correction.
    const call = localClient.setElectivePreference.mock.calls[0][0]
    expect(call.replacesPreferenceId).toBeTruthy()

    // AFTER: the same re-solve, no file re-imported, and the placement moved.
    // THIS is the archive_when's assertion — not that a write returned ok.
    await waitFor(() => {
      const after = resolveFromDatabase()
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({ camper_id: 'cam-1', activity_id: 'act-ceramics' })
    })
  })

  it('offers the re-solve only once an edit has actually been made', async () => {
    // onRegenerate present: this session CAN re-solve, so the only reason the
    // control would be absent is that nothing has been edited yet.
    const onRegenerate = vi.fn()
    render(<DraftRunView {...props({ onRegenerate })} />)
    await screen.findByTestId('camper-week-open-cam-1')
    // Nothing to re-solve for yet, so no control. An always-present button would
    // be the inert affordance the standing rule forbids.
    expect(screen.queryByTestId('run-preference-resolve')).toBeNull()

    const week = await openCamperIn()
    const assignmentId = rowIdIn(week)
    fireEvent.click(screen.getByTestId(`camper-week-edit-${assignmentId}`))
    fireEvent.change(await screen.findByTestId(`camper-week-choice-${assignmentId}`), {
      target: { value: deriveElectiveChoiceId(runId, 'ceramics') },
    })
    const resolveButton = await screen.findByTestId('run-preference-resolve')
    fireEvent.click(resolveButton)
    // The re-solve is handed the RUN's own rows and choices. Handing it neither
    // would silently re-solve from the parsed sheet, which is the edit being
    // written and then ignored.
    expect(onRegenerate).toHaveBeenCalledTimes(1)
    const payload = onRegenerate.mock.calls[0][0]
    expect(payload.preferences.length).toBeGreaterThan(0)
    expect(payload.choices.length).toBeGreaterThan(0)
    expect(payload.preferences.some((p) => p.choice_id === deriveElectiveChoiceId(runId, 'ceramics'))).toBe(true)
  })

  it('surfaces a refused edit instead of swallowing it', async () => {
    // A finalized run refuses the write. The director must be told; a silent
    // no-op here is the defect class this whole program exists to remove.
    db.prepare("UPDATE elective_assignment_runs SET status = 'final' WHERE id = ?").run(runId)
    const week = await openCamper()
    const assignmentId = rowIdIn(week)
    fireEvent.click(screen.getByTestId(`camper-week-edit-${assignmentId}`))
    fireEvent.change(await screen.findByTestId(`camper-week-choice-${assignmentId}`), {
      target: { value: deriveElectiveChoiceId(runId, 'ceramics') },
    })
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/RUN_NOT_DRAFT/))
  })

  it('removes a preference the director withdraws', async () => {
    const week = await openCamper()
    const assignmentId = rowIdIn(week)
    fireEvent.click(screen.getByTestId(`camper-week-edit-${assignmentId}`))
    fireEvent.click(await screen.findByTestId(`camper-week-remove-${assignmentId}`))
    await waitFor(() =>
      expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE run_id = ?').get(runId).c).toBe(0))
  })
})
