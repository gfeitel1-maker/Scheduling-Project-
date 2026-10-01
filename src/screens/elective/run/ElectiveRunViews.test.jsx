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
    finalizeElectiveRun: vi.fn(),
    deleteElectiveRun: vi.fn(),
  },
}))

// F6 (round 2): buildElectiveRunProjectionExport/buildElectiveRunWorkbook were built and tested in
// isolation but wired to nothing — this mock lets the "Export Full Report" wiring test assert the
// real XLSX write happened without touching the filesystem, same pattern as ActivitiesScreen.test.jsx.
vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    sheet_to_json: vi.fn(() => []),
    aoa_to_sheet: vi.fn(() => ({})),
  },
  writeFile: vi.fn(),
  read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
}))

import { localClient } from '../../../localClient'
import RunList from './RunList.jsx'
import DraftRunView from './DraftRunView.jsx'
import FinalRunView from './FinalRunView.jsx'
import { prefersReducedMotion } from '../../../styles/shared'
import { START_REVISION_LABEL, STALE_GENERATION_COPY } from './runStateCopy.js'
import { DELETE_RUN_COST_COPY } from './DeleteRunDialog.jsx'

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
  finalized_at: '2026-09-24T14:05:00.000Z', finalized_by: 'user-director', finalized_by_name: 'Testdirector Dana',
}

function rows(overrides = []) {
  return [
    { id: 'a1', occurrence_id: 'occ-1', camper_id: 'camper-1', activity_id: 'act-1', choice_id: 'choice-1', preference_rank: 1, camper_name: 'Testcamper Alpha', source: 'solver', is_locked: 0 },
    { id: 'a2', occurrence_id: 'occ-1', camper_id: 'camper-2', activity_id: 'act-1', choice_id: 'choice-2', preference_rank: 2, camper_name: 'Testcamper Bravo', source: 'solver', is_locked: 0 },
    { id: 'a3', occurrence_id: 'occ-2', camper_id: 'camper-3', activity_id: 'act-2', preference_rank: null, camper_name: 'Testcamper Charlie', source: 'manual', is_locked: 1 },
    ...overrides,
  ]
}

const CLEAN_RUN_STATE = {
  // T318 (b) — the run's own persisted occurrence set, always present even when
  // a run is opened cold from the run list (unlike templateOccurrences, which
  // is AssignmentPanel React state and empty on that path).
  rows: rows(), staleCount: 0, finalizedAgainstStaleGeneration: false, overCapacityOccurrences: [],
  occurrences: OCCURRENCES, campers: CAMPERS,
}

function catalogs() {
  return {
    activities: ACTIVITIES, days: DAYS, timeBlocks: TIME_BLOCKS, groups: GROUPS,
    // T296 renamed this prop: it is the CURRENT template's occurrence set, not
    // the run's own (which now arrives via getElectiveRun as state.occurrences).
    tiers: TIERS, templateOccurrences: OCCURRENCES,
    scheduleTemplates: SCHEDULE_TEMPLATES, scheduleWeeks: SCHEDULE_WEEKS,
  }
}

beforeEach(() => {
  localClient.listElectiveRuns.mockReset().mockResolvedValue([DRAFT_RUN, FINAL_RUN])
  localClient.getElectiveRun.mockReset().mockResolvedValue(CLEAN_RUN_STATE)
  localClient.setElectiveAssignment.mockReset().mockResolvedValue({ ok: true, assignmentId: 'a1' })
  localClient.getElectiveRunOuterSchedule.mockReset().mockResolvedValue({ rows: [], runStatus: 'final' })
  localClient.list.mockReset().mockResolvedValue(CAMPERS)
  localClient.finalizeElectiveRun.mockReset()
  localClient.deleteElectiveRun.mockReset()
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
// T250 A1 + A2 — Finalize control and its inline refusals.
// ---------------------------------------------------------------------------
describe('T250 A1 — Finalize run', () => {
  it('calls finalizeElectiveRun and, on success, hands the finalized run to onFinalized', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({ ok: true, finalizedAt: '2026-09-30T12:00:00.000Z', snapshotRows: 3 })
    const onFinalized = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onFinalized={onFinalized} {...catalogs()} />)
    const button = await screen.findByRole('button', { name: 'Finalize run' })
    fireEvent.click(button)
    await waitFor(() => expect(localClient.finalizeElectiveRun).toHaveBeenCalledWith({ runId: 'run-1' }))
    await waitFor(() => expect(onFinalized).toHaveBeenCalled())
    const finalized = onFinalized.mock.calls[0][0]
    expect(finalized.status).toBe('final')
    expect(finalized.finalized_at).toBe('2026-09-30T12:00:00.000Z')
  })

  it('disables the button and shows Finalizing… while the write is in flight', async () => {
    let resolveFinalize
    localClient.finalizeElectiveRun.mockReturnValue(new Promise((resolve) => { resolveFinalize = resolve }))
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} {...catalogs()} />)
    const button = await screen.findByRole('button', { name: 'Finalize run' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finalizing…' }).disabled).toBe(true))
    resolveFinalize({ ok: true, finalizedAt: 'x', snapshotRows: 0 })
  })

  // Round 2 FIX 5(c) (Code Reviewer, LOW) — finalizeRun() had only
  // `disabled={finalizing}`, a state-driven guard that cannot close the
  // window between a tablet double-tap and React's next re-render (the same
  // reason AssignmentPanel's commit() carries a synchronous `committingRef`
  // alongside its own `committing` prop — see that comment). Two clicks
  // fired in the same tick both land before React flushes the disabled
  // state, so both invoked finalizeElectiveRun.
  it('a second click while finalizing does not issue a second finalizeElectiveRun call', async () => {
    let resolveFinalize
    localClient.finalizeElectiveRun.mockImplementation(
      () => new Promise((resolve) => { resolveFinalize = resolve })
    )
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} {...catalogs()} />)
    const button = await screen.findByRole('button', { name: 'Finalize run' })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(localClient.finalizeElectiveRun).toHaveBeenCalledTimes(1)
    resolveFinalize({ ok: true, finalizedAt: 'x', snapshotRows: 0 })
  })

  it('STALE_OUTER_SCHEDULE renders the verbatim copy paired with a Re-derive and regenerate action', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({ ok: false, error: 'STALE_OUTER_SCHEDULE', findings: [{ kind: 'OCCURRENCE_REMOVED', occurrenceId: 'occ-1' }] })
    const onRegenerate = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} onRegenerate={onRegenerate} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    const row = await screen.findByText(/This run's schedule changed on another device since you last regenerated/)
    const action = screen.getByRole('button', { name: /Re-derive and regenerate/i })
    fireEvent.click(action)
    expect(onRegenerate).toHaveBeenCalled()
    void row
  })

  it('OUTER_RESOURCE_CONFLICT renders the verbatim copy with no action button', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({ ok: false, error: 'OUTER_RESOURCE_CONFLICT', findings: [{ locationId: 'loc-1' }] })
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    const row = await screen.findByText(/A location or activity this run depends on is now double-booked/)
    expect(within(row.closest('[role="alert"]')).queryByRole('button')).toBeNull()
  })

  // C2 — findRouteConflicts (src/engine/routeConflicts.js) findings carry NO
  // `.message`, only locationName/dayId/blockId/capacity/occupants. The
  // findings LIST used to fall through to the raw `.kind`, printing
  // "OUTER_RESOURCE_CONFLICT" verbatim for every conflict. It must now name
  // the location, the day/period, and the colliding activities instead.
  it('a REAL (no-.message) OUTER_RESOURCE_CONFLICT finding names the location, day/period, and colliding activities — never the raw kind code', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({
      ok: false, error: 'OUTER_RESOURCE_CONFLICT',
      findings: [{
        kind: 'OUTER_RESOURCE_CONFLICT', locationId: 'loc-1', locationName: 'Boathouse',
        dayId: 'day-1', blockId: 'tb-1', capacity: 1,
        occupants: [{ groupId: 'g1', cohortId: null, label: 'Canoeing', sourceKind: 'activity', sourceId: 'act-1' },
                    { groupId: 'g2', cohortId: null, label: 'Kayaking', sourceKind: 'activity', sourceId: 'act-2' }],
      }],
    })
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    const row = await screen.findByTestId('run-state-finalize-refusal')
    expect(row.textContent).toContain('Boathouse')
    expect(row.textContent).toContain('Monday')
    expect(row.textContent).toContain('Canoeing')
    expect(row.textContent).toContain('Kayaking')
    expect(row.textContent).not.toContain('OUTER_RESOURCE_CONFLICT')
  })

  it('ALREADY_FINAL reloads and transitions to the finalized run', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({ ok: false, error: 'ALREADY_FINAL' })
    const onFinalized = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onFinalized={onFinalized} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    await waitFor(() => expect(onFinalized).toHaveBeenCalled())
    expect(onFinalized.mock.calls[0][0].status).toBe('final')
  })

  it('an unrecognised error string renders verbatim, with nothing changed', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({ ok: false, error: 'run has no assignments' })
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    await screen.findByText(/Finalizing failed: run has no assignments\. Nothing was changed/)
  })

  it('renders up to 3 findings as a list, collapsing the remainder behind "+N more"', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({
      ok: false, error: 'OUTER_RESOURCE_CONFLICT',
      findings: [
        { locationId: 'loc-1', message: 'Finding one' },
        { locationId: 'loc-2', message: 'Finding two' },
        { locationId: 'loc-3', message: 'Finding three' },
        { locationId: 'loc-4', message: 'Finding four' },
        { locationId: 'loc-5', message: 'Finding five' },
      ],
    })
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    const row = await screen.findByTestId('run-state-finalize-refusal')
    const lists = row.querySelectorAll('ul')
    expect(lists[0].querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByText('+2 more')).toBeTruthy()
  })

  it('the refusal row is an alert and receives focus', async () => {
    localClient.finalizeElectiveRun.mockResolvedValue({ ok: false, error: 'OUTER_RESOURCE_CONFLICT', findings: [] })
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    const row = await screen.findByRole('alert')
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  // F4 (Red Hat round 3) — via the Finalize button alone, a SECOND, DIFFERENT
  // refusal already re-focuses correctly: finalizeRun() calls
  // setFinalizeRefusal(null) before every attempt, which unmounts/remounts
  // FinalizeRefusalRow and re-runs its mount effect regardless of the
  // `[alert]` dependency array. Pinned here as a baseline, not the bug.
  it('a SECOND, DIFFERENT refusal from a second Finalize click re-focuses', async () => {
    localClient.finalizeElectiveRun.mockResolvedValueOnce({ ok: false, error: 'STALE_OUTER_SCHEDULE', findings: [] })
    render(<DraftRunView run={DRAFT_RUN} onFinalized={vi.fn()} onRegenerate={vi.fn()} {...catalogs()} />)
    const button = await screen.findByRole('button', { name: 'Finalize run' })
    fireEvent.click(button)
    const firstRow = await screen.findByRole('alert')
    expect(firstRow.textContent).toMatch(/This run's schedule changed on another device/)
    await waitFor(() => expect(document.activeElement).toBe(firstRow))

    button.focus()
    localClient.finalizeElectiveRun.mockResolvedValueOnce({ ok: false, error: 'OUTER_RESOURCE_CONFLICT', findings: [] })
    fireEvent.click(button)
    await waitFor(() => {
      const row = screen.getByRole('alert')
      expect(row.textContent).toMatch(/A location or activity this run depends on is now double-booked/)
      expect(document.activeElement).toBe(row)
    })
  })

  // F4 (Red Hat round 3) — THE REAL BUG, found by tracing which refusals
  // share the SAME rendered shape. STALE_OUTER_SCHEDULE renders through a
  // DIFFERENT branch (a wrapping <div> + its own paired action) than every
  // other refusal (a bare <RunStateRow testId="run-state-finalize-refusal"
  // first last alert />) — so a transition INTO or OUT OF STALE_OUTER_SCHEDULE
  // changes the returned element's TYPE at that position, which React
  // reconciles as an unmount+remount regardless of the `[alert]` dependency
  // array (a mount always runs its effect). That accidentally masks the bug
  // for that one transition.
  //
  // THE GENUINELY BROKEN PATH: guardedRegenerate's cold-status check
  // (DraftRunView.jsx) calls `setFinalizeRefusal({ error:
  // 'FINALIZED_ELSEWHERE', ... })` DIRECTLY, with no reset — and
  // FINALIZED_ELSEWHERE renders through the SAME generic branch as e.g.
  // OUTER_RESOURCE_CONFLICT. A director who sees an OUTER_RESOURCE_CONFLICT
  // refusal and separately clicks the STALENESS OFFER's own "Re-derive and
  // regenerate" button (a different control, reachable independent of the
  // refusal row) can trigger guardedRegenerate's cold-check, which overwrites
  // the SAME RunStateRow instance in place — same key, same `alert={true}`,
  // never unmounted — so the mount effect never re-fires and neither
  // announcement nor focus move happens.
  it('OUTER_RESOURCE_CONFLICT -> FINALIZED_ELSEWHERE via the staleness offer\'s regenerate (same row instance, no reset) re-focuses too', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, staleCount: 1 })
    localClient.finalizeElectiveRun.mockResolvedValueOnce({ ok: false, error: 'OUTER_RESOURCE_CONFLICT', findings: [] })
    localClient.listElectiveRuns.mockResolvedValue([{ ...DRAFT_RUN, status: 'final' }])
    const onFinalized = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onFinalized={onFinalized} onRegenerate={vi.fn()} coldRegenerate {...catalogs()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Finalize run' }))
    const firstRow = await screen.findByRole('alert')
    expect(firstRow.textContent).toMatch(/A location or activity this run depends on is now double-booked/)
    await waitFor(() => expect(document.activeElement).toBe(firstRow))

    // Move focus AWAY and CONFIRM it moved — fireEvent.click does not
    // simulate a real browser's focus-follows-click, so without this
    // explicit step and assertion, a later "focus is back on the row" check
    // could pass vacuously because focus never actually left it.
    firstRow.blur()
    expect(document.activeElement).not.toBe(firstRow)

    // THE STALENESS OFFER's OWN regenerate button — a separate control from
    // the (button-less) OUTER_RESOURCE_CONFLICT refusal row — triggers the
    // SAME guardedRegenerate cold-check.
    const offer = await screen.findByTestId('run-staleness-offer')
    fireEvent.click(within(offer).getByRole('button', { name: /Re-derive and regenerate/i }))

    await waitFor(() => {
      const row = screen.getByRole('alert')
      expect(row.textContent).toMatch(/finalized on another device while you had it open/i)
      expect(document.activeElement).toBe(row)
    })
  })
})

// ---------------------------------------------------------------------------
// T250 A1 — FinalRunView's own entrance transition is transient: it applies
// ONLY on the in-session Finalize -> Final transition (justFinalized), never
// on a Final run opened cold from the run list (T250 round 2, FIX 4's
// standing rule: a screen that already has findings/state when it mounts
// renders at rest).
// ---------------------------------------------------------------------------
describe('T250 A1 — FinalRunView animates only the in-session finalize transition', () => {
  it('renders at rest (no justFinalized prop) exactly like a cold-opened Final run', async () => {
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    const identity = await screen.findByTestId('run-identity')
    void identity
    // No justFinalized => no opacity/transform override on the wrapper.
    expect(screen.getByTestId('final-run-view').style.transition).toBe('')
  })

  it('applies an entrance transition when justFinalized is true', async () => {
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} justFinalized {...catalogs()} />)
    await screen.findByTestId('run-identity')
    expect(screen.getByTestId('final-run-view').style.transition).not.toBe('')
  })
})

// ---------------------------------------------------------------------------
// archive_when: Draft — "satisfaction summary"
// ---------------------------------------------------------------------------
describe('T250 archive_when — Draft: satisfaction summary', () => {
  it('states how many campers are placed and how the preference ranks they received break down', async () => {
    // T318 (c3) — satisfactionSummary now joins each row to its preference to
    // read rank_kind, so a rank without a matching, positively-ordered
    // preference row would read as "one of their choices" rather than a
    // number. These two rows ARE genuinely ordered (cell-choice), which is
    // what the "1 got a first choice" / "1 a second choice" assertions below
    // require.
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      preferences: [
        { id: 'pref-a1', camper_id: 'camper-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice', coordinate: null },
        { id: 'pref-a2', camper_id: 'camper-2', choice_id: 'choice-2', occurrence_id: 'occ-1', rank: 2, rank_kind: 'cell-choice', coordinate: null },
      ],
    })
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

  // T318 (b) — a run opened cold from the run list has an EMPTY templateOccurrences
  // (AssignmentPanel React state set only by a fresh solve). The over-capacity row
  // must still name the day and period, from the run's own persisted occurrences
  // (state.occurrences, always present).
  it('labels an over-capacity row from the run’s persisted occurrences when template occurrences are empty (reopened run)', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      overCapacityOccurrences: [{ occurrenceId: 'occ-1', activityId: 'act-1', capacity: 1, filled: 2 }],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} templateOccurrences={[]} />)
    const row = await screen.findByTestId('run-state-over-capacity-occ-1-act-1')
    expect(row.textContent).toBe('Archery — Monday, First Period has 2 campers assigned against a capacity of 1.')
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
describe('T250/T320 archive_when — Draft: DANGLING_MANUAL_ASSIGNMENT surfaced live', () => {
  const dangling = [{
    kind: 'DANGLING_MANUAL_ASSIGNMENT', assignment_id: 'a3',
    camper_id: 'camper-3', occurrence_id: 'occ-gone', message: 'ignored — T250 owns this screens copy',
  }]

  // T320 (docs/adr/2026-09-30-elective-run-durability.md item 3; Governor
  // ruling R6) — "Release lock" is GONE from this row entirely. With live
  // occurrences available (catalogs()'s default templateOccurrences), the
  // row shows a "Move to…" picker that routes through
  // setElectiveAssignment's replacesAssignmentId, and the finding clears
  // (via a durable re-read) rather than merely retiring an action.
  it('names the affected camper, offers a move picker, and the row clears once the finding no longer holds', async () => {
    localClient.getElectiveRun
      .mockResolvedValueOnce({ ...CLEAN_RUN_STATE, danglingFindings: dangling })
      .mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: [] })
    localClient.setElectiveAssignment.mockResolvedValue({ ok: true, assignmentId: 'new-a3' })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    expect(row.textContent).toMatch(
      /Testcamper Charlie's locked placement no longer matches this run — regenerating removed the occurrence it pointed to\./
    )
    const select = within(row).getByTestId('run-state-dangling-move-a3')
    fireEvent.change(select, { target: { value: 'occ-1' } })
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalled())
    expect(localClient.setElectiveAssignment).toHaveBeenCalledWith({
      runId: 'run-1', camperId: 'camper-3', occurrenceId: 'occ-1', activityId: 'act-2',
      locked: true, replacesAssignmentId: 'a3',
    })
    // The row is gone once the write succeeds and the durable read agrees.
    await waitFor(() => expect(screen.queryByTestId('run-state-dangling-a3')).toBeNull())
  })

  it('orders over-capacity rows before dangling rows, per the spec fixed order', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      danglingFindings: dangling,
      overCapacityOccurrences: [{ occurrenceId: 'occ-1', activityId: 'act-1', capacity: 1, filled: 2 }],
    })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const area = await screen.findByTestId('run-state-area')
    const ids = [...area.querySelectorAll('[data-testid^="run-state-"][role]')].map((n) => n.dataset.testid)
    expect(ids).toEqual(['run-state-over-capacity-occ-1-act-1', 'run-state-dangling-a3'])
  })

  it('surfaces a failed move write instead of swallowing it, and the row stays', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: dangling })
    localClient.setElectiveAssignment.mockResolvedValue({ ok: false, error: 'RUN_NOT_DRAFT' })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    fireEvent.change(within(row).getByTestId('run-state-dangling-move-a3'), { target: { value: 'occ-1' } })
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/RUN_NOT_DRAFT/))
    // ...and the row stays, because nothing was resolved.
    expect(screen.getByTestId('run-state-dangling-a3')).toBeTruthy()
  })

  // T320 — S5, cold reopen: this run was NEVER committed this session
  // (no commit-response prop at all), and the row still renders, proving the
  // durable derivation — not the session-scoped prop — is what's showing it.
  it('T320 S5 — renders on a COLD REOPEN, with no commit-response prop in play', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: dangling })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    expect(row.textContent).toMatch(/Testcamper Charlie's locked placement no longer matches this run/)
  })
})

// ---------------------------------------------------------------------------
// T250 B1 — commitElectiveRun's `findings` return array mixes THREE kinds
// (DANGLING_MANUAL_ASSIGNMENT, PREFERENCE_EDIT_HELD, BUNDLE_TIER_NOT_COVERED)
// and every one of them carries a camper_id, so a caller that filters on
// nothing prints the dangling-placement sentence for all three.
// ---------------------------------------------------------------------------
describe('T250 B1 — a mixed findings array renders each kind with its own sentence', () => {
  const mixed = [
    {
      kind: 'DANGLING_MANUAL_ASSIGNMENT', assignment_id: 'a3',
      camper_id: 'camper-3', occurrence_id: 'occ-gone', message: 'ignored — T250 owns this sentence',
    },
    {
      kind: 'PREFERENCE_EDIT_HELD', preference_id: 'pref-1', camper_id: 'camper-1', reason: 'removed',
      message: 'This file still lists a preference you removed by hand, so it was not added back.',
    },
    {
      kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'camper-2', label: 'Sports Bundle',
      message: 'Testcamper Bravo ranked “Sports Bundle”, which a bundle claims for specific divisions only.',
    },
  ]

  it('renders the dangling sentence for DANGLING_MANUAL_ASSIGNMENT, each OTHER non-bundle finding under its own verbatim message, and the bundle finding GROUPED, one row per finding/group, no action button', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      danglingFindings: [mixed[0]],
    })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={mixed} {...catalogs()} />)

    const danglingRow = await screen.findByTestId('run-state-dangling-a3')
    expect(danglingRow.textContent).toMatch(/Testcamper Charlie's locked placement no longer matches this run/)
    // T320 — the dangling row's action is now the move picker, not a button.
    expect(within(danglingRow).getByTestId('run-state-dangling-move-a3')).toBeTruthy()

    const prefRow = screen.getByTestId('run-state-notice-pref-1')
    expect(prefRow.textContent).toBe('This file still lists a preference you removed by hand, so it was not added back.')
    expect(within(prefRow).queryByRole('button')).toBeNull()

    // C1 — BUNDLE_TIER_NOT_COVERED is now GROUPED by (label, tier), rendered
    // with this screen's own sentence (not the finding's raw .message), and
    // the camper's name is reachable behind the disclosure.
    const bundleRow = screen.getByTestId('run-state-bundle-mismatch-Sports Bundle-tier-1')
    expect(bundleRow.textContent).toMatch(/"Sports Bundle" does not cover Juniors — 1 camper kept their request as an ordinary choice\./)
    expect(within(bundleRow).queryByRole('button')).toBeNull()
    // The named camper is reachable (in the DOM, behind the disclosure) even
    // though the finding's own raw .message is no longer printed verbatim.
    expect(within(bundleRow).getAllByText('Testcamper Bravo').length).toBeGreaterThan(0)

    // Exactly one row per finding/group — no collision, no dropped row.
    const area = screen.getByTestId('run-state-area')
    expect(area.querySelectorAll('[data-testid^="run-state-"][role]')).toHaveLength(3)
  })

  // The grouping's whole point: many near-identical findings for the SAME
  // (label, tier) pair collapse to ONE row, and the count printed in the
  // sentence matches the number of names actually reachable in the DOM —
  // grouping may compress repetition but must never drop a name (Art. V).
  it('collapses many findings for the same (label, tier) into ONE row, and the sentence count equals the names rendered', async () => {
    const many = [
      { kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'camper-1', label: 'Ropes' },
      { kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'camper-2', label: 'Ropes' },
      { kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'camper-3', label: 'Ropes' },
    ]
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: [] })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={many} {...catalogs()} />)

    const area = await screen.findByTestId('run-state-area')
    const bundleRows = [...area.querySelectorAll('[data-testid^="run-state-bundle-mismatch-"]')]
    expect(bundleRows).toHaveLength(1)
    const row = bundleRows[0]
    expect(row.textContent).toMatch(/3 campers kept their request as an ordinary choice/)
    for (const name of ['Testcamper Alpha', 'Testcamper Bravo', 'Testcamper Charlie']) {
      expect(within(row).getByText(name)).toBeTruthy()
    }
  })

  // Owner/organizer ruling, 2026-09-30 — Finalize sits ABOVE the findings list
  // (contradicting the spec's original fixed layout order, amended with a
  // dated note). Pins the DOM order so a future edit cannot silently revert it.
  it('places the Finalize actions band ABOVE the run-state area', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: [mixed[0]] })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={mixed} {...catalogs()} />)
    const button = await screen.findByRole('button', { name: 'Finalize run' })
    const area = await screen.findByTestId('run-state-area')
    // DOCUMENT_POSITION_FOLLOWING means `area` comes AFTER `button` in the DOM.
    expect(button.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // Round 2 FIX 5(a) (Code Reviewer, LOW) — a commitNotices row rendered
  // `message={f.message}` with no fallback, so a finding kind without a
  // `.message` (any future OTHER kind BUNDLE_TIER_NOT_COVERED-shaped kind
  // commitElectiveRun ever adds) renders a BLANK row instead of something a
  // director can read. Same fallback shape FinalizeFindingsList already uses.
  // F6 (Code Reviewer round 3) — commitNotices now routes through the SAME
  // copy table (runStateCopy.js's finalizeFindingMessage) the Finalize
  // refusal surface uses (C2). A raw kind code reaching this ALWAYS-VISIBLE
  // run-state area is the same board-item-9b defect class as the refusal
  // row's own fix; this test used to PIN the raw-code fallback as correct
  // and now pins its replacement — a plain-language sentence, never the kind
  // or JSON. "Never a blank row" (the half this guard still protects) still
  // holds: the row has visible text either way.
  it('degrades to a plain-language sentence for a commit notice with no .message — never a raw kind code, never JSON, never a blank row', async () => {
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={[
      { kind: 'SOME_FUTURE_KIND', camper_id: 'camper-9' },
    ]} {...catalogs()} />)

    const row = await screen.findByTestId('run-state-notice-camper-9-SOME_FUTURE_KIND')
    expect(row.textContent).not.toBe('')
    expect(row.textContent).not.toContain('SOME_FUTURE_KIND')
    expect(row.textContent).not.toMatch(/^\{/)
  })
})

// ---------------------------------------------------------------------------
// (C)(4) — owner/organizer scope addition, "defaults are fine": a camper on
// this run's sheet with no ranked choice and no placement (sheetOnlyCampers,
// electron/ops/getElectiveRun.js — deliberately excluded from
// eligibilityFindings per T320 part 2 item 3, surfaced here instead) must be
// NAMED, same treatment as the grouped BUNDLE_TIER_NOT_COVERED row: one row,
// the count, names behind the same disclosure idiom. Names resolve through
// `state.campers`, which the run view already holds — no new IPC.
// ---------------------------------------------------------------------------
describe('(C)(4) sheetOnlyCampers — named, not just counted', () => {
  it('names every sheet-only camper behind a disclosure, with the sentence count equal to the names rendered', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      sheetOnlyCampers: ['camper-1', 'camper-2'],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)

    const row = await screen.findByTestId('run-state-sheet-only-campers')
    expect(row.textContent).toMatch(/2 campers on this run's sheet have no ranked choice and no placement/)
    for (const name of ['Testcamper Alpha', 'Testcamper Bravo']) {
      expect(within(row).getByText(name)).toBeTruthy()
    }
  })

  it('uses singular wording for exactly one sheet-only camper, and shows their name directly', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      sheetOnlyCampers: ['camper-3'],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)

    const row = await screen.findByTestId('run-state-sheet-only-campers')
    expect(row.textContent).toMatch(/1 camper on this run's sheet has no ranked choice and no placement/)
    expect(within(row).getAllByText('Testcamper Charlie').length).toBeGreaterThan(0)
  })

  it('renders no row at all when there are no sheet-only campers — no banner for the clean case', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, sheetOnlyCampers: [] })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    await screen.findByTestId('run-satisfaction-summary')
    expect(screen.queryByTestId('run-state-sheet-only-campers')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// T250 B3 — two same-named campers need something beside the name to tell
// them apart, in both the placement table and CamperWeekPanel's camper list.
// ---------------------------------------------------------------------------
describe('T250 B3 — same-name campers are disambiguated by group name, then external_id, then nothing', () => {
  const SAME_NAME_ROWS = [
    { id: 'a1', occurrence_id: 'occ-1', camper_id: 'camper-1', activity_id: 'act-1', preference_rank: 1, camper_name: 'Ari Green', source: 'solver', is_locked: 0 },
    { id: 'a4', occurrence_id: 'occ-2', camper_id: 'camper-4', activity_id: 'act-2', preference_rank: 1, camper_name: 'Ari Green', source: 'solver', is_locked: 0 },
  ]

  it('shows the group name beneath the camper name in the placement table when present', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      rows: SAME_NAME_ROWS,
      campers: [
        { id: 'camper-1', display_name: 'Ari Green', group_name: 'Cabin One', external_id: null },
        { id: 'camper-4', display_name: 'Ari Green', group_name: 'Cabin Two', external_id: null },
      ],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row1 = await screen.findByTestId('placement-row-a1')
    expect(row1.textContent).toMatch(/Ari Green/)
    expect(row1.textContent).toMatch(/Cabin One/)
    const row4 = screen.getByTestId('placement-row-a4')
    expect(row4.textContent).toMatch(/Cabin Two/)
  })

  it('falls back to external_id when there is no group, and never prints the raw camper_id or a "No group" placeholder', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      rows: SAME_NAME_ROWS,
      campers: [
        { id: 'camper-1', display_name: 'Ari Green', group_name: null, external_id: 'CM-101' },
        { id: 'camper-4', display_name: 'Ari Green', group_name: null, external_id: null },
      ],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row1 = await screen.findByTestId('placement-row-a1')
    expect(row1.textContent).toMatch(/CM-101/)
    const row4 = screen.getByTestId('placement-row-a4')
    expect(row4.textContent).not.toMatch(/camper-4/)
    expect(row4.textContent).not.toMatch(/No group/i)
  })

  it('appends the disambiguator to the camper name in CamperWeekPanel’s list, joined by ·', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      rows: SAME_NAME_ROWS,
      campers: [
        { id: 'camper-1', display_name: 'Ari Green', group_name: 'Cabin One', external_id: null },
        { id: 'camper-4', display_name: 'Ari Green', group_name: 'Cabin Two', external_id: null },
      ],
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const open1 = await screen.findByTestId('camper-week-open-camper-1')
    expect(open1.textContent).toMatch(/Ari Green · Cabin One/)
    const open4 = screen.getByTestId('camper-week-open-camper-4')
    expect(open4.textContent).toMatch(/Ari Green · Cabin Two/)
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
      // T320 — writeAssignment (the one shared write path) now always threads
      // replacesAssignmentId through; null for an ordinary move/lock through
      // the table, which never replaces a dangling row.
      replacesAssignmentId: null,
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
      replacesAssignmentId: null,
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

  // T316 round 3 — a refusal that carries a director-facing sentence (e.g.
  // INVALID_CAPACITY) is shown verbatim instead of the bare machine code.
  it('shows the handler\'s own message instead of the raw code when a move refusal carries one', async () => {
    localClient.setElectiveAssignment.mockResolvedValue({
      ok: false,
      error: 'INVALID_CAPACITY',
      message: '"Archery" is set to limited capacity but the number is blank — fill it in before moving campers into it.',
    })
    render(<DraftRunView run={DRAFT_RUN} {...catalogs()} />)
    const row = await screen.findByTestId('placement-row-a1')
    fireEvent.change(within(row).getByTestId('placement-occurrence-a1'), { target: { value: 'occ-2' } })
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/blank — fill it in before moving campers into it\./))
    expect(screen.getByTestId('run-view-error').textContent).not.toMatch(/INVALID_CAPACITY/)
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
// Round 2 FIX 4 (Red Hat, MEDIUM) — viewRun is a snapshot captured when this
// screen opened and is never re-synced, so a run another device finalized
// AFTER that still renders here as Draft with a first-class Regenerate.
// commitElectiveRun does not itself refuse a commit onto an already-final
// run (only skips re-asserting `status`/`name`/`source_filename` on an
// existing row) — so regenerating would silently write over an immutable
// run. Scoped to the COLD path (coldRegenerate=true): a run this session
// itself just solved is not the case this guards.
// ---------------------------------------------------------------------------
describe('T250 round 2 FIX 4 — a cold-opened run finalized elsewhere refuses to regenerate', () => {
  it('re-checks status before a cold regenerate, refuses in place, and never calls onRegenerate when the run now reads final', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, staleCount: 1 })
    localClient.listElectiveRuns.mockResolvedValue([{ ...DRAFT_RUN, status: 'final' }])
    const onRegenerate = vi.fn()
    const onFinalized = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onRegenerate={onRegenerate} onFinalized={onFinalized} coldRegenerate {...catalogs()} />)

    const offer = await screen.findByTestId('run-staleness-offer')
    fireEvent.click(within(offer).getByRole('button', { name: /Re-derive and regenerate/i }))

    await waitFor(() => expect(localClient.listElectiveRuns).toHaveBeenCalled())
    expect(onRegenerate).not.toHaveBeenCalled()
    await waitFor(() => expect(onFinalized).toHaveBeenCalledWith(expect.objectContaining({ id: DRAFT_RUN.id, status: 'final' })))
    const refusalRow = await screen.findByTestId('run-state-finalize-refusal')
    expect(refusalRow.textContent).toMatch(
      /finalized on another device while you had it open.*reload it to see the final version/i
    )
    // The refusal row itself withholds a Re-derive control — no way to retry
    // straight into the same hazard from this row (in the real app, onFinalized
    // transitions AssignmentPanel's viewRun and unmounts this screen entirely;
    // this standalone render can't observe that unmount).
    expect(within(refusalRow).queryByRole('button')).toBeNull()
  })

  it('does not re-check status for a WARM regenerate (this session solved the run itself), and calls onRegenerate synchronously as before', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, staleCount: 1 })
    const onRegenerate = vi.fn()
    render(<DraftRunView run={DRAFT_RUN} onRegenerate={onRegenerate} coldRegenerate={false} {...catalogs()} />)

    const offer = await screen.findByTestId('run-staleness-offer')
    fireEvent.click(within(offer).getByRole('button', { name: /Re-derive and regenerate/i }))

    expect(onRegenerate).toHaveBeenCalled()
    expect(localClient.listElectiveRuns).not.toHaveBeenCalled()
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
    // C3 — the finalizing user's DISPLAY NAME, never the raw user id.
    expect(identity.textContent).toMatch(/Testdirector Dana/)
    expect(identity.textContent).not.toMatch(/user-director/)
    expect(identity.textContent).toMatch(/Final/)
    // Immutable: no move/lock table on a Final run.
    expect(screen.queryByTestId('placement-row-a1')).toBeNull()
  })

  // C3 (board item 9b) — finalized_by_name is absent (the users row is gone,
  // or this is a legacy pre-C3 read) but finalized_by is still set: a
  // director fact still happened, so the clause stays, truthfully degraded
  // to "a director" rather than a raw id or a dropped clause.
  it('falls back to "a director" when finalized_by is set but finalized_by_name did not resolve', async () => {
    render(<FinalRunView run={{ ...FINAL_RUN, finalized_by_name: undefined }} campers={CAMPERS} {...catalogs()} />)
    const identity = await screen.findByTestId('run-identity')
    expect(identity.textContent).toMatch(/by a director/)
    expect(identity.textContent).not.toMatch(/user-director/)
  })

  // Round 2 FIX 5(d) (Code Reviewer, LOW) — DraftRunView's own success
  // transition (`onFinalized?.({ ...run, status: 'final', finalized_at:
  // out.finalizedAt })`) sends no finalized_by, because
  // finalizeElectiveRun's success shape does not return it — so a run just
  // finalized in THIS session shows "finalized <date>" with no "by <user>"
  // until it is reopened. VERIFIED: RunIdentity already renders this
  // coherently — finalized_by is its own independent Boolean-filtered
  // segment, so its absence drops cleanly with no "by undefined" and no
  // stray separator. No code change needed here; this pins that fact.
  it('renders "finalized <date>" with no dangling "by" fragment when finalized_by is absent', async () => {
    render(<FinalRunView run={{ ...FINAL_RUN, finalized_by: undefined }} campers={CAMPERS} {...catalogs()} />)
    const identity = await screen.findByTestId('run-identity')
    expect(identity.textContent).toMatch(/finalized 2026-09-24/)
    expect(identity.textContent).not.toMatch(/by /)
    expect(identity.textContent).not.toMatch(/undefined/)
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

  it('renders exactly one Start a new version control even when the stale state is showing', async () => {
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

  // T318 (b) — same fix on the Final screen: a run reopened from the run list
  // has an empty templateOccurrences prop and must still label from state.occurrences.
  it('labels an over-capacity row from the run’s persisted occurrences when template occurrences are empty (reopened run)', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      overCapacityOccurrences: [{ occurrenceId: 'occ-2', activityId: 'act-2', capacity: 2, filled: 5 }],
    })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} templateOccurrences={[]} />)
    const row = await screen.findByTestId('run-state-over-capacity-occ-2-act-2')
    expect(row.textContent).toBe('Pottery — Monday, First Period has 5 campers assigned against a capacity of 2.')
  })

  it('puts the stale-generation pairing above the over-capacity rows when both are present', async () => {
    localClient.getElectiveRun.mockResolvedValue({
      ...CLEAN_RUN_STATE,
      finalizedAgainstStaleGeneration: true,
      overCapacityOccurrences: [{ occurrenceId: 'occ-2', activityId: 'act-2', capacity: 2, filled: 5 }],
    })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    const area = await screen.findByTestId('run-state-area')
    const ids = [...area.querySelectorAll('[data-testid^="run-state-"][role]')]
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
    // v76 (T197): buildChildScheduleExport's own contract bumped format_version 1 -> 2 for the
    // cell_kind/linked-choice shape change — this test went stale when that shipped (round 2 fix).
    expect(payload.format_version).toBe(2)
    expect(payload.run_id).toBe('run-2')
    expect(payload.run_status).toBe('final')
    const alpha = payload.campers.find((c) => c.camper_id === 'camper-1')
    expect(alpha.schedule).toEqual([
      { kind: 'span', day: 'Monday', time_block: 'First Period', activity_name: 'Archery', location_name: null, span_blocks: 1 },
    ])
    document.createElement.mockRestore()
  })

  it('surfaces an export failure instead of silently producing nothing', async () => {
    localClient.getElectiveRunOuterSchedule.mockRejectedValue(new Error('outer schedule unavailable'))
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Export$/ }))
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/That export could not be produced\./))
  })

  // T320 round 2, F3 (Code Reviewer) — round 1 wired the snapshot-incomplete
  // refusal into "Export Full Report" only; the plain "Export" button called
  // buildChildScheduleExport directly with no completeness check at all, so a
  // director's most obvious control could silently print a schedule with
  // holes. The guard now lives in buildChildScheduleExport itself.
  it('the plain Export button refuses a partially-synced finalized run instead of producing a document', async () => {
    localClient.getElectiveRun.mockResolvedValue({ ...CLEAN_RUN_STATE, snapshotIncomplete: true, expectedSnapshotRows: 10, heldSnapshotRows: 4 })
    localClient.getElectiveRunOuterSchedule.mockResolvedValue({
      rows: [{ camperId: 'camper-1', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', locationId: null, locationName: null, spanBlocks: 1 }],
      runStatus: 'final',
    })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Export$/ }))
    await waitFor(() => expect(screen.getByTestId('run-view-error').textContent).toMatch(/4 of.*10 rows/))
    // No download was produced — the failure path never called createObjectURL.
    expect(created).toHaveLength(0)
  })

  // F6 (round 2): buildElectiveRunProjectionExport (JSON) and buildElectiveRunWorkbook (XLSX) were
  // built and unit-tested but never wired to a caller — the "Export" button above only produces
  // the child-schedule JSON. This is the FIRST reachable caller.
  it('"Export Full Report" produces the combined JSON projection AND the XLSX workbook', async () => {
    localClient.getElectiveRunOuterSchedule.mockResolvedValue({
      rows: [{ camperId: 'camper-1', dayId: 'day-1', timeBlockId: 'tb-1', cellKind: 'elective', activityId: 'act-1', activityName: 'Archery', locationId: null, locationName: null, spanBlocks: 1, isLinkedChoice: false }],
      runStatus: 'final',
    })
    localClient.list.mockResolvedValue([
      { run_id: 'run-2', camper_id: 'camper-1', choice_id: 'ch-1', rank: 1 },
      { run_id: 'run-other', camper_id: 'camper-9', choice_id: 'ch-9', rank: 1 },
    ])
    const XLSX = await import('xlsx')
    const click = vi.fn()
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'a') el.click = click
      return el
    })

    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Export Full Report$/ }))

    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(localClient.list).toHaveBeenCalledWith('elective_preferences')
    const payload = JSON.parse(await created[created.length - 1].text())
    // T320 bumped format_version 2 -> 3 (exceptions.eligibility/.resource
    // meaning change — see exportElectiveRunProjection.js's own comment).
    expect(payload.format_version).toBe(3)
    // Only this run's preferences (run_id: 'run-2') feed the export — the 'run-other' row is
    // filtered out client-side since localClient.list returns all camp-scoped rows.
    expect(payload.exceptions.unranked.some((u) => u.camper_id === 'camper-9')).toBe(false)
    await waitFor(() => expect(XLSX.writeFile).toHaveBeenCalled())
    document.createElement.mockRestore()
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
// Q5 was ruled by the owner 2026-09-29: "Start a new version". The label ships
// from a single named constant so any future change stays a one-line edit.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// T250 A4 — a quiet Delete run trigger with a loud confirmation, on both
// Draft and Final. The cost callout copy is verbatim (D10 honest-cost copy).
// ---------------------------------------------------------------------------
describe('T250 A4 — Delete run', () => {
  it('DraftRunView: opens a confirmation with the verbatim cost copy, and deletes on confirm', async () => {
    localClient.deleteElectiveRun.mockResolvedValue({ ok: true, ops_written: 5 })
    render(<DraftRunView run={DRAFT_RUN} onBack={() => {}} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete run' }))

    const dialog = await screen.findByTestId('delete-run-dialog')
    expect(dialog.textContent).toMatch(/Delete "Elective assignment — 2026-09-25"\?/)
    expect(dialog.textContent).toContain(DELETE_RUN_COST_COPY)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete run' }))
    await waitFor(() => expect(localClient.deleteElectiveRun).toHaveBeenCalledWith({ runId: 'run-1' }))
  })

  it('Cancel closes the dialog without deleting', async () => {
    render(<DraftRunView run={DRAFT_RUN} onBack={() => {}} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete run' }))
    const dialog = await screen.findByTestId('delete-run-dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('delete-run-dialog')).toBeNull()
    expect(localClient.deleteElectiveRun).not.toHaveBeenCalled()
  })

  it('surfaces a delete failure instead of swallowing it', async () => {
    localClient.deleteElectiveRun.mockRejectedValue(new Error('delete unavailable'))
    render(<DraftRunView run={DRAFT_RUN} onBack={() => {}} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete run' }))
    const dialog = await screen.findByTestId('delete-run-dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete run' }))
    await waitFor(() => expect(within(dialog).getByText(/delete unavailable|could not be deleted/i)).toBeTruthy())
  })

  it('FinalRunView: also offers Delete run (a final run is deletable)', async () => {
    localClient.deleteElectiveRun.mockResolvedValue({ ok: true, ops_written: 5 })
    render(<FinalRunView run={FINAL_RUN} campers={CAMPERS} onBack={() => {}} {...catalogs()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete run' }))
    const dialog = await screen.findByTestId('delete-run-dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete run' }))
    await waitFor(() => expect(localClient.deleteElectiveRun).toHaveBeenCalledWith({ runId: 'run-2' }))
  })

  // Round 2 FIX 2 (Red Hat, HIGH) — ensureRunStub (electron/ops/
  // projections.js) does `INSERT OR IGNORE ... VALUES (?, ?, '')` with no
  // awareness of a delete, so a peer's concurrent write onto this run's id
  // (or a child row) after the delete resurrects the parent row, blank-named.
  // The old cost copy read as an unqualified "removes it ... from every
  // device this camp syncs with", which overclaims under that race. This is
  // the SAME pre-existing class ensureExists's stub-seed pattern has always
  // had (elective_set_activities/elective_bundles stub-seed elective_sets
  // identically, and deleteElectiveSet has shipped since schema v35/T41) — a
  // real fix belongs at the shared projection choke point and needs an ADR,
  // so this pins only that the copy stays honest about it.
  it('the cost copy discloses that a concurrent peer edit can make the run briefly reappear, unnamed', () => {
    expect(DELETE_RUN_COST_COPY).toMatch(/reappear/i)
  })
})

describe('T250 — Q5 terminology is a single swappable constant', () => {
  it('ships the ruled Start a new version wording from one named constant', () => {
    expect(START_REVISION_LABEL).toBe('Start a new version')
    // Comments stripped first: either phrase is allowed to be DISCUSSED in
    // this file, but never written as a hardcoded label duplicating the
    // constant.
    const src = fs
      .readFileSync(path.join(process.cwd(), 'src/screens/elective/run/FinalRunView.jsx'), 'utf8')
      .replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/Start a (revision|new version)/)
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
// T320 (docs/adr/2026-09-30-elective-run-durability.md item 3) REPLACES this
// block's old premise. _Prior: "Round 2, FIX 2 — Release lock must not claim
// a fix it did not make" pinned that releasing the lock left `source`
// untouched, so the row could never actually clear. Governor ruling R6/R7
// removed "Release lock" from this row entirely and replaced it with a
// picker that routes through `replacesAssignmentId`, which DOES resolve the
// condition — this block now asserts the opposite of what it used to: the
// remedy genuinely works._
//
// Two sub-cases, per R6/R7: a move (live occurrences exist) and a remove
// (none do).
// ---------------------------------------------------------------------------
describe('T320 — the picker genuinely resolves the dangling row (unlike the old Release lock)', () => {
  const dangling = [{
    kind: 'DANGLING_MANUAL_ASSIGNMENT', assignment_id: 'a3',
    camper_id: 'camper-3', occurrence_id: 'occ-gone', message: 'ignored — T250 owns this screens copy',
  }]

  it('a move tombstones the source row via replacesAssignmentId, and the row is gone once the durable read agrees', async () => {
    localClient.getElectiveRun
      .mockResolvedValueOnce({ ...CLEAN_RUN_STATE, danglingFindings: dangling })
      .mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: [] })
    localClient.setElectiveAssignment.mockResolvedValue({ ok: true, assignmentId: 'new-a3' })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    fireEvent.change(within(row).getByTestId('run-state-dangling-move-a3'), { target: { value: 'occ-1' } })
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ replacesAssignmentId: 'a3' })
    ))
    await waitFor(() => expect(screen.queryByTestId('run-state-dangling-a3')).toBeNull())
  })

  // R7 — the zero-live-occurrence fallback is "Remove placement", NOT the old
  // "Release lock": a genuinely resolvable action, per the standing "no
  // control whose action cannot do what it says" rule.
  it('with zero live occurrences, "Remove placement" removes the row via a remove-only write', async () => {
    localClient.getElectiveRun
      .mockResolvedValueOnce({ ...CLEAN_RUN_STATE, danglingFindings: dangling })
      .mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: [] })
    localClient.setElectiveAssignment.mockResolvedValue({ ok: true, assignmentId: null, removed: 'a3' })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} templateOccurrences={[]} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    fireEvent.click(within(row).getByTestId('run-state-dangling-remove-a3'))
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalledWith({
      runId: 'run-1', camperId: 'camper-3', occurrenceId: null, activityId: null,
      locked: undefined, replacesAssignmentId: 'a3',
    }))
    await waitFor(() => expect(screen.queryByTestId('run-state-dangling-a3')).toBeNull())
  })

  // T320 round 2, F5 (Tester) — the spec (docs/work/specs/2026-09-30-t320-
  // dangling-replace-picker.md, "Reduced motion") requires the row's removal
  // to use T250's existing collapse block verbatim (src/styles/shared.js's
  // mergeCard transition: max-height/opacity, var(--motion-settle)
  // var(--ease-out)), not an instant DOM removal — round 1 removed the row
  // the instant the write resolved, which on a slow write reads as lost
  // work rather than a completed action.
  it('collapses the row with the shared transition before removing it, on a successful move', async () => {
    localClient.getElectiveRun
      .mockResolvedValueOnce({ ...CLEAN_RUN_STATE, danglingFindings: dangling })
      .mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: [] })
    localClient.setElectiveAssignment.mockResolvedValue({ ok: true, assignmentId: 'new-a3' })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    fireEvent.change(within(row).getByTestId('run-state-dangling-move-a3'), { target: { value: 'occ-1' } })
    await waitFor(() => expect(localClient.setElectiveAssignment).toHaveBeenCalled())

    const wrapper = await screen.findByTestId('run-state-dangling-collapse-a3')
    await waitFor(() => {
      expect(wrapper.style.maxHeight).toBe('0px')
      expect(wrapper.style.opacity).toBe('0')
    })
    expect(wrapper.style.transition).toContain('var(--motion-settle)')
    expect(wrapper.style.transition).toContain('var(--ease-out)')

    // Only after the collapse has visually completed does the row actually
    // leave the document.
    await waitFor(() => expect(screen.queryByTestId('run-state-dangling-a3')).toBeNull())
  })

  it('under prefers-reduced-motion, the row is removed at its end state immediately, with no collapse animation', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    localClient.getElectiveRun
      .mockResolvedValueOnce({ ...CLEAN_RUN_STATE, danglingFindings: dangling })
      .mockResolvedValue({ ...CLEAN_RUN_STATE, danglingFindings: [] })
    localClient.setElectiveAssignment.mockResolvedValue({ ok: true, assignmentId: 'new-a3' })
    render(<DraftRunView run={DRAFT_RUN} danglingFindings={dangling} {...catalogs()} />)
    const row = await screen.findByTestId('run-state-dangling-a3')
    fireEvent.change(within(row).getByTestId('run-state-dangling-move-a3'), { target: { value: 'occ-1' } })

    await waitFor(() => expect(screen.queryByTestId('run-state-dangling-a3')).toBeNull())
    vi.unstubAllGlobals()
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
    for (const node of [area, ...area.querySelectorAll('[data-testid^="run-state-"][role]')]) {
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
