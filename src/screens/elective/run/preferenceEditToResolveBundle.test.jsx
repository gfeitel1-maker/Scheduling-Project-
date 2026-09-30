// @vitest-environment jsdom
//
// T318 round 2 — the SAME root cause as
// electron/ops/commitElectiveRun.test.js's new bundle-assignment test, one
// seam over. Before the fix, a solver placement on a bundle-claimed label
// persisted with `elective_assignments.choice_id = null` (the assignment
// write loop read `choiceIdByKey`, which the D6 `continue` never populates
// for a bundle-claimed label, while the preference write loop DID resolve to
// the bundle's own per-tier choice). buildPreferenceLookup
// (camperElectiveWeek.js) joins assignment to preference on choice_id and
// returns null outright when the assignment's choice_id is null — so
// DraftRunView's writePreference computed `replacesPreferenceId: null` for a
// director editing a bundle-claimed placement, meaning the edit wrote a
// SECOND preference row instead of correcting the one they meant, exactly
// the defect class T297 exists to prevent.
//
// This drives the real path end to end, mirroring
// preferenceEditToResolve.test.jsx's own "real ops behind stubbed IPC"
// architecture: the run is committed through the real commitElectiveRun, the
// edit goes through the real click-driven DraftRunView/CamperWeekPanel
// affordance, and the assertion is the replacesPreferenceId the real write
// call carries — not a re-implementation of the join.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../../../../electron/db/localDb.js'
import { commitElectiveRun } from '../../../../electron/ops/commitElectiveRun.js'
import { setElectivePreference, removeElectivePreference } from '../../../../electron/ops/setElectivePreference.js'
import { deriveElectiveOccurrenceId, deriveLinkedElectiveChoiceId, deriveElectiveChoiceId } from '../../../../electron/ops/electiveDerivedIds.js'

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

const DAYS = [{ id: 'day-1', label: 'Monday', sort_order: 1 }]
const TIME_BLOCKS = [
  { id: 'tb-1', name: 'Period 1', sort_order: 1 },
  { id: 'tb-2', name: 'Period 2', sort_order: 2 },
]

let dir
let db
let campId
let runId
let occurrences

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t318-bundle-edit-'))
  db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run('tier-jr', campId, 'Juniors')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run('grp-1', campId, 'Bunk 1', 'tier-jr')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-1', campId, 'Monday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-1', campId, 'Period 1')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-2', campId, 'Period 2')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-archery', campId, 'Archery')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-gaga', campId, 'Gaga')
  db.prepare(
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, status) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), 'set-1', 'act-gaga', 'unlimited', 'confirmed')

  // A bundle claiming "Archery" for Juniors, spanning both periods — D6's
  // mechanism under test (electron/ops/commitElectiveRun.test.js's own
  // seedBundleFixture, reproduced here since this file lives one directory
  // over and cannot import a test-local helper).
  db.prepare(
    'INSERT INTO elective_bundles (id, elective_set_id, activity_id, name, scope_mode) VALUES (?, ?, ?, ?, ?)'
  ).run('bundle-1', 'set-1', 'act-archery', 'Archery', 'all')
  db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
    .run('bp-1', 'bundle-1', 'day-1', 'tb-1')
  db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
    .run('bp-2', 'bundle-1', 'day-1', 'tb-2')

  runId = randomUUID()
  occurrences = [
    {
      id: deriveElectiveOccurrenceId(runId, 'set-1', 'day-1', 'tb-1', 'tier-jr'),
      elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-jr',
    },
    {
      id: deriveElectiveOccurrenceId(runId, 'set-1', 'day-1', 'tb-2', 'tier-jr'),
      elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-2', tier_id: 'tier-jr',
    },
  ]

  const out = commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
    parsed: {
      // cam-2 is untiered (no group) purely to MINT a real, plain "Gaga"
      // choice for the edit dropdown to switch to — it never gets an
      // assignment and never appears in the camper picker.
      campers: [
        { id: 'cam-1', display_name: 'Testcamper Alpha', external_id: null, group_id: 'grp-1' },
        { id: 'cam-2', display_name: 'Testcamper Beta', external_id: null, group_id: null },
      ],
      choices: [{ label: 'Archery', labelKey: 'archery' }, { label: 'Gaga', labelKey: 'gaga' }],
      // Whole-run preference (no occurrence_id), same shape T265 round 5
      // legitimizes and the sibling bundle tests in commitElectiveRun.test.js
      // use.
      preferences: [
        { camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 },
        { camper_id: 'cam-2', label: 'Gaga', labelKey: 'gaga', rank: 1 },
      ],
      sameNameCampers: [],
      skippedRows: [],
    },
    // The solver placed cam-1 on the bundle-claimed label in BOTH member
    // periods — this is the row whose choice_id was null before the fix.
    assignments: [
      { camper_id: 'cam-1', occurrence_id: occurrences[0].id, labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1 },
      { camper_id: 'cam-1', occurrence_id: occurrences[1].id, labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1 },
    ],
    occurrences,
  })
  expect(out).toMatchObject({ ok: true })

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

// Same projection getElectiveRunHandler performs — mirrors
// preferenceEditToResolve.test.jsx's own readRun().
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

const props = () => ({
  run: { id: runId, name: 'Week 1 electives', status: 'draft' },
  activities: [{ id: 'act-archery', name: 'Archery' }, { id: 'act-gaga', name: 'Gaga' }],
  days: DAYS,
  timeBlocks: TIME_BLOCKS,
  templateOccurrences: occurrences,
})

const rowIdIn = (week) => week
  .querySelector('[data-testid^="camper-week-row-"]')
  .getAttribute('data-testid').replace('camper-week-row-', '')

describe('T318 round 2 — editing a bundle-claimed placement corrects the existing preference, not a second one', () => {
  it('sends replacesPreferenceId as the prior row’s id, never null, for a bundle-claimed placement', async () => {
    render(<DraftRunView {...props()} />)
    fireEvent.click(await screen.findByTestId('camper-week-open-cam-1'))
    const week = await screen.findByTestId('camper-week')
    const assignmentId = rowIdIn(week)

    // The stored preference this edit is meant to correct — the sole bundle
    // preference row this run committed.
    const priorPreferenceId = db.prepare('SELECT id FROM elective_preferences WHERE run_id = ?').get(runId).id
    expect(priorPreferenceId).toBeTruthy()

    fireEvent.click(screen.getByTestId(`camper-week-edit-${assignmentId}`))
    const select = await screen.findByTestId(`camper-week-choice-${assignmentId}`)
    fireEvent.change(select, { target: { value: deriveElectiveChoiceId(runId, 'gaga') } })

    await waitFor(() => expect(localClient.setElectivePreference).toHaveBeenCalled())
    const call = localClient.setElectivePreference.mock.calls[0][0]

    // THE ASSERTION. Before the fix, entry.preferenceId (and therefore
    // replacesPreferenceId) was null for this row, because
    // buildPreferenceLookup's join missed on the assignment's null choice_id
    // — so this edit would have written a SECOND preference row instead of
    // replacing the one the director meant to correct.
    expect(call.replacesPreferenceId).toBe(priorPreferenceId)

    // Non-vacuity: only one preference row existed before the edit, and the
    // gaga choice the test switches to is a real, different choice — so a
    // false "replaces" (null, silently creating a second row) is
    // distinguishable from the true fix.
    expect(call.replacesPreferenceId).not.toBeNull()
    expect(deriveLinkedElectiveChoiceId(runId, 'bundle-1', 'tier-jr')).not.toBe(deriveElectiveChoiceId(runId, 'gaga'))
  })
})
