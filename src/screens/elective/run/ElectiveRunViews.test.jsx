// @vitest-environment jsdom
//
// T250 — the Draft and Final director UI for a persisted elective run.
//
// Every test below is named for the clause of T250's `archive_when` it proves.
// The clause list, split out verbatim:
//
//   Draft:  move/lock | regenerate with staleness offer | run list |
//           satisfaction summary | overCapacityOccurrences live |
//           DANGLING_MANUAL_ASSIGNMENT live
//   Final:  read-only identity | export | start-a-revision |
//           finalizedAgainstStaleGeneration inline in the run's own run-state
//           area (NOT the schedule findings vocabulary) | overCapacityOccurrences
//   Both:   reachable only by admin
//
// The finalizedAgainstStaleGeneration clause is load-bearing beyond its own
// test: the owner accepted "a finalized run is immutable, a revision is a new
// run, no reopen" AS A PACKAGE with that detection being shown to the director
// (T250's ticket, "Owner ruling, 2026-09-23 — binding condition"). A test that
// passes whether or not the detection is visible would let the immutability
// ruling silently stand on one leg. `renders the stale-generation state ...`
// below is that guard, and it is required to go RED if the rendering is
// removed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('../../../localClient', () => ({
  localClient: {
    listElectiveRuns: vi.fn(),
    getElectiveRun: vi.fn(),
    setElectiveAssignment: vi.fn(),
    getElectiveRunOuterSchedule: vi.fn(),
    list: vi.fn(),
  },
}))

import { localClient } from '../../../localClient'
import RunList from './RunList.jsx'
import DraftRunView from './DraftRunView.jsx'
import FinalRunView from './FinalRunView.jsx'
import { prefersReducedMotion } from '../../../styles/shared'
import { RELEASE_LOCK_LABEL, START_REVISION_LABEL, STALE_GENERATION_COPY } from './runStateCopy.js'

// Fabricated names only — real camper data is refused at a tested gate until
// at-rest encryption ships (T249 / ADR 2026-09-23 Q4), and the privacy guard
// cannot catch a realistic name on its own.
const CAMPERS = [
  { id: 'camper-1', display_name: 'Testcamper Alpha', group_id: 'grp-1' },
  { id: 'camper-2', display_name: 'Testcamper Bravo', group_id: 'grp-1' },
  { id: 'camper-3', display_name: 'Testcamper Charlie', group_id: 'grp-1' },
]
const ACTIVITIES = [{ id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Pottery' }]
const DAYS = [{ id: 'day-1', name: 'Monday' }]
const TIME_BLOCKS = [{ id: 'tb-1', name: 'First Period' }]
const GROUPS = [{ id: 'grp-1', name: 'Cabin One', tier_id: 'tier-1' }]
const TIERS = [{ id: 'tier-1', name: 'Juniors' }]
const OCCURRENCES = [
  { id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
  { id: 'occ-2', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
]
const SCHEDULE_TEMPLATES = [{ id: 'tpl-1', name: 'Manual', kind: 'manual', week_id: 'wk-1' }]
const SCHEDULE_WEEKS = [{ id: 'wk-1', name: 'Week 2' }]

const DRAFT_RUN = {
  id: 'run-1', name: 'Elective assignment — 2026-09-25', status: 'draft',
  source_filename: 'fabricated-camper-preferences-a.csv',
  schedule_template_id: 'tpl-1', schedule_week_id: 'wk-1', tier_id: 'tier-1',
}
const FINAL_RUN = {
  ...DRAFT_RUN, id: 'run-2', name: 'Elective assignment — 2026-09-20', status: 'final',
  finalized_at: '2026-09-24T14:05:00.000Z', finalized_by: 'user-director',
}

function rows(overrides = []) {
  return [
    { id: 'a1', occurrence_id: 'occ-1', camper_id: 'camper-1', activity_id: 'act-1', preference_rank: 1, camper_name: 'Testcamper Alpha', source: 'solver', is_locked: 0 },
    { id: 'a2', occurrence_id: 'occ-1', camper_id: 'camper-2', activity_id: 'act-1', preference_rank: 2, camper_name: 'Testcamper Bravo', source: 'solver', is_locked: 0 },
    { id: 'a3', occurrence_id: 'occ-2', camper_id: 'camper-3', activity_id: 'act-2', preference_rank: null, camper_name: 'Testcamper Charlie', source: 'manual', is_locked: 1 },
    ...overrides,
  ]
}

const CLEAN_RUN_STATE = {
  rows: rows(), staleCount: 0, finalizedAgainstStaleGeneration: false, overCapacityOccurrences: [],
}

function catalogs() {
  return {
    activities: ACTIVITIES, days: DAYS, timeBlocks: TIME_BLOCKS, groups: GROUPS,
    tiers: TIERS, occurrences: OCCURRENCES,
    scheduleTemplates: SCHEDULE_TEMPLATES, scheduleWeeks: SCHEDULE_WEEKS,
  }
}

beforeEach(() => {
  localClient.listElectiveRuns.mockReset().mockResolvedValue([DRAFT_RUN, FINAL_RUN])
  localClient.getElectiveRun.mockReset().mockResolvedValue(CLEAN_RUN_STATE)
  localClient.setElectiveAssignment.mockReset().mockResolvedValue({ ok: true, assignmentId: 'a1' })
  localClient.getElectiveRunOuterSchedule.mockReset().mockResolvedValue({ rows: [], runStatus: 'final' })
  localClient.list.mockReset().mockResolvedValue(CAMPERS)
})

// ---------------------------------------------------------------------------
// archive_when: Draft — "run list"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Draft: run list', () => {
  it('lists each persisted run with its name, status and source filename, and opens the one clicked', async () => {
    const onOpen = vi.fn()
    render(<RunList onOpen={onOpen} />)
    await waitFor(() => expect(screen.getByText(/Elective assignment — 2026-09-25/)).toBeTruthy())

    const draftRow = screen.getByTestId('run-list-row-run-1')
    expect(within(draftRow).getByText('Draft')).toBeTruthy()
    expect(within(draftRow).getByText(/fabricated-camper-preferences-a\.csv/)).toBeTruthy()
    expect(within(screen.getByTestId('run-list-row-run-2')).getByText('Final')).toBeTruthy()

    fireEvent.click(draftRow)
    expect(onOpen).toHaveBeenCalledWith(DRAFT_RUN)
  })
})

// ---------------------------------------------------------------------------
// archive_when: Draft — "satisfaction summary"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Draft: satisfaction summary', () => {
  it('states how many campers are placed and how the preference ranks they received break down', async () => {
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const summary = await screen.findByTestId('run-satisfaction-summary')
    // Three placements: rank 1, rank 2, and one with no rank (placed by hand,
    // outside the campers own preferences).
    expect(summary.textContent).toMatch(/3 campers placed/)
    expect(summary.textContent).toMatch(/1 got a first choice/)
    expect(summary.textContent).toMatch(/1 a second choice/)
    expect(summary.textContent).toMatch(/1 placed outside their preferences/)
  })
})

// ---------------------------------------------------------------------------
// archive_when: Draft — "overCapacityOccurrences ... surfaced live"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Draft: overCapacityOccurrences surfaced live', () => {
  it('renders one row per over-full occurrence on a DRAFT run, without any finalize having happened', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      overCapacityOccurrences: [{ occurrenceId: 'occ-1', activityId: 'act-1', capacity: 1, filled: 2 }],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-over-capacity-occ-1-act-1')
    expect(row.textContent).toBe('Archery — Monday, First Period has 2 campers assigned against a capacity of 1.')
    // A pointer, not a control — the remedy is the move/lock table below.
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('renders nothing at all in the run-state area when there is nothing to report', async () => {
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    await screen.findByTestId('run-satisfaction-summary')
    expect(screen.queryByTestId('run-state-area')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// archive_when: Draft — "DANGLING_MANUAL_ASSIGNMENT ... surfaced live"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Draft: DANGLING_MANUAL_ASSIGNMENT surfaced live', () => {
  const dangling = [{
    kind: 'DANGLING_MANUAL_ASSIGNMENT', assignment_id: 'a3',
    camper_id: 'camper-3', occurrence_id: 'occ-gone', message: 'ignored — T250 owns this screens copy',
  }]

  it('names the affected camper and offers Release lock, which drops the lock via setElectiveAssignment', async () => {
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    expect(row.textContent).toMatch(
      /Testcamper Charlie's locked placement no longer matches this run — regenerating removed the occurrence it pointed to\./
    )

    fireEvent.click(within(row).getByRole('button', { name: 'Release lock' }))
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalled())
    expect(localClient.setElectiveAssignment).toHaveBeenCalledWith({
      runId: 'run-1', camperId: 'camper-3', occurrenceId: 'occ-gone', activityId: 'act-2', locked: false,
    })
    // Round 2: the row does NOT go away. Releasing the lock does not resolve
    // the dangling condition — see the FIX 2 describe block below.
    await waitFor(() =>
      expect(within(screen.getByTestId('run-state-dangling-a3')).queryByRole('button')).toBeNull())
  })

  it('orders over-capacity rows before dangling rows, per the spec fixed order', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      overCapacityOccurrences: [{ occurrenceId: 'occ-1', activityId: 'act-1', capacity: 1, filled: 2 }],
    })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const area = await screen.findByTestId('run-state-area')
    const ids = [...area.querySelectorAll('[data-testid^="run-state-"]')].map((n) => n.dataset.testid)
    expect(ids).toEqual(['run-state-over-capacity-occ-1-act-1', 'run-state-dangling-a3'])
  })

  it('surfaces a failed Release lock write instead of swallowing it', async () => {
    localClient.setElectiveAssignment.mockResolvedValue({ ok: false, error: 'RUN_NOT_DRAFT' })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    fireEvent.click(within(row).getByRole('button', { name: 'Release lock' }))
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/RUN_NOT_DRAFT/))
    // ...and the row stays, because nothing was resolved.
    expect(screen.getByTestId('run-state-dangling-a3')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// archive_when: Draft — "move/lock"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Draft: move/lock', () => {
  it('moves a camper to a different occurrence through setElectiveAssignment', async () => {
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row = await screen.findByTestId('placement-row-a1')
    fireEvent.change(within(row).getByTestId('placement-occurrence-a1'), { target: { value: 'occ-2' } })
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalled())
    expect(localClient.setElectiveAssignment).toHaveBeenCalledWith({
      runId: 'run-1', camperId: 'camper-1', occurrenceId: 'occ-2', activityId: 'act-1', locked: true,
    })
  })

  it('locks a placement through setElectiveAssignment and reflects the new lock state', async () => {
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row = await screen.findByTestId('placement-row-a1')
    const lock = within(row).getByTestId('placement-lock-a1')
    expect(lock.checked).toBe(false)
    fireEvent.click(lock)
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalledWith({
      runId: 'run-1', camperId: 'camper-1', occurrenceId: 'occ-1', activityId: 'act-1', locked: true,
    }))
    await waitFor(() => expect(within(screen.getByTestId('placement-row-a1')).getByTestId('placement-lock-a1').checked).toBe(true))
  })

  it('surfaces a failed move instead of swallowing it', async () => {
    localClient.setElectiveAssignment.mockResolvedValue({ ok: false, error: 'OCCURRENCE_FULL' })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row = await screen.findByTestId('placement-row-a1')
    fireEvent.change(within(row).getByTestId('placement-occurrence-a1'), { target: { value: 'occ-2' } })
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/OCCURRENCE_FULL/))
  })
})

// ---------------------------------------------------------------------------
// archive_when: Draft — "regenerate with staleness offer"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Draft: regenerate with staleness offer', () => {
  it('offers re-derive and regenerate inline when staleCount > 0, and never blocks the screen', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, staleCount: 4 })
    const onRegenerate = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onRegenerate={onRegenerate} {...catalogs()} />)
    const offer = await screen.findByTestId('run-staleness-offer')
    expect(offer.textContent).toMatch(/4 placements/)
    // Not a block: the move/lock table is still there and still usable.
    expect(screen.getByTestId('placement-row-a1')).toBeTruthy()
    fireEvent.click(within(offer).getByRole('button', { name: /Re-derive and regenerate/i }))
    expect(onRegenerate).toHaveBeenCalled()
  })

  it('hands the run’s locked placements to the regenerate caller so they survive the re-solve', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, staleCount: 1 })
    const onRegenerate = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onRegenerate={onRegenerate} {...catalogs()} />)
    const offer = await screen.findByTestId('run-staleness-offer')
    fireEvent.click(within(offer).getByRole('button', { name: /Re-derive and regenerate/i }))
    // rows()'s third row is the locked one.
    expect(onRegenerate).toHaveBeenCalledWith({
      lockedAssignments: [{ camperId: 'camper-3', occurrenceId: 'occ-2', activityId: 'act-2' }],
    })
  })

  it('makes no staleness offer when nothing is stale', async () => {
    render(<DraftRunView run={DRAFT_RUN} onRegenerate={vi.fn()} {...catalogs()} />)
    await screen.findByTestId('run-satisfaction-summary')
    expect(screen.queryByTestId('run-staleness-offer')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// archive_when: Final — "read-only identity"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Final: read-only run identity', () => {
  it('states source file, route/week/division, finalized_at and finalized_by, and offers no editing control', async () => {
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    const identity = await screen.findByTestId('run-identity')
    expect(identity.textContent).toMatch(/fabricated-camper-preferences-a\.csv/)
    expect(identity.textContent).toMatch(/Manual/)
    expect(identity.textContent).toMatch(/Week 2/)
    expect(identity.textContent).toMatch(/Juniors/)
    expect(identity.textContent).toMatch(/2026-09-24/)
    expect(identity.textContent).toMatch(/user-director/)
    expect(identity.textContent).toMatch(/Final/)
    // Immutable: no move/lock table on a Final run.
    expect(screen.queryByTestId('placement-row-a1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// archive_when: Final — "finalizedAgainstStaleGeneration ... surfaced inline in
// the run's own displayed run-state area on this screen, not via the schedule
// findings vocabulary"
//
// THE CENTRAL CLAUSE. See the header note.
// ---------------------------------------------------------------------------
describe('T250 archive_when — Final: finalizedAgainstStaleGeneration surfaced inline with its remedy', () => {
  beforeEach(() => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, finalizedAgainstStaleGeneration: true })
  })

  it('renders the stale-generation state inline, in the run’s own run-state area, in the verbatim copy', async () => {
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-stale-generation')
    expect(row.textContent).toBe(STALE_GENERATION_COPY)
    // Inline on this screen, inside the run-state area — not routed through the
    // schedule findings vocabulary (FindingsRail, which is week-scoped and has
    // no run-level row), and not a banner.
    expect(screen.getByTestId('run-state-area').contains(row)).toBe(true)
  })

  it('places the stale-generation state and its remedy together as one unit', async () => {
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    const pairing = await screen.findByTestId('run-state-stale-pairing')
    // Both halves live in the same block: the state, then the action that
    // resolves it, with nothing between them.
    expect(within(pairing).getByTestId('run-state-stale-generation')).toBeTruthy()
    expect(within(pairing).getByRole('button', { name: START_REVISION_LABEL })).toBeTruthy()
  })

  it('renders exactly one Start a revision control even when the stale state is showing', async () => {
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    await screen.findByTestId('run-state-stale-generation')
    expect(screen.getAllByRole('button', { name: START_REVISION_LABEL })).toHaveLength(1)
  })

  it('renders nothing in the run-state area when the run is not stale and not over capacity', async () => {
    localClient.getElectiveRun.mockResolvedValue(CLEAN_RUN_STATE)
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    await screen.findByTestId('run-identity')
    expect(screen.queryByTestId('run-state-area')).toBeNull()
    expect(screen.queryByTestId('run-state-stale-generation')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// archive_when: Final — "overCapacityOccurrences"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Final: overCapacityOccurrences', () => {
  it('renders one row per over-full occurrence, with no action button of its own', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      overCapacityOccurrences: [{ occurrenceId: 'occ-2', activityId: 'act-2', capacity: 2, filled: 5 }],
    })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-over-capacity-occ-2-act-2')
    expect(row.textContent).toBe('Pottery — Monday, First Period has 5 campers assigned against a capacity of 2.')
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('puts the stale-generation pairing above the over-capacity rows when both are present', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      finalizedAgainstStaleGeneration: true,
      overCapacityOccurrences: [{ occurrenceId: 'occ-2', activityId: 'act-2', capacity: 2, filled: 5 }],
    })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    const area = await screen.findByTestId('run-state-area')
    const ids = [...area.querySelectorAll('[data-testid^="run-state-"]')]
      .map((n) => n.dataset.testid)
      .filter((id) => id !== 'run-state-stale-pairing')
    expect(ids).toEqual(['run-state-stale-generation', 'run-state-over-capacity-occ-2-act-2'])
  })
})

// ---------------------------------------------------------------------------
// archive_when: Final — "export"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Final: export', () => {
  let created
  beforeEach(() => {
    created = []
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn((b) => { created.push(b); return 'blob:x' }), revokeObjectURL: vi.fn() })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('builds the per-camper child schedule from the run’s outer schedule and hands it over as a download', async () => {
    localClient.getElectiveRunOuterSchedule.mockResolvedValue({
      rows: [{ camperId: 'camper-1', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', locationId: null, locationName: null, spanBlocks: 1 }],
      runStatus: 'final',
    })
    const click = vi.fn()
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'a') el.click = click
      return el
    })

    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Export$/ }))

    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(localClient.getElectiveRunOuterSchedule).toHaveBeenCalledWith({ runId: 'run-2' })
    const payload = JSON.parse(await created[0].text())
    expect(payload.format_version).toBe(1)
    expect(payload.run_id).toBe('run-2')
    expect(payload.run_status).toBe('final')
    const alpha = payload.campers.find((c) => c.camper_id === 'camper-1')
    expect(alpha.schedule).toEqual([
      { day: 'Monday', time_block: 'First Period', activity_name: 'Archery', location_name: null, span_blocks: 1 },
    ])
    document.createElement.mockRestore()
  })

  it('surfaces an export failure instead of silently producing nothing', async () => {
    localClient.getElectiveRunOuterSchedule.mockRejectedValue(new Error('outer schedule unavailable'))
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Export$/ }))
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/That export could not be produced\./))
  })
})

// ---------------------------------------------------------------------------
// archive_when: Final — "start-a-revision"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Final: start a revision', () => {
  it('starts a NEW run and never reopens this one', async () => {
    const onStartRevision = vi.fn()
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} onStartRevision={onStartRevision} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: START_REVISION_LABEL }))
    expect(onStartRevision).toHaveBeenCalledWith(FINAL_RUN)
    // Nothing on this screen writes to the finalized run.
    expect(localClient.setElectiveAssignment).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// archive_when: "both built and reachable only by admin"
//
// The run views are mounted inside AssignmentPanel, which sits under
// ElectiveSetDetail. The admin gate is INHERITED there (the participant
// entities are absent from permissions.js's ENTITIES, so authorize()
// default-denies staff) rather than re-implemented — so what has to be pinned
// is that T250 adds no second, staff-reachable route to these screens.
//
// Exercised against a FINDINGS-PRESENT view, not the clean one: the clean state
// renders nothing at all, so a reachability assertion made against it would
// pass vacuously.
// ---------------------------------------------------------------------------
describe('T250 archive_when — reachable only by admin', () => {
  const NAV = path.join(process.cwd(), 'src/components/layout/navSections.js')

  it('adds no elective-run row to the staff navigation', () => {
    const nav = fs.readFileSync(NAV, 'utf8')
    expect(nav).not.toMatch(/elective[-_ ]?run/i)
    expect(nav).not.toMatch(/RunList|DraftRunView|FinalRunView/)
  })

  it('reaches a findings-present run view only through AssignmentPanel, which is not itself a navigable screen', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, finalizedAgainstStaleGeneration: true })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    // Non-vacuous: this view IS rendering run state right now.
    expect(await screen.findByTestId('run-state-stale-generation')).toBeTruthy()

    const panel = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/elective/assignment/AssignmentPanel.jsx'), 'utf8')
    expect(panel).toMatch(/from '\.\.\/run\/FinalRunView\.jsx'/)
    expect(panel).toMatch(/from '\.\.\/run\/DraftRunView\.jsx'/)
    expect(panel).toMatch(/from '\.\.\/run\/RunList\.jsx'/)

    const nav = fs.readFileSync(NAV, 'utf8')
    expect(nav).not.toMatch(/AssignmentPanel|ElectiveSetDetail/)
  })
})

// ---------------------------------------------------------------------------
// Q5 is still open with the owner. The label ships as the existing wording and
// must stay a single named constant so a one-line change swaps it.
// ---------------------------------------------------------------------------
describe('T250 — Q5 terminology is a single swappable constant', () => {
  it('ships the existing Start a revision wording from one named constant', () => {
    expect(START_REVISION_LABEL).toBe('Start a revision')
    // Comments stripped first: the phrase is allowed to be DISCUSSED in this
    // file, but never written as the label. Anything left is a hardcoded
    // duplicate that a one-line answer to Q5 would silently miss.
    const src = fs
      .readFileSync(path.join(process.cwd(), 'src/screens/elective/run/FinalRunView.jsx'), 'utf8')
      .replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/Start a revision/)
  })
})

// ---------------------------------------------------------------------------
// Round 2, FIX 1 — a failed state read must not present as a clean run.
//
// useRunState's EMPTY default carries all-clear values
// (finalizedAgainstStaleGeneration: false, overCapacityOccurrences: []), and
// RunStateArea renders nothing when it has nothing to say. Those two are
// correct on their own and catastrophic together: read `state` without first
// establishing that the read SUCCEEDED and a thrown getElectiveRun renders a
// screen indistinguishable from a clean finalized run, with Export and the
// revision action both live. An unknown is not "not stale".
//
// This is the ticket's own failure — "a detection nobody renders is
// functionally no detection" — reproduced one layer up, so the guard below is
// required to go RED if FinalRunView ever reads run state ungated again.
// ---------------------------------------------------------------------------
describe('T250 round 2 — Final: an unread run never reads as a clean one', () => {
  it('says the read failed and offers neither the run-state area nor any action', async () => {
    localClient.getElectiveRun.mockRejectedValue(new Error('run state unavailable'))
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} onStartRevision={vi.fn()} {...catalogs()} />)

    await waitFor(() => expect(screen.getByTestId('run-view-error')).toBeTruthy())
    // The identity line still says which run this is — that much is known.
    expect(screen.getByTestId('run-identity')).toBeTruthy()
    // Everything derived from the unread state is absent, including the
    // absence-of-findings reading that an all-clear default would produce.
    expect(screen.queryByTestId('run-state-area')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Export$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: START_REVISION_LABEL })).toBeNull()
  })

  // The defect the description above would NOT lead you to: gating on
  // `loadError` alone still leaves the whole in-flight window — every render
  // between mount and the promise settling — presenting as a clean run with
  // live actions. Only a positive `loaded` gate closes it.
  it('offers no action while the state read is still in flight', async () => {
    let settle
    localClient.getElectiveRun.mockReturnValue(new Promise((resolve) => { settle = resolve }))
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} onStartRevision={vi.fn()} {...catalogs()} />)

    expect(await screen.findByTestId('run-identity')).toBeTruthy()
    expect(screen.queryByTestId('run-view-error')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Export$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: START_REVISION_LABEL })).toBeNull()

    settle({ ...CLEAN_RUN_STATE, finalizedAgainstStaleGeneration: true })
    // ...and once the read lands, the state it actually carries is shown.
    expect(await screen.findByTestId('run-state-stale-generation')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Round 2, FIX 2 — Release lock must not claim a fix it did not make.
//
// setElectiveAssignment writes source:'manual' on EVERY write through that
// path (electron/ops/setElectiveAssignment.js), and commitElectiveRun derives
// DANGLING_MANUAL_ASSIGNMENT from source='manual' rows whose occurrence_id is
// outside the derived occurrence set — keyed on `source`, never on `is_locked`.
// Releasing the lock therefore changes nothing about the dangling condition:
// the next regenerate re-reports the identical row. A row that vanishes on
// click tells the director it is fixed. It is not.
// ---------------------------------------------------------------------------
describe('T250 round 2 — Draft: Release lock does not pretend to resolve the dangling row', () => {
  const dangling = [{
    kind: 'DANGLING_MANUAL_ASSIGNMENT', assignment_id: 'a3',
    camper_id: 'camper-3', occurrence_id: 'occ-gone', message: 'ignored — T250 owns this screens copy',
  }]

  it('keeps the row after a successful release, and retires only the action it actually performed', async () => {
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    fireEvent.click(within(row).getByRole('button', { name: RELEASE_LOCK_LABEL }))
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalled())

    // The lock is genuinely gone, so its control is gone...
    await waitFor(() =>
      expect(within(screen.getByTestId('run-state-dangling-a3')).queryByRole('button')).toBeNull())
    // ...but the dangling condition is untouched, so the row stays.
    expect(screen.getByTestId('run-state-dangling-a3')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Round 2, FIX 3 — a remedy that is unavailable must not be silently absent.
//
// AssignmentPanel only passes onRegenerate when a parsed sheet is in hand and
// the run is the one this session just committed. On a run opened cold from
// RunList neither holds, so the ENTIRE staleness offer used to vanish —
// staleCount > 0 and not a word about it. The fact is the director's to know
// whether or not this session can act on it.
// ---------------------------------------------------------------------------
describe('T250 round 2 — Draft: staleness is stated even when regenerate is unavailable', () => {
  it('states the stale placement count with no regenerate control when none is offered', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, staleCount: 3 })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const offer = await screen.findByTestId('run-staleness-offer')
    expect(offer.textContent).toMatch(/3 placements in this run came from an earlier version/)
    expect(within(offer).queryByRole('button')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Round 2, FIX 4 — a screen that already has findings when it mounts renders
// at rest (docs/work/specs/2026-09-25-t250-run-state-surface.md, "Animation").
//
// Round 1 applied useEnterTransition('liftFade') to the whole run-state area,
// which fires on EVERY mount: a Final run opened cold with a stale flag
// already set animated in. The spec reserves motion for a transition INTO a
// new state during an active session, and these screens have none.
// ---------------------------------------------------------------------------
describe('T250 round 2 — the run-state area renders at rest on first mount', () => {
  function assertAtRest() {
    const area = screen.getByTestId('run-state-area')
    for (const node of [area, ...area.querySelectorAll('[data-testid^="run-state-"]')]) {
      expect(node.style.transition).toBe('')
      expect(node.style.transform).toBe('')
      expect(node.style.opacity).toBe('')
    }
  }

  it('gives a cold-opened Final run with a stale flag no entrance animation', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, finalizedAgainstStaleGeneration: true })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    await screen.findByTestId('run-state-stale-generation')
    assertAtRest()
  })

  it('renders at rest under prefers-reduced-motion too, so no branch reintroduces motion', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    expect(prefersReducedMotion()).toBe(true)
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      overCapacityOccurrences: [{ occurrenceId: 'occ-1', activityId: 'act-1', capacity: 1, filled: 2 }],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    await screen.findByTestId('run-state-over-capacity-occ-1-act-1')
    assertAtRest()
    vi.unstubAllGlobals()
  })
})
