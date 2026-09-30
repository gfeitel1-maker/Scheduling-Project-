// DRIVING THE REAL AssignmentPanel to a committed run — one copy, shared by
// every T251 file that needs one.
//
// T251. See electron/electiveAcceptanceLocalClient.js for why a rendered
// component is the only honest way to reach a solve at all: no production
// module composes solver inputs from a database, so the composition exists
// only inside `solve()` at
// src/screens/elective/assignment/AssignmentPanel.jsx:611-700.
//
// This is a MODULE and not four copies for the same reason the fixture is: a
// second hand-written drive would be a second chance to click a different path
// and get a different camp, and then a disagreement between two T251 files
// would be uninterpretable.
//
// The CALLER still declares its own `vi.mock('../src/localClient', ...)` — a
// mock factory is hoisted into the file that imports the mocked module, so it
// cannot live here.
// `expect` is imported rather than taken from the globals: vitest injects those
// into *.test.* files only, and this is a helper module.
import { expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import AssignmentPanel from '../src/screens/elective/assignment/AssignmentPanel.jsx'
import { SHEET_RESOLVED, assignBunks } from './fixtures/electiveAcceptanceCamp.js'

/**
 * Every prop read out of the database through the REAL `list` IPC handler —
 * the same call ElectiveSetDetail makes. Nothing hand-built, so a prop shaped
 * differently from what the app passes cannot creep in.
 */
export function panelPropsFromDatabase(camp, { onError } = {}) {
  const list = (entity) => camp.handlers.list(camp.token, entity)
  return {
    electiveSetId: camp.fixture.electiveSetId,
    campId: camp.fixture.campId,
    setActivities: list('elective_set_activities').filter((r) => r.elective_set_id === camp.fixture.electiveSetId),
    activities: list('activities'),
    groups: list('groups'),
    tiers: list('tiers'),
    campers: list('campers'),
    days: list('days_of_operation'),
    timeBlocks: list('time_blocks'),
    templateSlots: list('template_slots'),
    scheduleTemplates: list('schedule_templates'),
    scheduleWeeks: list('schedule_weeks'),
    bundles: list('elective_bundles'),
    bundlePeriods: list('elective_bundle_periods'),
    bundleTiers: list('elective_bundle_tiers'),
    role: 'admin',
    // A null clears the banner (AssignmentPanel.jsx:343); anything else is a
    // real failure the panel surfaced, and a test that swallowed it would be
    // asserting about a panel stuck in a phase it could not explain.
    onError: onError ?? ((message) => { if (message != null) throw new Error(`AssignmentPanel reported: ${message}`) }),
    onNavigate: () => {},
  }
}

const runIds = (camp) =>
  new Set(camp.db.prepare('SELECT id FROM elective_assignment_runs').all().map((r) => r.id))

/**
 * Import the sheet, choose a route, solve, commit — and return the run the
 * commit created.
 *
 * The id is recovered by DIFFING the run table rather than read back from the
 * component or from "the newest row": elective_assignment_runs has no
 * created_at and no ordering column, so "the latest run" is not a question SQL
 * can answer here.
 */
export async function solveAndCommit(camp, props, { route = 'generated', keepMounted = false } = {}) {
  const before = runIds(camp)
  const view = render(<AssignmentPanel {...props} />)
  const input = view.container.querySelector('input[type="file"]')
  const file = new File([fs.readFileSync(SHEET_RESOLVED)], 'preferences-resolved.csv', { type: 'text/csv' })
  fireEvent.change(input, { target: { files: [file] } })

  await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy(), { timeout: 10_000 })
  fireEvent.click(screen.getByText(/Confirm Mapping/))

  // Two routes carry this set, so the panel ASKS which — the real chooser, not
  // a prop. That the question is asked is itself CLAUDE.md's "neither route is
  // canonical" showing up in the UI.
  const chooser = await screen.findByText(new RegExp(`· ${route} ·`), {}, { timeout: 10_000 })
  fireEvent.click(chooser)

  fireEvent.click(await screen.findByText(/Commit Assignments/, {}, { timeout: 10_000 }))
  let created = null
  await waitFor(() => {
    created = [...runIds(camp)].find((id) => !before.has(id)) ?? null
    expect(created).toBeTruthy()
  }, { timeout: 10_000 })
  await waitFor(
    () => expect(camp.db.prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ?').get(created).c).toBeGreaterThan(0),
    { timeout: 10_000 }
  )

  if (!keepMounted) view.unmount()
  const run = camp.db
    .prepare('SELECT id, name, status, solver_generation, source_sha256, schedule_template_id, schedule_week_id FROM elective_assignment_runs WHERE id = ?')
    .get(created)
  return keepMounted ? { ...run, view } : run
}

/**
 * The camp as a director actually has it by the time they look at a run: the
 * sheet imported, every camper in a bunk, and the run solved against that.
 *
 * TWO COMMITS, and the order is forced. Campers do not exist until the first
 * commit creates them, and `commitElectiveRun` routes a bundle-claimed
 * preference to the camper's own tier THROUGH THEIR GROUP
 * (electron/ops/commitElectiveRun.js:487-495) — so a camper with no group_id
 * has that preference skipped into `bundleTierMismatches` instead of stored.
 * Assigning bunks between the two commits is what makes the second run's
 * stored rows the ones a real camp would have.
 */
export async function solveWithRoster(camp, props, options) {
  await solveAndCommit(camp, props, options)
  await assignBunks(camp.db, {
    handlers: camp.handlers, token: camp.token,
    campId: camp.fixture.campId, groupIdByName: camp.fixture.groupIdByName,
  })
  // Board item (2026-09-30) — `props.campers` was read ONCE by the caller,
  // before assignBunks wrote real bunk group_ids. A real screen re-mounts
  // (ElectiveSetDetail/ScheduleElectivesScreen's own `load()`) and would see
  // the fresh roster; re-reading it here is what keeps this SECOND solve
  // faithful to "the camp as a director actually has it" (this function's own
  // doc comment above) rather than solving against a stale pre-bunk snapshot.
  const refreshedProps = { ...props, campers: camp.handlers.list(camp.token, 'campers') }
  return solveAndCommit(camp, refreshedProps, options)
}
