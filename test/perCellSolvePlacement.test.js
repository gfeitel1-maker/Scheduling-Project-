// @vitest-environment node
//
// T285 — THE REGRESSION TEST FOR THE SOLVER, and the largest never-executed
// surface in this change.
//
// The corpus cannot reach here: the CLI commits with `occurrences: []`, so no
// probe ever runs a solve. Every per-cell coordinate this branch learned to read
// was therefore never once carried through to a placement, and the first time
// anybody did it by hand the answer was wrong.
//
// THE SCENARIO IS THE DEFECT, not an abstraction of it. Ari names Swim as his
// Monday-Period-3 first choice and Archery as his Friday-Period-6 first choice.
// Before the fix the solver placed him in the same activity for both cells and
// reported `preference_rank` as though it had honoured a first choice.
//
// This enters at FILE BYTES, goes through the real reader, resolves coordinates
// against a real template's occurrences, runs the real engine, and asserts WHERE
// THE CAMPER LANDED — not that a count moved. A placement test that only checks
// counts is exactly how a confident wrong answer ships.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { inferPreferenceLayout, parsePreferenceSheet } from '../src/ingest/preferenceSheet.js'
import { resolvePreferenceCoordinates } from '../src/screens/elective/assignment/resolvePreferenceCoordinates.js'
import { buildElectiveAssignments } from '../src/engine/buildElectiveAssignments.js'
import { buildOfferings } from '../src/screens/elective/assignment/buildOfferings.js'

// The camp: two days, two periods, one tier, one elective set offering Swim and
// Archery in both cells. The owner authorised inventing this ("schedules exist,
// you can make one, doesn't matter to me").
const DAYS = [
  { id: 'd-mon', label: 'Monday' },
  { id: 'd-fri', label: 'Friday' },
]
const TIME_BLOCKS = [
  { id: 'tb-3', name: 'Period 3' },
  { id: 'tb-6', name: 'Period 6' },
]
const OCCURRENCES = [
  { id: 'o-mon3', elective_set_id: 'set-1', day_id: 'd-mon', time_block_id: 'tb-3', tier_id: 't-1' },
  { id: 'o-fri6', elective_set_id: 'set-1', day_id: 'd-fri', time_block_id: 'tb-6', tier_id: 't-1' },
]
const ACTIVITIES = [
  { id: 'a-swim', name: 'Swim' },
  { id: 'a-arch', name: 'Archery' },
]
// Ample capacity everywhere, deliberately: a placement that is wrong must be wrong
// because the rank was misread, never because a seat ran out.
const SET_ACTIVITIES = [
  { activity_id: 'a-swim', status: 'confirmed', capacity_mode: 'unlimited' },
  { activity_id: 'a-arch', status: 'confirmed', capacity_mode: 'unlimited' },
]
// Built by the REAL buildOfferings, not hand-rolled. A first draft of this test
// hand-built offerings and omitted their `labelKey`, which is the field `rankAt`
// keys on — so every rank read back null and the test failed for a reason that had
// nothing to do with the defect. A fixture that drifts from the shape the
// production caller passes tests the fixture.
const OFFERINGS = buildOfferings({
  occurrences: OCCURRENCES,
  setActivities: SET_ACTIVITIES,
  activities: ACTIVITIES,
})

const SHEET =
  'Camper Name,Day Of Week,Period Number,#1,#2,#3\n' +
  'Ari Feldspar,Monday,3,Swim,Archery,\n' +
  'Ari Feldspar,Friday,6,Archery,,Swim\n'

/** File bytes -> parsed -> coordinates resolved -> solved. The real path. */
function importAndSolve(sheet = SHEET, { resolve = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-percell-'))
  try {
    const file = path.join(dir, 'per-cell.csv')
    fs.writeFileSync(file, sheet)
    // Read the bytes the way the reader does, from disk.
    const rows = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(','))

    const catalog = { activities: ['Swim', 'Archery'], groups: [], tiers: [] }
    const mapping = inferPreferenceLayout(rows, { catalog })
    const parsed = parsePreferenceSheet(rows, { campId: 'camp-1', mapping, catalog })

    const resolved = resolve
      ? resolvePreferenceCoordinates({
          preferences: parsed.preferences,
          occurrences: OCCURRENCES,
          days: DAYS,
          timeBlocks: TIME_BLOCKS,
          templateId: 'tmpl-a',
        })
      : { preferences: parsed.preferences, residue: [] }

    const { assignments, findings } = buildElectiveAssignments({
      campers: parsed.campers.map((c) => ({ id: c.id, group_id: null })),
      occurrences: OCCURRENCES,
      offerings: OFFERINGS,
      preferences: resolved.preferences,
    })
    return { parsed, resolved, assignments, findings }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const at = (assignments, occurrenceId) => assignments.find((a) => a.occurrence_id === occurrenceId)

describe('a per-cell sheet is placed in the activity the camper named FOR THAT CELL', () => {
  it('parses four preferences with their coordinates and no occurrence_id', () => {
    // The premise. The parse was never the broken half, and pinning it here keeps
    // a future failure attributable to the solve rather than the read.
    const { parsed } = importAndSolve()
    expect(parsed.preferences).toHaveLength(4)
    for (const p of parsed.preferences) {
      expect(p.occurrence_id ?? null).toBeNull()
      expect(p.coordinate.dayName).toBeTruthy()
    }
  })

  it('resolves each coordinate onto the occurrence at that cell', () => {
    const { resolved } = importAndSolve()
    const byKeyDay = resolved.preferences.map((p) => [p.labelKey, p.rank, p.occurrence_id])
    expect(byKeyDay).toEqual([
      ['swim', 1, 'o-mon3'],
      ['archery', 2, 'o-mon3'],
      ['archery', 1, 'o-fri6'],
      ['swim', 3, 'o-fri6'],
    ])
    expect(resolved.residue).toEqual([])
  })

  it('PLACES Ari in Swim on Monday and Archery on Friday — what he actually asked for', () => {
    // THE ASSERTION THE WHOLE COMMIT EXISTS FOR. Before the fix this came back
    // with the same activity in both cells.
    const { assignments } = importAndSolve()
    expect(assignments).toHaveLength(2)
    expect(at(assignments, 'o-mon3').activity_id).toBe('a-swim')
    expect(at(assignments, 'o-fri6').activity_id).toBe('a-arch')
  })

  it('reports a preference_rank that is TRUE, not merely present', () => {
    // The dangerous half of the defect was not the misplacement alone — it was
    // `preference_rank: 1` ASSERTING a first choice had been honoured when it had
    // not. A rank that is present but lying is worse than a null.
    const { assignments } = importAndSolve()
    expect(at(assignments, 'o-mon3').preference_rank).toBe(1) // Swim WAS his Monday #1
    expect(at(assignments, 'o-fri6').preference_rank).toBe(1) // Archery WAS his Friday #1
  })

  it('NON-VACUITY: without coordinate resolution the placement is WRONG', () => {
    // Plant the defect by skipping resolution, which is exactly the pre-fix state:
    // every cell collapses onto the engine's single whole-run scalar. This must
    // fail on the PLACEMENT, not on a count — so it asserts that at least one cell
    // gets an activity the camper did not name first for it.
    const { assignments } = importAndSolve(SHEET, { resolve: false })
    expect(assignments).toHaveLength(2)
    const monday = at(assignments, 'o-mon3').activity_id
    const friday = at(assignments, 'o-fri6').activity_id
    // The two cells' first choices DIFFER on the sheet, so a correct solve gives
    // two different activities. Collapsed, it cannot.
    expect(monday === friday || friday !== 'a-arch').toBe(true)
  })
})

describe('the whole-run fallback folds to the BEST rank', () => {
  it('two whole-run ranks for one choice keep the lower one', () => {
    // `record()` did `entry.fallback = rank`, a bare assignment: last write wins.
    // Its sibling `choiceRankMinOverMembers` folds to the minimum, and §12.2b's
    // "best (lowest) rank wins" is already implemented at the PARSE layer — so the
    // engine contradicted both its own sibling and the parser.
    //
    // Fed directly, because the parser now de-duplicates this case before it can
    // reach the engine: the engine must be correct on its own terms rather than
    // relying on a caller to pre-clean its input.
    const { assignments } = {
      assignments: buildElectiveAssignments({
        campers: [{ id: 'cam-1', group_id: null }],
        occurrences: [OCCURRENCES[0]],
        offerings: buildOfferings({
          occurrences: [OCCURRENCES[0]],
          setActivities: SET_ACTIVITIES,
          activities: ACTIVITIES,
        }),
        preferences: [
          // Swim at #1, then Swim again at #5. The better statement must survive.
          { camper_id: 'cam-1', labelKey: 'swim', rank: 1 },
          { camper_id: 'cam-1', labelKey: 'swim', rank: 5 },
          { camper_id: 'cam-1', labelKey: 'archery', rank: 2 },
        ],
      }).assignments,
    }
    expect(assignments).toHaveLength(1)
    // Swim's best rank is 1, which beats Archery's 2. Under last-write-wins Swim
    // would have held rank 5 and lost to Archery.
    expect(assignments[0].activity_id).toBe('a-swim')
    expect(assignments[0].preference_rank).toBe(1)
  })
})

describe('resolution never WRITES, so one preference never becomes two rows', () => {
  it('the resolved set is a copy; the stored rows keep their coordinates', () => {
    // A review raised this as a dual-row hazard, and the reasoning was right:
    // `deriveElectivePreferenceId`'s `occ` arm ignores the coordinate and
    // `commitElectiveRun` never prunes a run's existing preference rows. So if
    // resolution wrote back, committing one runId twice — once coordinate-scoped,
    // once occurrence-scoped — would leave an `at` row AND an `occ` row live for
    // one logical preference, read by two different scopes.
    //
    // It dissolves rather than needing reconciliation, because resolution is
    // IN-MEMORY. Nothing writes a resolved occurrence, so there is never a second
    // row. That is also forced by §13.2 for an independent reason: the coordinate
    // set is per-template and the two candidate routes may bind one coordinate
    // differently, so persisting a resolved occurrence would make one route
    // canonical — which CLAUDE.md forbids the app doing.
    //
    // Pinned because the tempting "improvement" is to commit the resolved set.
    const { parsed, resolved } = importAndSolve()

    for (const p of parsed.preferences) {
      expect(p.occurrence_id ?? null).toBeNull()
      expect(p.coordinate).toBeTruthy()
    }
    // The resolved copies DO carry one, and are different objects.
    for (let i = 0; i < parsed.preferences.length; i += 1) {
      expect(resolved.preferences[i].occurrence_id).toBeTruthy()
      expect(resolved.preferences[i]).not.toBe(parsed.preferences[i])
      // The coordinate survives on the copy too — it is the stored truth.
      expect(resolved.preferences[i].coordinate).toEqual(parsed.preferences[i].coordinate)
    }
  })

  it('AssignmentPanel commits `parsed`, never the resolved set', () => {
    // A source-level guard, because the runtime consequence (a duplicate row) only
    // shows up on a SECOND commit of the same run and no test drives that today.
    // Reading the call site is what makes the invariant checkable now.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '../src/screens/elective/assignment/AssignmentPanel.jsx'),
      'utf8'
    )
    const commitCall = source.slice(source.indexOf('localClient.commitElectiveRun('))
    const commitArgs = commitCall.slice(0, commitCall.indexOf('})'))
    expect(commitArgs).toMatch(/\bparsed,/)
    expect(commitArgs).not.toMatch(/resolvedPreferences/)
  })
})
