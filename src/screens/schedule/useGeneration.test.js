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
import { useGeneration } from './useGeneration'

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
    expect(props.setActionError).toHaveBeenCalledWith('Could not save undo point — regeneration cancelled')
    expect(props.setGenerating).toHaveBeenLastCalledWith(false)
  })

  it('generate() aborts (no replace) and reports when ensureTemplateRow throws', async () => {
    const ensureTemplateRow = vi.fn(async () => { throw new Error('kind conflict') })
    const { result, props } = setup({ ensureTemplateRow })
    await act(async () => { await result.current.generate() })
    expect(props.repo.replaceWeek).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(
      'Could not open the generated schedule — nothing was changed. Try again, and tell support if it repeats.'
    )
  })

  it('generate() maps an admin-role replaceWeek failure to the admin-only message', async () => {
    const repo = makeRepo({ replaceWeek: vi.fn(async () => { throw new Error('admin role required') }) })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.generate() })
    expect(props.setActionError).toHaveBeenCalledWith('Only an admin can regenerate the schedule')
    expect(props.setGenerating).toHaveBeenLastCalledWith(false)
  })

  it('placeAnchors() builds fixedEvents-only for the manual route and defaults the selected group', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.placeAnchors() })
    expect(buildSchedule).toHaveBeenCalledWith(expect.objectContaining({ fixedEventsOnly: true }))
    expect(props.ensureTemplateRow).toHaveBeenCalledWith('manual')
    expect(props.repo.replaceWeek).toHaveBeenCalledWith('tid-manual', [{ id: 'ns-1' }])
    expect(props.setSelectedGroup).toHaveBeenCalledTimes(1)
  })

  it('placeAnchors() runs the week-exclusion pre-pass: an anchor for a closed activity is suppressed', async () => {
    // resolveWeekCatalog is NOT mocked here (only buildSchedule is), so this
    // pins the real seam: placeAnchors filters the catalog for the week before
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
    await act(async () => { await result.current.placeAnchors() })

    const arg = buildSchedule.mock.calls[0][0]
    expect(arg.fixedEventsOnly).toBe(true)
    expect(arg.fixedEvents).toEqual([]) // the excluded activity's anchor is gone
    expect(arg.activities.map(a => a.id)).not.toContain('a2')
    expect(arg.activities.map(a => a.id)).toContain('a1')
  })

  it('placeAnchors() runs the week-exclusion pre-pass for LOCATION closures too (guards the second resolveWeekCatalog call site)', async () => {
    // Mirrors the activity-exclusion test above, but closes the PLACE the anchor's
    // activity sits on. This pins the locationExclusions argument on placeAnchors()'s
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
    await act(async () => { await result.current.placeAnchors() })

    const arg = buildSchedule.mock.calls[0][0]
    expect(arg.fixedEvents).toEqual([]) // the anchor whose activity's PLACE is closed is gone
    expect(arg.activities.map(a => a.id)).not.toContain('a2')
    expect(arg.activities.map(a => a.id)).toContain('a1')
  })

  it('placeAnchors() leaves the catalog intact when the week has no exclusions', async () => {
    const { result } = setup({
      weekId: 'wk1',
      activities: [{ id: 'a1', name: 'Swim' }],
      fixedEvents: [{ id: 'an1', activity_id: 'a1', is_all_groups: true, group_ids: [] }],
      activityExclusions: [],
      groupExclusions: [],
    })
    await act(async () => { await result.current.placeAnchors() })

    const arg = buildSchedule.mock.calls[0][0]
    expect(arg.fixedEvents).toEqual([{ id: 'an1', activity_id: 'a1', is_all_groups: true, group_ids: [] }])
    expect(arg.activities.map(a => a.id)).toContain('a1')
  })

  it('placeAnchors() aborts the replace when the manual auto-snapshot fails', async () => {
    const saveSnapshot = vi.fn(async () => { throw new Error('snap failed') })
    const { result, props } = setup({
      slotsByRoute: { generated: [], manual: [{ id: 'y' }] },
      saveSnapshot,
    })
    await act(async () => { await result.current.placeAnchors() })
    expect(props.repo.replaceWeek).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith('Could not save undo point — regeneration cancelled')
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
      expect(props.setActionError).toHaveBeenCalledWith(expect.stringContaining('not linked to a valid activity'))
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

    it('placeAnchors() does NOT write the schedule when buildSchedule reports an error-severity finding', async () => {
      buildSchedule.mockReturnValueOnce({
        slots: [{ id: 'ns-1' }],
        findings: [{ kind: 'FIXED_EVENT_IDENTITY_GAP', severity: 'error', reason: 'dangling' }],
      })
      const { result, props } = setup()
      await act(async () => { await result.current.placeAnchors() })

      expect(props.repo.replaceWeek).not.toHaveBeenCalled()
      expect(props.setActionError).toHaveBeenCalledWith(expect.stringContaining('not linked to a valid activity'))
      expect(props.setGenerating).toHaveBeenLastCalledWith(false)
    })

    it('placeAnchors() DOES write the schedule when findings contain no error severity (non-vacuity)', async () => {
      buildSchedule.mockReturnValueOnce({
        slots: [{ id: 'ns-1' }],
        findings: [],
      })
      const { result, props } = setup()
      await act(async () => { await result.current.placeAnchors() })

      expect(props.repo.replaceWeek).toHaveBeenCalledWith('tid-manual', [{ id: 'ns-1' }])
    })
  })

  // Red Hat HIGH (round 2): the FIXED_EVENT_DUPLICATE gate is hand-duplicated at
  // three call sites of computeFindings, this hook's placeAnchors() being one.
  // The site has no ternary — it is hardcoded to never pass fixedEvents, since
  // placeAnchors is the MANUAL-route bootstrap and FIXED_EVENT_DUPLICATE is
  // generated-only (see the comment at useGeneration.js:242-245 and
  // useScheduleData.js:338-343: computeFindings' safe default, absent fixedEvents
  // -> no finding, is what keeps manual clean). A future edit that starts
  // passing fixedEvents here would regress that silently — nothing else exercises
  // this call's arguments.
  it('placeAnchors() calls computeFindings with no fixedEvents key at all (manual route never surfaces FIXED_EVENT_DUPLICATE)', async () => {
    const { result } = setup()
    await act(async () => { await result.current.placeAnchors() })

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
