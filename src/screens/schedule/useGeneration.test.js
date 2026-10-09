// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// buildSchedule is mocked so the hook's orchestration is tested in isolation
// from the (separately unit-tested) engine.
vi.mock('../../engine/buildSchedule', () => ({
  default: vi.fn(() => ({ slots: [{ id: 'ns-1' }], findings: [{ kind: 'UNDERSERVED' }] })),
  computeFindings: vi.fn(() => [{ kind: 'DISTRIBUTION' }]),
}))

import buildSchedule, { computeFindings } from '../../engine/buildSchedule'
import { useGeneration, ALL_DAYS_REPLACED } from './useGeneration'

function makeRepo(overrides = {}) {
  return {
    replaceWeek: vi.fn(async () => ({ status: 'applied' })),
    reloadSlots: vi.fn(async () => [{ id: 'fresh-1', is_fixed_event: false, activity_id: 'a1' }]),
    ...overrides,
  }
}

// The route-scoped state now arrives as one `routeState` object (T31's
// useRouteState return). The hook reads slotsByRoute + the five by-route setters
// from it; the setters are exposed on `props` too so the existing assertions
// keep pointing at the same spies.
function makeRouteState(overrides = {}) {
  return {
    slotsByRoute: { generated: [], manual: [] },
    setSlotsByRoute: vi.fn(),
    setFindingsByRoute: vi.fn(),
    setDismissedByRoute: vi.fn(),
    setOverlaysByRoute: vi.fn(),
    setStatsByRoute: vi.fn(),
    ...overrides,
  }
}

function setup(overrides = {}) {
  const { slotsByRoute, ...rest } = overrides
  const routeState = makeRouteState(slotsByRoute ? { slotsByRoute } : {})
  const p = {
    routeState,
    repo: makeRepo(),
    campId: 'camp-1',
    setActionError: vi.fn(),
    setGenerating: vi.fn(),
    resetUndoRedo: vi.fn(),
    saveSnapshot: vi.fn(async () => {}),
    ensureTemplateRow: vi.fn(async (r) => `tid-${r}`),
    setConfirmRegen: vi.fn(),
    setSelectedGroup: vi.fn(),
    statsFor: (list) => ({ open: list.length, filled: list.length }),
    groups: [{ id: 'g1', tier_id: 't1' }],
    tiers: [{ id: 't1' }],
    days: [{ id: 'd1' }],
    timeBlocks: [{ id: 'b1', sort_order: 1 }],
    activities: [{ id: 'a1', name: 'Swim' }],
    fixedEvents: [],
    replacedDayIds: [],
    ...rest,
  }
  const hook = renderHook((props) => useGeneration(props), { initialProps: p })
  // Surface the by-route setters at the top level so assertions read
  // props.setFindingsByRoute etc. unchanged.
  return { ...hook, props: { ...p, ...routeState } }
}

beforeEach(() => {
  buildSchedule.mockClear()
  computeFindings.mockClear()
})

describe('useGeneration', () => {
  it('generate() resets undo/redo, ensures the generated row, replaces the week, and reloads', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.generate() })

    expect(props.resetUndoRedo).toHaveBeenCalledTimes(1)
    expect(props.ensureTemplateRow).toHaveBeenCalledWith('generated')
    expect(props.repo.replaceWeek).toHaveBeenCalledWith('tid-generated', [{ id: 'ns-1' }])
    expect(props.repo.reloadSlots).toHaveBeenCalledWith('tid-generated')
    expect(props.setGenerating).toHaveBeenLastCalledWith(false)
  })

  it('generate() writes route-EXPLICIT generated setters, not current-route ones', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.generate() })
    // The findings setter is called with the functional updater against the
    // 'generated' key; assert it mutates only that route.
    const updater = props.setFindingsByRoute.mock.calls[0][0]
    const next = updater({ generated: [], manual: ['UNTOUCHED'] })
    expect(next.manual).toEqual(['UNTOUCHED'])
    expect(next.generated).toEqual([{ kind: 'UNDERSERVED' }])
  })

  it('generate() takes a pre-emptive auto-snapshot when the generated route already has slots', async () => {
    const { result, props } = setup({ slotsByRoute: { generated: [{ id: 'x' }], manual: [] } })
    await act(async () => { await result.current.generate() })
    expect(props.saveSnapshot).toHaveBeenCalledWith(null, true, 'generated')
  })

  it('generate() ABORTS the destructive replaceWeek when the auto-snapshot fails', async () => {
    const saveSnapshot = vi.fn(async () => { throw new Error('snap failed') })
    const { result, props } = setup({
      slotsByRoute: { generated: [{ id: 'x' }], manual: [] },
      saveSnapshot,
    })
    await act(async () => { await result.current.generate() })

    expect(saveSnapshot).toHaveBeenCalled()
    expect(props.repo.replaceWeek).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith("Couldn't save undo point. Cancelled.")
    expect(props.setGenerating).toHaveBeenLastCalledWith(false)
  })

  it('generate() aborts (no replace) and reports when ensureTemplateRow throws', async () => {
    const ensureTemplateRow = vi.fn(async () => { throw new Error('kind conflict') })
    const { result, props } = setup({ ensureTemplateRow })
    await act(async () => { await result.current.generate() })
    expect(props.repo.replaceWeek).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(
      "Couldn't open it. Nothing changed."
    )
  })

  it('generate() maps an admin-role replaceWeek failure to the admin-only message', async () => {
    const repo = makeRepo({ replaceWeek: vi.fn(async () => { throw new Error('admin role required') }) })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.generate() })
    expect(props.setActionError).toHaveBeenCalledWith('Admin only.')
    expect(props.setGenerating).toHaveBeenLastCalledWith(false)
  })

  it('placeFixedEvents() builds fixedEvents-only for the manual route and defaults the selected group', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.placeFixedEvents() })
    expect(buildSchedule).toHaveBeenCalledWith(expect.objectContaining({ fixedEventsOnly: true }))
    expect(props.ensureTemplateRow).toHaveBeenCalledWith('manual')
    expect(props.repo.replaceWeek).toHaveBeenCalledWith('tid-manual', [{ id: 'ns-1' }])
    expect(props.setSelectedGroup).toHaveBeenCalledTimes(1)
  })

  it('placeFixedEvents() runs the week-exclusion pre-pass: an anchor for a closed activity is suppressed', async () => {
    // resolveWeekCatalog is NOT mocked here (only buildSchedule is), so this
    // pins the real seam: placeFixedEvents filters the catalog for the week before
    // laying down fixedEvents, exactly as generate() does. Without the pre-pass a
    // closed activity's anchor would still be placed — and computeWeekClosures
    // skips fixedEvents, so nothing downstream would catch it.
    const { result } = setup({
      weekId: 'wk1',
      activities: [{ id: 'a1', name: 'Swim' }, { id: 'a2', name: 'Closed Fixed Event' }],
      fixedEvents: [{ id: 'an1', activity_id: 'a2', is_all_groups: true, group_ids: [] }],
      activityExclusions: [{ week_id: 'wk1', activity_id: 'a2' }],
      groupExclusions: [],
    })
    await act(async () => { await result.current.placeFixedEvents() })

    const arg = buildSchedule.mock.calls[0][0]
    expect(arg.fixedEventsOnly).toBe(true)
    expect(arg.fixedEvents).toEqual([]) // the excluded activity's anchor is gone
    expect(arg.activities.map(a => a.id)).not.toContain('a2')
    expect(arg.activities.map(a => a.id)).toContain('a1')
  })

  it('placeFixedEvents() runs the week-exclusion pre-pass for LOCATION closures too (guards the second resolveWeekCatalog call site)', async () => {
    // Mirrors the activity-exclusion test above, but closes the PLACE the anchor's
    // activity sits on. This pins the locationExclusions argument on placeFixedEvents()'s
    // OWN resolveWeekCatalog call — the exact line an auto-merge once silently dropped.
    // Without it, a2's location closure would not reach the fixedEvents-only rebuild and
    // the anchor would still be placed (and computeWeekClosures skips fixedEvents, so
    // nothing downstream would catch it).
    const { result } = setup({
      weekId: 'wk1',
      activities: [{ id: 'a1', name: 'Swim' }, { id: 'a2', name: 'Pool Fixed Event', location_id: 'loc-pool' }],
      fixedEvents: [{ id: 'an1', activity_id: 'a2', is_all_groups: true, group_ids: [] }],
      locations: [{ id: 'loc-pool', name: 'Pool' }],
      activityExclusions: [],
      groupExclusions: [],
      locationExclusions: [{ week_id: 'wk1', location_id: 'loc-pool' }],
    })
    await act(async () => { await result.current.placeFixedEvents() })

    const arg = buildSchedule.mock.calls[0][0]
    expect(arg.fixedEvents).toEqual([]) // the anchor whose activity's PLACE is closed is gone
    expect(arg.activities.map(a => a.id)).not.toContain('a2')
    expect(arg.activities.map(a => a.id)).toContain('a1')
  })

  it('placeFixedEvents() leaves the catalog intact when the week has no exclusions', async () => {
    const { result } = setup({
      weekId: 'wk1',
      activities: [{ id: 'a1', name: 'Swim' }],
      fixedEvents: [{ id: 'an1', activity_id: 'a1', is_all_groups: true, group_ids: [] }],
      activityExclusions: [],
      groupExclusions: [],
    })
    await act(async () => { await result.current.placeFixedEvents() })

    const arg = buildSchedule.mock.calls[0][0]
    expect(arg.fixedEvents).toEqual([{ id: 'an1', activity_id: 'a1', is_all_groups: true, group_ids: [] }])
    expect(arg.activities.map(a => a.id)).toContain('a1')
  })

  it('placeFixedEvents() aborts the replace when the manual auto-snapshot fails', async () => {
    const saveSnapshot = vi.fn(async () => { throw new Error('snap failed') })
    const { result, props } = setup({
      slotsByRoute: { generated: [], manual: [{ id: 'y' }] },
      saveSnapshot,
    })
    await act(async () => { await result.current.placeFixedEvents() })
    expect(props.repo.replaceWeek).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith("Couldn't save undo point. Cancelled.")
  })

  // T267 PR2 (ADR step 5) — refuse-to-generate gate.
  describe('FIXED_EVENT_IDENTITY_GAP refuse gate', () => {
    it('generate() does NOT write the schedule when buildSchedule reports an error-severity finding', async () => {
      buildSchedule.mockReturnValueOnce({
        slots: [{ id: 'ns-1' }],
        findings: [{ kind: 'FIXED_EVENT_IDENTITY_GAP', severity: 'error', reason: 'dangling' }],
      })
      const { result, props } = setup()
      await act(async () => { await result.current.generate() })

      expect(props.repo.replaceWeek).not.toHaveBeenCalled()
      expect(props.setActionError).toHaveBeenCalledWith(expect.stringContaining('has no activity'))
      expect(props.setGenerating).toHaveBeenLastCalledWith(false)
    })

    it('generate() DOES write the schedule when findings contain no error severity (non-vacuity)', async () => {
      buildSchedule.mockReturnValueOnce({
        slots: [{ id: 'ns-1' }],
        findings: [{ kind: 'UNDERSERVED', severity: 'caution' }],
      })
      const { result, props } = setup()
      await act(async () => { await result.current.generate() })

      expect(props.repo.replaceWeek).toHaveBeenCalledWith('tid-generated', [{ id: 'ns-1' }])
    })

    it('placeFixedEvents() does NOT write the schedule when buildSchedule reports an error-severity finding', async () => {
      buildSchedule.mockReturnValueOnce({
        slots: [{ id: 'ns-1' }],
        findings: [{ kind: 'FIXED_EVENT_IDENTITY_GAP', severity: 'error', reason: 'dangling' }],
      })
      const { result, props } = setup()
      await act(async () => { await result.current.placeFixedEvents() })

      expect(props.repo.replaceWeek).not.toHaveBeenCalled()
      expect(props.setActionError).toHaveBeenCalledWith(expect.stringContaining('has no activity'))
      expect(props.setGenerating).toHaveBeenLastCalledWith(false)
    })

    // Packaged audit #14/#16 — the refusal names the offending events.
    it('generate() refusal names the unlinked events', async () => {
      buildSchedule.mockReturnValueOnce({
        slots: [],
        findings: [
          { kind: 'FIXED_EVENT_IDENTITY_GAP', severity: 'error', fixedEventId: 'fe-m1', reason: 'x' },
          { kind: 'FIXED_EVENT_IDENTITY_GAP', severity: 'error', fixedEventId: 'fe-m2', reason: 'x' },
          { kind: 'FIXED_EVENT_IDENTITY_GAP', severity: 'error', fixedEventId: 'fe-c', reason: 'x' },
        ],
      })
      const { result, props } = setup({
        fixedEvents: [
          { id: 'fe-m1', name: 'Mifkad', activity_id: null },
          { id: 'fe-m2', name: 'Mifkad', activity_id: null },
          { id: 'fe-c', name: 'Carpool', activity_id: null },
        ],
      })
      await act(async () => { await result.current.generate() })
      expect(props.setActionError).toHaveBeenCalledWith(expect.stringContaining('Mifkad, Carpool'))
    })

    // Packaged audit #16 — Manual's blank week is not blocked by an unlinked
    // event: it places every linked event and names the ones it left out.
    it('placeFixedEvents() places the linked events and names the unlinked ones instead of refusing', async () => {
      const { result, props } = setup({
        fixedEvents: [
          { id: 'fe-ok', name: 'Swim', activity_id: 'a1' },
          { id: 'fe-bad', name: 'Mifkad', activity_id: null },
        ],
      })
      await act(async () => { await result.current.placeFixedEvents() })
      expect(buildSchedule.mock.calls.at(-1)[0].fixedEvents.map((f) => f.id)).toEqual(['fe-ok'])
      expect(props.repo.replaceWeek).toHaveBeenCalled()
      expect(props.setActionError).toHaveBeenLastCalledWith(expect.stringContaining('Mifkad'))
    })

    it('placeFixedEvents() DOES write the schedule when findings contain no error severity (non-vacuity)', async () => {
      buildSchedule.mockReturnValueOnce({
        slots: [{ id: 'ns-1' }],
        findings: [],
      })
      const { result, props } = setup()
      await act(async () => { await result.current.placeFixedEvents() })

      expect(props.repo.replaceWeek).toHaveBeenCalledWith('tid-manual', [{ id: 'ns-1' }])
    })
  })

  // Red Hat HIGH (round 2): the FIXED_EVENT_DUPLICATE gate is hand-duplicated at
  // three call sites of computeFindings, this hook's placeFixedEvents() being one.
  // The site has no ternary — it is hardcoded to never pass fixedEvents, since
  // placeFixedEvents is the MANUAL-route bootstrap and FIXED_EVENT_DUPLICATE is
  // generated-only (see the comment at useGeneration.js:242-245 and
  // useScheduleData.js:338-343: computeFindings' safe default, absent fixedEvents
  // -> no finding, is what keeps manual clean). A future edit that starts
  // passing fixedEvents here would regress that silently — nothing else exercises
  // this call's arguments.
  it('placeFixedEvents() calls computeFindings with no fixedEvents key at all (manual route never surfaces FIXED_EVENT_DUPLICATE)', async () => {
    const { result } = setup()
    await act(async () => { await result.current.placeFixedEvents() })

    expect(computeFindings).toHaveBeenCalledTimes(1)
    const arg = computeFindings.mock.calls[0][0]
    expect(arg).not.toHaveProperty('fixedEvents')
  })

  it('regenFromScratch() closes the confirm modal then regenerates', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.regenFromScratch() })
    expect(props.setConfirmRegen).toHaveBeenCalledWith(false)
    expect(props.repo.replaceWeek).toHaveBeenCalledWith('tid-generated', [{ id: 'ns-1' }])
  })
})

// T350 slice 3 (docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D4, D11).
describe('useGeneration with days replaced by a special day', () => {
  const twoDays = [{ id: 'd1' }, { id: 'd2' }]
  const stored = (over) => ({ group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', fixed_event_id: null, is_fixed_event: false, is_span_head: true, flags: {}, ...over })

  it('every engine call and stats call carries replacedDayIds', async () => {
    const statsFor = vi.fn(() => ({ open: 0, filled: 0 }))
    const { result } = setup({ days: twoDays, replacedDayIds: ['d2'], statsFor })
    await act(async () => { await result.current.generate() })
    await act(async () => { await result.current.placeFixedEvents() })
    expect(buildSchedule).toHaveBeenCalledTimes(2)
    for (const [arg] of buildSchedule.mock.calls) expect(arg.replacedDayIds).toEqual(['d2'])
    for (const [arg] of computeFindings.mock.calls) expect(arg.replacedDayIds).toEqual(['d2'])
    expect(statsFor).toHaveBeenCalledTimes(2)
    for (const call of statsFor.mock.calls) expect(call[1]).toEqual(['d2'])
  })

  it('every day replaced: Generate shows the notice, writes nothing, does not throw', async () => {
    const { result, props } = setup({ days: twoDays, replacedDayIds: ['d1', 'd2'] })
    await act(async () => { await result.current.generate() })
    expect(props.setActionError).toHaveBeenCalledWith(ALL_DAYS_REPLACED)
    expect(buildSchedule).not.toHaveBeenCalled()
    expect(props.repo.replaceWeek).not.toHaveBeenCalled()
    expect(props.saveSnapshot).not.toHaveBeenCalled()
  })

  it("generate() carries the replaced day's stored rows forward, through the dead-reference guard", async () => {
    const live = stored()
    const deadActivity = stored({ activity_id: 'gone' })
    const deadBlock = stored({ time_block_id: 'gone-block' })
    const normalDay = stored({ day_id: 'd1' })
    const { result, props } = setup({
      days: twoDays, replacedDayIds: ['d2'],
      slotsByRoute: { generated: [live, deadActivity, deadBlock, normalDay], manual: [] },
    })
    await act(async () => { await result.current.generate() })
    const [, payload] = props.repo.replaceWeek.mock.calls[0]
    expect(payload).toEqual([
      { id: 'ns-1' },
      { group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'a1', fixed_event_id: null, type: 'activity', is_span_head: true, flags: {} },
    ])
  })

  it("placeFixedEvents() carries the manual route's replaced-day rows forward too", async () => {
    const { result, props } = setup({
      days: twoDays, replacedDayIds: ['d2'],
      slotsByRoute: { generated: [], manual: [stored()] },
    })
    await act(async () => { await result.current.placeFixedEvents() })
    const [, payload] = props.repo.replaceWeek.mock.calls[0]
    expect(payload.filter(r => r.day_id === 'd2')).toHaveLength(1)
  })
})
