// @vitest-environment jsdom
//
// T199 spec §6, conditions (3), (4), (5), (8), and (2)'s SOLVE half. T251.
//
//   (3) "no offering exceeds capacity"
//   (4) "no camper violates eligibility"   — READ THE GAP BELOW BEFORE TRUSTING
//                                            THIS TITLE
//   (5) "every lock is retained"           — SINGLE DEVICE ONLY, see GAP-3
//   (8) "the linked choice places in both member occurrences or neither"
//   (2) "two runs over identical input produce byte-equivalent normalized
//       output" — the solve half; the import half is in
//       electron/electiveAcceptanceImport.integration.test.js.
//
// ── WHAT IS DRIVEN, AND WHY IT IS THE REAL COMPONENT ──────────────────────
//
// There is NO production module that composes solver inputs from a database.
// The whole orchestration — deriveOccurrences -> buildOfferings ->
// deriveChoices -> resolvePreferenceCoordinates -> buildAttendance ->
// buildElectiveAssignments -> commitElectiveRun — lives inside one React
// callback, `solve()` at
// src/screens/elective/assignment/AssignmentPanel.jsx:611-700, whose only
// non-test caller is the component's own render
// (src/screens/elective/assignment/AssignmentPanel.jsx:669).
// `runPreferenceSheetCli` commits `assignments: []` deliberately
// (scripts/preferenceSheetCli.js:355-379) and
// `commitElectiveRunHandler` takes an already-solved array
// (electron/main.js:2070-2098).
//
// So a test that called those seven modules in order would be asserting that
// the test agrees with the test. That is the T62 defect shape, and this module
// family has ALREADY shipped it once:
// src/screens/elective/assignment/buildAttendance.js:16-27 records that the
// module read `camper.division` while the parser only ever produced
// `camper.division_label`, so attendance scoping never worked in the shipped
// app — and its own tests missed it for months because the fixtures hand-built
// `{ division: ... }` matching the code's wrong assumption.
//
// This file therefore RENDERS AssignmentPanel in jsdom, hands it props read out
// of the real database through the real `list` IPC handler, and clicks the real
// controls. `localClient` is replaced by a thin forwarder onto
// `makeHandlers(db, deviceId, {})` — the REAL IPC handlers over a real
// better-sqlite3 file through the full migration chain (see
// ./electiveAcceptanceLocalClient.js, which says at length why that is the
// architecture and not a shortcut). It is NOT src/localClient.mock.js.
//
// ── THREE GAPS THE TITLES ABOVE MUST NOT BE READ PAST ──────────────────────
//
// GAP-2 — (4) IS NARROWER THAN ITS ENGLISH. The solver has no eligibility
// concept beyond attendance: its only gate is `attends(id, occurrenceId)`
// (src/engine/buildElectiveAssignments.js:378). What is asserted here is
// exactly "no assignment names an occurrence the camper does not attend".
// Age rules, prerequisites, or any other notion of eligibility are not
// modelled anywhere and are not checked here.
//
// GAP-3 — (5) IS SINGLE-DEVICE ONLY. commitElectiveRun.js:216-237 states it
// itself: `is_locked = 1` is read from THIS device's projection, so a lock a
// peer set that has not merged here yet is invisible, and its row is rewritten
// to source='solver' while `is_locked` stays 1. A single-node fixture cannot
// exhibit that, and
// test/integration/scenarios/36-finalized-elective-run-survives-sync.automerge.js
// does not claim it either.
//
// (3)'s BLIND SPOT: NO_CAPACITY can never fire in this camp, because `Garden`
// is unlimited and is offered at every occurrence, so no camper is ever
// unplaceable. That is asserted below as a fact about the fixture rather than
// left as a silent absence.
//
// (2)'s BLIND SPOT, stated rather than solved: non-determinism that is stable
// within one Node process — an iteration order that is consistent per-process
// but not across processes — is invisible to two solves in one test run.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

// The forwarder is late-bound: the database does not exist until beforeAll, and
// a vi.mock factory is hoisted above it. Every property access goes through to
// whatever `ref.impl` holds at call time, so nothing here decides anything.
const ref = vi.hoisted(() => ({ impl: null }))
vi.mock('../src/localClient', () => ({
  localClient: new Proxy({}, {
    get: (_t, prop) => (...args) => {
      if (!ref.impl) throw new Error(`localClient.${String(prop)} called before the fixture was built`)
      if (typeof ref.impl[prop] !== 'function') throw new Error(`localClient.${String(prop)} is not forwarded`)
      return ref.impl[prop](...args)
    },
  }),
}))

import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import { panelPropsFromDatabase, solveAndCommit as driveSolveAndCommit } from './electiveAcceptancePanelDrive.jsx'
import { makeLocalClientOverHandlers } from './electiveAcceptanceLocalClient.js'
import { ACCEPTANCE_MANIFEST } from './fixtures/electiveAcceptanceCamp.js'
import { resolveOfferingCapacity } from './ops/electiveOfferingCapacity.js'
import { deriveLinkedElectiveChoiceId } from './ops/electiveDerivedIds.js'

const M = ACCEPTANCE_MANIFEST

let camp
let props

beforeAll(async () => {
  camp = await openAcceptanceCamp()
  ref.impl = makeLocalClientOverHandlers(camp.handlers, camp.token)
  props = panelPropsFromDatabase(camp)
}, 60_000)

afterAll(() => { camp?.close() })

// Driving the real panel lives in ./electiveAcceptancePanelDrive.jsx — one
// copy, shared with the projection and lifecycle files.
const solveAndCommit = (options) => driveSolveAndCommit(camp, props, options)


const assignmentsOf = (runId) => camp.db.prepare(`
  SELECT a.camper_id, a.activity_id, a.occurrence_id, a.preference_rank, a.source, a.is_locked,
         o.day_id, o.time_block_id, o.tier_id
  FROM elective_assignments a
  JOIN elective_occurrences o ON o.id = a.occurrence_id
  WHERE a.run_id = ?
  ORDER BY o.day_id, o.time_block_id, o.tier_id, a.camper_id
`).all(runId)

const camperTier = () => new Map(camp.db
  .prepare('SELECT id, division_label FROM campers WHERE camp_id = ?').all(camp.fixture.campId)
  .map((r) => [r.id, camp.fixture.tierIdByName.get(r.division_label) ?? null]))

describe('§6 — the real panel solves and commits against the generated route', () => {
  let run
  let rows

  beforeAll(async () => {
    run = await solveAndCommit()
    rows = assignmentsOf(run.id)
  }, 60_000)

  it('produced a run against the generated template, with assignments', () => {
    expect(run.schedule_template_id).toBe(camp.fixture.generatedTemplateId)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('(3) no offering exceeds capacity, resolved the way the app resolves it', () => {
    // resolveOfferingCapacity, NOT a raw read of capacity_limit — that is the
    // ONE place capacity is decided (electron/ops/electiveOfferingCapacity.js),
    // and reading the column directly turns the unlimited offering into 0.
    const limitByActivity = new Map()
    for (const sa of props.setActivities) {
      const resolved = resolveOfferingCapacity(sa)
      limitByActivity.set(sa.activity_id, resolved.kind === 'limited' ? resolved.capacity : Infinity)
    }
    const counts = new Map()
    for (const r of rows) {
      const key = `${r.occurrence_id}\u0000${r.activity_id}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const over = []
    for (const [key, n] of counts) {
      const activityId = key.split('\u0000')[1]
      if (n > limitByActivity.get(activityId)) over.push({ key, n, limit: limitByActivity.get(activityId) })
    }
    expect(over).toEqual([])
  })

  it('(3) the capacity shortfall is real — campers reached second and third choice', () => {
    // Without this, "nothing exceeded capacity" would be satisfied by a camp
    // where nothing was ever contended. §6 asks for one shortfall; at the
    // Monday/Younger cell nine of eleven campers rank a three-seat offering.
    const ranks = new Set(rows.map((r) => r.preference_rank).filter((r) => r != null))
    expect(ranks.has(1)).toBe(true)
    expect(ranks.has(2)).toBe(true)
    expect(ranks.has(3)).toBe(true)
  })

  it('(3) every camper who attends an occurrence is placed in it — capacity limited nobody OUT', () => {
    // THE OTHER HALF OF (3), and the half that catches the real mistake.
    // "Nothing exceeded capacity" is satisfied trivially by an offering that
    // reads as CLOSED: `buildOfferings`'s own header calls this the capacity
    // trap — `Math.max(0, o.capacity ?? 0)` means a null or 0 SHUTS an offering,
    // so a naive `capacity_limit ?? 0` read turns the unlimited Garden into
    // zero seats and simply places fewer campers. Measured: with only the
    // over-capacity check above, that mutation stayed green.
    //
    // One unlimited offering exists at every occurrence, so the correct result
    // is that EVERY attending camper has a seat.
    const unlimited = props.setActivities.filter((sa) => resolveOfferingCapacity(sa).kind === 'unlimited')
    expect(unlimited).toHaveLength(1)

    const tierOf = camperTier()
    const occurrences = camp.db
      .prepare('SELECT id, tier_id FROM elective_occurrences WHERE run_id = ?').all(run.id)
    const placed = new Map()
    for (const r of rows) {
      if (!placed.has(r.occurrence_id)) placed.set(r.occurrence_id, new Set())
      placed.get(r.occurrence_id).add(r.camper_id)
    }
    // AND the unlimited offering is actually USED. Without this, closing it is
    // invisible: this camp has 31 finite seats per occurrence against 13
    // attending campers, so a Garden read as zero seats still places everybody
    // — measured, the "everyone is placed" check alone stayed green under the
    // raw-`capacity_limit ?? 0` mutation. Campers rank Garden first at several
    // cells, so an empty Garden is the symptom of a mis-resolved capacity.
    const gardenId = camp.fixture.activityIdByName.get('Garden')
    expect(unlimited[0].activity_id).toBe(gardenId)
    expect(rows.filter((r) => r.activity_id === gardenId).length).toBeGreaterThan(0)

    const short = []
    for (const o of occurrences) {
      const attending = [...tierOf].filter(([, t]) => t === o.tier_id).map(([id]) => id)
      const here = placed.get(o.id) ?? new Set()
      const missing = attending.filter((id) => !here.has(id))
      if (missing.length > 0) short.push({ occurrence: o.id, missing: missing.length, attending: attending.length })
    }
    expect(short).toEqual([])
  })

  it('(4) GAP-2 — no assignment names an occurrence the camper does not attend', () => {
    // This is exactly what the solver checks and no more: its only gate is
    // `attends(id, occurrenceId)` (buildElectiveAssignments.js:378). It is
    // narrower than §6's English; see the file header.
    const tierOf = camperTier()
    const violations = rows.filter((r) => tierOf.get(r.camper_id) !== r.tier_id)
    expect(violations).toEqual([])
  })

  it('(4) no camper was excluded by FAILING TO MATCH a division, which would look the same', () => {
    // buildAttendance excludes a camper whose division_label matches no tier
    // (`unmatched`), and such a camper is excluded from EVERY occurrence — which
    // satisfies "no camper violates eligibility" while meaning the opposite of
    // what it sounds like. So: every camper the sheet named is placed somewhere.
    // This is the assertion that keeps (4) from passing because attendance
    // scoping is broken rather than because it works.
    const placed = new Set(rows.map((r) => r.camper_id))
    const roster = camp.db
      .prepare('SELECT id, display_name FROM campers WHERE camp_id = ?').all(camp.fixture.campId)
    expect(roster).toHaveLength(M.camperCount)
    expect(roster.filter((c) => !placed.has(c.id)).map((c) => c.display_name)).toEqual([])
  })

  it('(4) the eligibility rejection is REAL — Older campers asked for a cell only Younger has', () => {
    // Without this the assertion above passes in a camp where every camper was
    // eligible for everything. Three Older campers write a Wednesday row; the
    // generated route places this set on Wednesday for Younger only, so their
    // choice resolves to a Younger occurrence they do not attend.
    const wednesday = camp.fixture.dayIdByLabel.get('Wednesday')
    const older = camp.fixture.tierIdByName.get('Older')
    const wedOccurrences = camp.db
      .prepare('SELECT DISTINCT tier_id FROM elective_occurrences WHERE run_id = ? AND day_id = ?')
      .all(run.id, wednesday).map((r) => r.tier_id)
    expect(wedOccurrences).not.toContain(older)

    const olderCampers = new Set([...camperTier()].filter(([, t]) => t === older).map(([id]) => id))
    const wednesdayPreferences = camp.db.prepare(`
      SELECT p.camper_id FROM elective_preferences p
      WHERE p.run_id = ? AND p.coordinate_day_label = 'Wednesday'
    `).all(run.id).filter((p) => olderCampers.has(p.camper_id))
    expect(wednesdayPreferences.length).toBeGreaterThan(0)

    // And they are not placed on Wednesday.
    const placedThere = rows.filter((r) => r.day_id === wednesday && olderCampers.has(r.camper_id))
    expect(placedThere).toEqual([])
  })

  // ROUND-2 REBUILD. What this asserted before was coincidence-compatible in
  // both halves, and the mutation proved it: with `runLinkedChoiceTier`
  // short-circuited at its first line — the linked tier removed from the engine
  // outright — the whole condition stayed GREEN.
  //
  // WHY. (a) The `is_linked = 1` choices and their offerings are written
  // UNCONDITIONALLY by commitElectiveRun.js:449-462, "whether or not any
  // preference this commit carries names their label", so their presence was a
  // fact about the fixture's own write calls and not about the solve. (b) The
  // bundle's four campers rank it whole-run, so its two member occurrences saw
  // IDENTICAL demand, and the ordinary solver is deterministic and
  // input-order-independent — it simply picked the same three at both.
  //
  // THE FIXTURE NOW BREAKS THE SYMMETRY: three more Older campers rank Ropes
  // first on TUESDAY ONLY, so Tuesday is contended 7-for-3 against Monday's
  // 4-for-3 and no ordinary per-occurrence pass can land the same three at both
  // by accident. The mutation above now reds this test.
  //
  // AND IT IS SCOPED TO THE LINKED COHORT. Asserting over every Older camper
  // holding the bundle's activity was simultaneously OVER-strict: a non-linked
  // fallback seat at Ropes on one member day alone — exactly what those three
  // extra campers are — is a legitimate tier-2 outcome and is not a violation
  // of atomicity. The cohort is read from `elective_preferences`, which is
  // where a preference naming the bundle's label lands (D6 resolves it to the
  // bundle's own per-tier choice).
  it('(8) the linked choice placed in BOTH member occurrences or neither', () => {
    const bundleActivity = camp.fixture.activityIdByName.get(M.bundle.activity)
    const older = camp.fixture.tierIdByName.get('Older')
    const memberDays = M.bundle.days.map((d) => camp.fixture.dayIdByLabel.get(d))
    const choiceId = deriveLinkedElectiveChoiceId(run.id, camp.fixture.bundleIds.bundle, older)

    // THE CHOICE AND ITS MEMBERS, as a PRECONDITION and labelled one. These
    // rows are written unconditionally, so they say the bundle was authored and
    // expanded — never that tier 1 placed anybody.
    const choice = camp.db
      .prepare('SELECT label, is_linked FROM elective_choices WHERE id = ? AND run_id = ?').get(choiceId, run.id)
    expect(choice).toMatchObject({ label: M.bundle.name, is_linked: 1 })
    const members = camp.db
      .prepare('SELECT DISTINCT occurrence_id FROM elective_choice_offerings WHERE choice_id = ?').all(choiceId)
    expect(members).toHaveLength(memberDays.length)
    const memberOccurrences = new Set(members.map((m) => m.occurrence_id))

    // THE COHORT: the four campers whose sheet rows name this bundle, by name
    // from the manifest and resolved to ids here. NOT read from
    // `elective_preferences.choice_id` — see the gap below, which measures why
    // that column can never carry a bundle's choice id in this camp.
    const cohort = new Set(camp.db
      .prepare(`SELECT id FROM campers WHERE camp_id = ? AND display_name IN (${M.linkedChoiceCampers.map(() => '?').join(',')})`)
      .all(camp.fixture.campId, ...M.linkedChoiceCampers).map((r) => r.id))
    expect(cohort.size).toBe(M.linkedChoiceCampers.length)

    const seatsByCamper = new Map()
    for (const r of rows) {
      if (!cohort.has(r.camper_id) || r.activity_id !== bundleActivity) continue
      if (!memberOccurrences.has(r.occurrence_id)) continue
      if (!seatsByCamper.has(r.camper_id)) seatsByCamper.set(r.camper_id, new Set())
      seatsByCamper.get(r.camper_id).add(r.occurrence_id)
    }
    // ATOMICITY: no cohort member holds exactly one of the two.
    for (const [camperId, occs] of seatsByCamper) {
      expect({ camperId, held: occs.size }).toEqual({ camperId, held: memberOccurrences.size })
    }
    expect(seatsByCamper.size).toBeGreaterThan(0)

    // THE SET WAS WON, not merely held: every seat the cohort holds at a member
    // occurrence carries a rank, and the count is the offering's capacity —
    // tier 1 filled the choice's column to its min-over-members capacity.
    // Without this, a run that placed nobody as a set and left the cohort with
    // two unranked fallback seats each would satisfy atomicity.
    const capacity = M.offerings[M.bundle.activity][1]
    expect(seatsByCamper.size).toBe(Math.min(capacity, cohort.size))
    for (const camperId of seatsByCamper.keys()) {
      const held = rows.filter(
        (r) => r.camper_id === camperId && r.activity_id === bundleActivity && memberOccurrences.has(r.occurrence_id)
      )
      expect(held.map((r) => r.preference_rank)).toEqual(held.map(() => 1))
    }
  })
})

describe('MET — a linked preference reaches the database carrying its bundle choice id', () => {
  // FOUND BY SCOPING CONDITION (8)'s COHORT (round 2), not by reading the code.
  //
  // _Prior: D6 resolved a bundle-labelled preference to the camper's OWN
  // tier's choice via `tierIdByGroupId.get(camperById.get(p.camper_id).group_id)`,
  // and `camperById` was built from `parsed.campers` — the SHEET's campers,
  // not the database's. A sheet whose Division column names a TIER leaves
  // `group_id` null by design ("a `tiers` match → sets NOTHING referential"),
  // so `camperTierId` was null for every camper on such a sheet and EVERY
  // bundle-labelled preference was recorded as a tier mismatch and skipped.
  //
  // The engine was unaffected — it matches preferences to choices by labelKey
  // through the panel's own freshly derived choices, which is why condition
  // (8) below was live and red when the linked tier is removed. What was lost
  // was the PERSISTED link: `elective_preferences.choice_id` never named a
  // bundle, so nothing downstream of the database could tell a bundle
  // preference from an ordinary one._
  //
  // Closed by board item 9b: `resolveWriteChoiceId` (electron/ops/
  // commitElectiveRun.js) now resolves a camper's tier through
  // `identity.tierIdOf`, which reads the ROSTER camper (not the sheet row), so
  // a Division-column-as-tier sheet no longer starves every bundle
  // preference of a persisted choice id.
  it('every linked choice exists, and a real preference names it', async () => {
    const run = await solveAndCommit()
    const linkedIds = camp.db
      .prepare('SELECT id FROM elective_choices WHERE run_id = ? AND is_linked = 1').all(run.id).map((r) => r.id)
    expect(linkedIds.length).toBeGreaterThan(0)

    const placeholders = linkedIds.map(() => '?').join(',')
    const named = camp.db
      .prepare(`SELECT COUNT(*) c FROM elective_preferences WHERE run_id = ? AND choice_id IN (${placeholders})`)
      .get(run.id, ...linkedIds).c
    // PINNED (measured 2026-09-30), not merely non-zero, so this file
    // recomputes a number rather than tolerating whatever the fix produces.
    // 38 preference rows across 20 distinct campers naming 3 of this camp's 4
    // bundle choices (one bundle in the fixture's own preference sheet is
    // never named by any camper, so it mints a choice row — unconditionally,
    // per the comment on condition (8) below — but no preference ever points
    // at it).
    expect(named).toBe(38)
    const rows = camp.db
      .prepare(`SELECT camper_id, choice_id FROM elective_preferences WHERE run_id = ? AND choice_id IN (${placeholders})`)
      .all(run.id, ...linkedIds)
    expect(new Set(rows.map((r) => r.camper_id)).size).toBe(20)
    expect(new Set(rows.map((r) => r.choice_id)).size).toBe(3)

    // And every OTHER preference still lands too — this is an addition to
    // what reaches the database, not a narrowing of it.
    expect(camp.db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE run_id = ?').get(run.id).c)
      .toBeGreaterThan(named)
  }, 60_000)
})

describe('§6 (5) — every lock is retained (SINGLE DEVICE, GAP-3)', () => {
  it('a locked seat survives a re-solve of the SAME run, driven from the real Draft screen', async () => {
    const run = await solveAndCommit({ keepMounted: true })

    // THE LOCK, through the real IPC handler the Draft screen's own move/lock
    // control calls (T245/T246).
    const seat = assignmentsOf(run.id).find((r) => r.preference_rank != null)
    expect(seat).toBeTruthy()
    const out = await camp.handlers.setElectiveAssignment({
      token: camp.token,
      runId: run.id,
      camperId: seat.camper_id,
      occurrenceId: seat.occurrence_id,
      activityId: seat.activity_id,
      locked: true,
    })
    expect(out.ok).toBe(true)
    const beforeRow = camp.db
      .prepare('SELECT is_locked, source, activity_id, solver_generation FROM elective_assignments WHERE run_id = ? AND camper_id = ? AND occurrence_id = ?')
      .get(run.id, seat.camper_id, seat.occurrence_id)
    expect(beforeRow).toMatchObject({ is_locked: 1, source: 'manual', activity_id: seat.activity_id })

    // A RE-SOLVE OF THE SAME RUN, and this is the only way to reach one.
    // AssignmentPanel mints a fresh runId per solve, so a second import is a
    // DIFFERENT run and never touches these rows — a lock test built that way
    // passes with commitElectiveRun's `protectedIds` filter deleted (measured).
    // The only path to `regenerate()` — which keeps the runId — is DraftRunView,
    // and its control appears only once this session has something to re-solve
    // FOR: a preference edit. So the director's real sequence is driven here:
    // open the run, correct one camper's choice, "Solve again", commit.
    // BY ID, not by name: every run this camp has is called "Elective
    // assignment — <today>", so a by-text query matches several.
    fireEvent.click(await screen.findByTestId(`run-list-row-${run.id}`, {}, { timeout: 10_000 }))

    // A DIFFERENT camper from the locked one, so the edit cannot be what keeps
    // the locked row alive.
    const editable = assignmentsOf(run.id).find((r) => r.camper_id !== seat.camper_id)
    fireEvent.click(await screen.findByTestId(`camper-week-open-${editable.camper_id}`, {}, { timeout: 10_000 }))
    const week = await screen.findByTestId('camper-week', {}, { timeout: 10_000 })
    const rowId = week.querySelector('[data-testid^="camper-week-row-"]')
      .getAttribute('data-testid').replace('camper-week-row-', '')
    fireEvent.click(screen.getByTestId(`camper-week-edit-${rowId}`))
    const select = await screen.findByTestId(`camper-week-choice-${rowId}`, {}, { timeout: 10_000 })
    const option = [...select.querySelectorAll('option')].find((o) => o.value && o.value !== select.value)
    expect(option).toBeTruthy()
    fireEvent.change(select, { target: { value: option.value } })

    fireEvent.click(await screen.findByTestId('run-preference-resolve', {}, { timeout: 10_000 }))
    fireEvent.click(await screen.findByText(/Commit Assignments/, {}, { timeout: 10_000 }))

    // The run's generation moved — so this really was a re-solve of THIS run
    // and not a no-op. Without this the assertion below would hold trivially.
    await waitFor(() => {
      const gen = camp.db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(run.id)
      expect(gen.solver_generation).not.toBe(run.solver_generation)
    }, { timeout: 10_000 })

    const after = camp.db
      .prepare('SELECT is_locked, source, activity_id, solver_generation FROM elective_assignments WHERE run_id = ? AND camper_id = ? AND occurrence_id = ?')
      .get(run.id, seat.camper_id, seat.occurrence_id)
    expect(after).toEqual(beforeRow)
    run.view.unmount()
  }, 120_000)
})

describe('§6 (2) solve half — two solves over identical input agree', () => {
  it('the same sheet solved twice produces the same placements', async () => {
    // Compared by COORDINATE, not by id: every id in a run is derived from the
    // runId, and the panel mints a fresh one per solve, so two identical solves
    // legitimately carry different ids. What must not differ is who is placed
    // where.
    const shapeOf = (runId) => assignmentsOf(runId).map((r) => [
      r.camper_id, r.day_id, r.time_block_id, r.tier_id, r.activity_id, r.preference_rank, r.source ?? null,
    ])
    const first = await solveAndCommit()
    const second = await solveAndCommit()
    expect(second.id).not.toBe(first.id)
    expect(JSON.stringify(shapeOf(second.id))).toBe(JSON.stringify(shapeOf(first.id)))
  }, 60_000)
})

describe('MET — a per-cell preference binds to the camper\u2019s OWN tier on a tier-spanning set', () => {
  // FOUND BY RUNNING THIS FIXTURE, not by reading the code.
  //
  // _Prior: resolvePreferenceCoordinates built `occurrenceAtCell` keyed on
  // (day_id, time_block_id) ONLY and kept the FIRST occurrence it saw at each
  // cell, regardless of tier. Its stated reason was that "buildAttendance is
  // what scopes a camper to a tier" — but attendance can only EXCLUDE a camper
  // from an occurrence; it cannot re-point a preference that was bound to the
  // wrong one. So on a set placed for two tiers at the same day and period,
  // every per-cell preference belonging to whichever tier is not first landed
  // on the other tier's occurrence, `attends()` then refused it, and the
  // camper was placed as if they had ranked nothing.
  //
  // That was precisely the failure the module's own header says it exists to
  // prevent: "campers were placed in activities they had not chosen for that
  // cell, and preference_rank reported a first choice that had not been
  // honoured" — a confident wrong answer, not a visible failure.
  //
  // MEASURED on this camp before the fix, 2026-09-29: of the Older tier's 26
  // placements, 7 sat at a cell the camper DID rank and carried no rank at
  // all. Round 1 carried two different numbers for this one defect — "51 of
  // 150 / 12 of 26" here and "75 of 174 / 4 of 26" in
  // scripts/fixtures/make-preference-corpus.mjs — neither reproducible, both
  // taken at a seam that is not the database:
  // `elective_preferences.occurrence_id` is NULL on every row in this camp
  // (the parser emits no occurrence, and the cross-tier binding happens
  // later, inside resolvePreferenceCoordinates, on its way to the engine)._
  //
  // Closed by board item 9b: `resolvePreferenceCoordinates` now also builds
  // `occurrenceAtCellTier`, keyed on (day_id, time_block_id, tier_id), and
  // AssignmentPanel.jsx passes it a `tierIdByCamperId` map (from
  // `makeCamperIdentityResolver`) so a camper's cell preference binds to
  // THEIR OWN tier's occurrence when one exists — first-at-cell remains only
  // the fallback for an unidentifiable tier.
  it('Older campers who ranked a cell are placed there WITH the rank they gave it', async () => {
    const run = await solveAndCommit()
    const older = camp.fixture.tierIdByName.get('Older')
    const rows = assignmentsOf(run.id).filter((r) => r.tier_id === older)

    // Every one of these campers stated three ranked choices for this cell.
    const statedFor = new Set(camp.db.prepare(`
      SELECT camper_id || '|' || coordinate_day_label AS k FROM elective_preferences
      WHERE run_id = ? AND coordinate_day_label IS NOT NULL
    `).all(run.id).map((r) => r.k))
    const dayLabel = new Map([...camp.fixture.dayIdByLabel].map(([label, id]) => [id, label]))

    const unhonoured = rows.filter(
      (r) => r.preference_rank == null && statedFor.has(`${r.camper_id}|${dayLabel.get(r.day_id)}`)
    )
    // PINNED, not merely zero, so this file recomputes the same measurement
    // it recomputed as a gap — olderPlacements unchanged at 26, unhonoured
    // driven to 0.
    expect({ olderPlacements: rows.length, unhonoured: unhonoured.length })
      .toEqual({ olderPlacements: 26, unhonoured: 0 })
  }, 60_000)
})
