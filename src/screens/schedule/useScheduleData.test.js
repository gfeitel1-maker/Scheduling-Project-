// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  // T107 item 3 / ADR §4 + Red Hat R2 — repair-on-read quiescence. Constructs
  // the cross-device interleaving from ADR test seam #11: a tail row whose
  // predecessor is not a valid head/prior-tail of the same chain (the head
  // hasn't arrived yet, or was independently released elsewhere). The pass
  // must NOT heal on first sight, must heal once the orphan persists across a
  // second read with no in-flight local claim, and must NOT heal at all while
  // an in-flight local claim covers that group/day.
  describe('repair-on-read: orphan span tails (T107 item 3, R2 quiescence)', () => {
    const orphanTimeBlocks = [
      { id: 'b1', camp_id: CAMP_ID, sort_order: 0 },
      { id: 'b2', camp_id: CAMP_ID, sort_order: 1 },
    ]
    const templates = [{ id: 'tid-manual', camp_id: CAMP_ID, kind: 'manual', week_id: 'week-1' }]
    // b1 has no row at all (head never arrived on this device yet) — b2's
    // predecessor lookup finds nothing, so it is an orphan by
    // repairOrphanSpanTails' rule.
    const orphanRow = { id: 'orphan-1', template_id: 'tid-manual', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false, flags: {} }

    // Controllable clock (Red Hat 2026-08-21): the repair pass gates healing on
    // REPAIR_QUIESCENCE_MS (750ms) of wall-clock idle between load starts, so a
    // sync burst can't trip it. Real Date.now() would put two test reloads
    // milliseconds apart (never "settled"), so we drive the clock explicitly:
    // advance it past the window to model a settled state, leave it inside the
    // window to model a burst.
    let nowMs
    beforeEach(() => { nowMs = 100000; vi.spyOn(Date, 'now').mockImplementation(() => nowMs) })
    afterEach(() => { vi.restoreAllMocks() })
    const advancePastQuiescence = () => { nowMs += 1000 }

    function makeOrphanRepo() {
      return makeRepo({
        loadSetupLists: vi.fn(async () => ({
          groups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bears', tier_id: 't1' }],
          days_of_operation: [{ id: 'd1', camp_id: CAMP_ID, day_of_week: 1, sort_order: 0 }],
          time_blocks: orphanTimeBlocks,
          activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim' }],
          anchor_activities: [],
          tiers: [{ id: 't1', camp_id: CAMP_ID, sort_order: 0 }],
          cohorts: [{ id: 'coh-1', camp_id: CAMP_ID }],
        })),
        loadTemplateData: vi.fn(async () => ({
          templates, slots: [orphanRow], overlays: [], snapshots: [],
        })),
        writeSlotFields: vi.fn(async () => ({ status: 'applied' })),
      })
    }

    it('does not heal on first sight', async () => {
      const repo = makeOrphanRepo()
      const { result } = renderHook(() =>
        useScheduleData({ campId: CAMP_ID, weekId: 'week-1', repo, routes: ['manual'] })
      )
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(repo.writeSlotFields).not.toHaveBeenCalled()
    })

    it('heals once the orphan persists across a second read with no in-flight local claim', async () => {
      const repo = makeOrphanRepo()
      const { result } = renderHook(() =>
        useScheduleData({ campId: CAMP_ID, weekId: 'week-1', repo, routes: ['manual'] })
      )
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(repo.writeSlotFields).not.toHaveBeenCalled() // first sight, still un-healed

      advancePastQuiescence() // a settled read, not a same-burst reload
      await result.current.reload()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(repo.writeSlotFields).toHaveBeenCalledWith('orphan-1', { activity_id: null, is_span_head: true, flags: {} })
    })

    it('does NOT heal when the second sighting lands within a sync burst (Red Hat R2 quiescence)', async () => {
      const repo = makeOrphanRepo()
      const { result } = renderHook(() =>
        useScheduleData({ campId: CAMP_ID, weekId: 'week-1', repo, routes: ['manual'] })
      )
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(repo.writeSlotFields).not.toHaveBeenCalled() // first sight

      // Second load lands < REPAIR_QUIESCENCE_MS after the first (an unbatched
      // per-op reload storm, e.g. a Generate/bulkReplace replicating): the
      // orphan is "seen twice" but the state has NOT settled, so a
      // legitimately in-flight span mid-replication must NOT be truncated.
      nowMs += 100
      await result.current.reload()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(repo.writeSlotFields).not.toHaveBeenCalled()
    })

    it('does NOT heal while an in-flight local claim covers the orphan\'s group/day', async () => {
      const repo = makeOrphanRepo()
      const hasInFlightClaim = vi.fn(() => true)
      const { result } = renderHook(() =>
        useScheduleData({ campId: CAMP_ID, weekId: 'week-1', repo, routes: ['manual'], hasInFlightClaim })
      )
      await waitFor(() => expect(result.current.loading).toBe(false))

      advancePastQuiescence() // settled, so the ONLY reason not to heal is the claim
      await result.current.reload()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(repo.writeSlotFields).not.toHaveBeenCalled()
      expect(hasInFlightClaim).toHaveBeenCalledWith('g1', 'd1')
    })

    it('is idempotent: once healed, a further reload does not heal again (the row no longer reads as an orphan)', async () => {
      const repo = makeOrphanRepo()
      const { result } = renderHook(() =>
        useScheduleData({ campId: CAMP_ID, weekId: 'week-1', repo, routes: ['manual'] })
      )
      await waitFor(() => expect(result.current.loading).toBe(false))
      advancePastQuiescence()
      await result.current.reload()
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(repo.writeSlotFields).toHaveBeenCalledTimes(1)

      // Simulate the healed state now reflected in what loadTemplateData
      // returns (the normal write path having landed) — a real device would
      // read its own healed row back.
      repo.loadTemplateData.mockResolvedValue({
        templates,
        slots: [{ ...orphanRow, activity_id: null, is_span_head: true, flags: {} }],
        overlays: [], snapshots: [],
      })
      repo.writeSlotFields.mockClear()
      advancePastQuiescence() // settled, so a lingering orphan WOULD heal — proving it's the no-longer-orphan state, not the gate, that stays the hand
      await result.current.reload()
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(repo.writeSlotFields).not.toHaveBeenCalled()
    })
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
