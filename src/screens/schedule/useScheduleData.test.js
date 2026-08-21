// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useScheduleData, recalcStats, recalcFindings } from './useScheduleData'
import { deriveScheduleTemplateId } from '../../../electron/ops/scheduleTemplateId'

const CAMP_ID = 'camp-1'
const ROUTES = ['generated', 'manual']

function slotRow(overrides = {}) {
  return {
    id: 's1', template_id: 'tid-1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1',
    activity_id: null, anchor_id: null, is_anchor: false, flags: {},
    ...overrides,
  }
}

// A fake repo whose methods resolve immediately unless overridden — the
// hook's real signatures per src/data/scheduleRepository.js.
function makeRepo(overrides = {}) {
  return {
    loadSetupLists: vi.fn(async () => ({
      groups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bears', tier_id: 't1' }],
      days_of_operation: [{ id: 'd1', camp_id: CAMP_ID, day_of_week: 1, sort_order: 0 }],
      time_blocks: [{ id: 'b1', camp_id: CAMP_ID, sort_order: 0 }],
      activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim' }],
      anchor_activities: [],
      tiers: [{ id: 't1', camp_id: CAMP_ID, sort_order: 0 }],
      cohorts: [{ id: 'coh-1', camp_id: CAMP_ID }],
      elective_sets: [],
      elective_set_activities: [],
    })),
    loadDurableElectiveSets: vi.fn(async () => ([])),
    loadWeeks: vi.fn(async () => ([
      { id: 'week-1', camp_id: CAMP_ID, name: 'Week 1', sort_order: 0, is_archived: 0 },
    ])),
    createWeek: vi.fn(async () => ({ status: 'applied' })),
    loadWeekExclusions: vi.fn(async () => ({ activityExclusions: [], groupExclusions: [] })),
    loadTemplateData: vi.fn(async () => ({
      templates: [],
      slots: [],
      overlays: [],
      snapshots: [],
    })),
    ...overrides,
  }
}

describe('useScheduleData', () => {
  it('loads setup lists, resolves weekId, and clears loading', async () => {
    const repo = makeRepo()
    const { result } = renderHook(() =>
      useScheduleData({ campId: CAMP_ID, weekId: null, repo, routes: ROUTES })
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.weekId).toBe('week-1')
    expect(result.current.setupLists.groups).toHaveLength(1)
    expect(result.current.loadError).toBeNull()
    expect(result.current.templateError).toBeNull()
  })

  // Scenario 1: a week deleted on a peer produces weekDeletedBanner and a
  // resolved fallback weekId.
  it('a week deleted on a peer produces weekDeletedBanner and falls back to the first remaining week', async () => {
    const repo = makeRepo({
      loadWeeks: vi.fn(async () => ([
        { id: 'week-2', camp_id: CAMP_ID, name: 'Week 2', sort_order: 1, is_archived: 0 },
      ])),
    })
    // preferredWeekId points at a week that no longer exists on this load.
    const { result } = renderHook(() =>
      useScheduleData({ campId: CAMP_ID, weekId: 'week-1', repo, routes: ROUTES })
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.weekDeletedBanner).toMatch(/deleted on another device/i)
    expect(result.current.weekId).toBe('week-2')
  })

  // T63: anchor_activities.group_ids is stored as a JSON-stringified array
  // (same shape as activities.eligible_group_ids). buildSchedule is a pure
  // engine and must never see the raw string — this hook is the IPC read
  // boundary, so normalization to a real array belongs here.
  it('normalizes a string-encoded anchor group_ids into an array', async () => {
    const repo = makeRepo({
      loadSetupLists: vi.fn(async () => ({
        groups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bears', tier_id: 't1' }],
        days_of_operation: [{ id: 'd1', camp_id: CAMP_ID, day_of_week: 1, sort_order: 0 }],
        time_blocks: [{ id: 'b1', camp_id: CAMP_ID, sort_order: 0 }],
        activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim' }],
        anchor_activities: [
          { id: 'anc-1', camp_id: CAMP_ID, name: 'Flag', group_ids: '["g1","g2"]', unit_id: null, is_all_groups: false, day_id: 'd1', time_block_id: 'b1', span_blocks: 1 },
        ],
        tiers: [{ id: 't1', camp_id: CAMP_ID, sort_order: 0 }],
        cohorts: [{ id: 'coh-1', camp_id: CAMP_ID }],
      })),
    })
    const { result } = renderHook(() =>
      useScheduleData({ campId: CAMP_ID, weekId: null, repo, routes: ROUTES })
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.setupLists.anchors).toHaveLength(1)
    expect(result.current.setupLists.anchors[0].group_ids).toEqual(['g1', 'g2'])
  })

  // Scenario 2: repo.loadTemplateData throwing sets templateError while
  // leaving setupLists populated from the earlier successful block — proves
  // the error partitioning survived the move.
  it('a template-data failure sets templateError but keeps the setup lists from the earlier successful block', async () => {
    const repo = makeRepo({
      loadTemplateData: vi.fn(async () => { throw new Error('boom') }),
    })
    const { result } = renderHook(() =>
      useScheduleData({ campId: CAMP_ID, weekId: null, repo, routes: ROUTES })
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.templateError).toMatch(/Failed to load saved schedule/i)
    expect(result.current.setupLists.groups).toHaveLength(1)
    expect(result.current.loadError).toBeNull()
  })

  // Scenario 3: idempotency — calling reload() twice against unchanged state
  // produces no further weekId change (guards the C1-R2 feedback loop: the
  // screen feeds the resolved weekId back in as `preferredWeekId`, and that
  // echo must not cause endless re-resolution).
  it('calling reload() twice against unchanged state produces no further weekId change', async () => {
    const repo = makeRepo()
    const { result } = renderHook(() =>
      useScheduleData({ campId: CAMP_ID, weekId: 'week-1', repo, routes: ROUTES })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.weekId).toBe('week-1')
    const loadWeeksCallsAfterMount = repo.loadWeeks.mock.calls.length

    await result.current.reload()
    await result.current.reload()

    expect(result.current.weekId).toBe('week-1')
    // Two explicit reload() calls each re-fetch (reload always runs — only
    // the mount/prop-driven effect self-skips on an echoed weekId).
    expect(repo.loadWeeks.mock.calls.length).toBe(loadWeeksCallsAfterMount + 2)
  })

  // Scenario 4: ordering — start load A, then load B with a faster fake repo;
  // resolve B then A; assert final state reflects B, not A. This guards
  // C1-R1's generation guard and MUST fail if that guard is removed.
  it('a slower in-flight load does not stamp stale data over a faster, newer one', async () => {
    let resolveSlow
    const slowPromise = new Promise((resolve) => { resolveSlow = resolve })
    let callCount = 0
    const repo = makeRepo({
      loadWeeks: vi.fn(async () => ([
        { id: 'week-1', camp_id: CAMP_ID, name: 'Week 1', sort_order: 0, is_archived: 0 },
        { id: 'week-2', camp_id: CAMP_ID, name: 'Week 2', sort_order: 1, is_archived: 0 },
      ])),
      loadTemplateData: vi.fn(async () => {
        callCount += 1
        const templates = [
          { id: deriveScheduleTemplateId('week-1', 'generated'), camp_id: CAMP_ID, kind: 'generated', week_id: 'week-1' },
          { id: deriveScheduleTemplateId('week-2', 'generated'), camp_id: CAMP_ID, kind: 'generated', week_id: 'week-2' },
        ]
        if (callCount === 1) {
          // Load A (started first) hangs here until explicitly released,
          // well after load B has already completed.
          await slowPromise
          return {
            templates,
            slots: [slotRow({ id: 'stale-slot', template_id: deriveScheduleTemplateId('week-1', 'generated') })],
            overlays: [], snapshots: [],
          }
        }
        return {
          templates,
          slots: [slotRow({ id: 'fresh-slot', template_id: deriveScheduleTemplateId('week-2', 'generated') })],
          overlays: [], snapshots: [],
        }
      }),
    })

    const { result, rerender } = renderHook(
      ({ weekId }) => useScheduleData({ campId: CAMP_ID, weekId, repo, routes: ROUTES }),
      { initialProps: { weekId: 'week-1' } }
    )
    // Wait for load A to actually reach the templateData stage (past setup
    // lists and weeks) before starting load B — otherwise load B's generation
    // bump would abort load A at its very first checkpoint, before the block
    // under test (the templateData bail) is ever exercised.
    await waitFor(() => expect(callCount).toBe(1))
    // Load A is now in flight, parked on slowPromise inside loadTemplateData.

    // Load B: a genuinely different preferred week, started while A is still
    // in flight. It resolves fully (repo calls above are synchronous/fast)
    // before A is released below.
    rerender({ weekId: 'week-2' })
    await waitFor(() => expect(callCount).toBe(2))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const slotsAfterB = result.current.templateData.slotsByRoute.generated
    expect(slotsAfterB.some((s) => s.id === 'fresh-slot')).toBe(true)

    // Now release load A. If the generation guard is doing its job, A's
    // (now-stale) setters must be no-ops. A real macrotask tick (not just a
    // microtask flush) so load A's post-resolveSlow continuation — the
    // route loop, setTemplateDataState, setLoading(false) — has definitely
    // run one way or the other before asserting; otherwise "no stale-slot"
    // could pass merely because we didn't wait long enough, not because the
    // guard blocked it (exactly the false-negative the red-team step guards
    // against).
    resolveSlow()
    await new Promise((r) => setTimeout(r, 20))

    const slotsAfterA = result.current.templateData.slotsByRoute.generated
    expect(slotsAfterA.some((s) => s.id === 'stale-slot')).toBe(false)
    expect(slotsAfterA.some((s) => s.id === 'fresh-slot')).toBe(true)
  })
})

describe('recalcStats (pure)', () => {
  it('counts open (non-anchor) and filled (non-anchor with an activity) slots', () => {
    const slots = [
      slotRow({ is_anchor: false, activity_id: 'act-1' }),
      slotRow({ is_anchor: false, activity_id: null }),
      slotRow({ is_anchor: true, activity_id: 'act-2' }),
    ]
    expect(recalcStats(slots)).toEqual({ open: 2, filled: 1 })
  })

  it('returns zeroes for an empty slot list', () => {
    expect(recalcStats([])).toEqual({ open: 0, filled: 0 })
  })

  it('excludes unavailable-typed slots from open (they are permanently unplaceable time, not open time)', () => {
    const slots = [
      slotRow({ is_anchor: false, activity_id: 'act-1' }),
      slotRow({ is_anchor: false, activity_id: null, type: 'unavailable' }),
    ]
    expect(recalcStats(slots)).toEqual({ open: 1, filled: 1 })
  })
})

describe('recalcFindings (pure)', () => {
  it('delegates to computeFindings with the given ctx and returns an array', () => {
    const slots = [slotRow({ activity_id: 'act-1', group_id: 'g1' })]
    const ctx = {
      groups: [{ id: 'g1', tier_id: 't1' }],
      activities: [{ id: 'act-1', name: 'Swim', min_per_week: 1 }],
      days: [{ id: 'd1', day_of_week: 1 }],
    }
    const result = recalcFindings(slots, ctx)
    expect(Array.isArray(result)).toBe(true)
  })
})
