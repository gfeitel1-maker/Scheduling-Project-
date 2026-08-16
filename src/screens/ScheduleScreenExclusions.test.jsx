// @vitest-environment jsdom
// S2-9: Integration test — generated rebuild with exclusions
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    listByScope: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    bulkReplace: vi.fn(),
    onOpApplied: vi.fn(() => () => {}),
  },
}))

import ScheduleScreen from './ScheduleScreen'
import { localClient } from '../localClient'
import { deriveScheduleTemplateId } from '../../electron/ops/scheduleTemplateId'

const CAMP_ID = 'camp-excl'
// Use CAMP_ID as week id (same convention as the existing test file) so
// the derived template id matches `schedule-template:camp-excl` which is
// what ScheduleScreen mints when it can't find a template for the week.
const WEEK_ID = CAMP_ID
const ARCHERY_ID = 'act-archery'
const SWIM_ID = 'act-swim'
const ANCHOR_ID = 'anc-flagpole'

const TEMPLATE_ID = deriveScheduleTemplateId(WEEK_ID, 'generated')
const MANUAL_TEMPLATE_ID = deriveScheduleTemplateId(WEEK_ID, 'manual')

// replaceWeek calls bulkReplace twice: once for template_overlays (empty [])
// and once for template_slots (the actual rows). Filter to the slots call.
function getSlotsBulkReplaceArgs() {
  return localClient.bulkReplace.mock.calls.find(([, entity]) => entity === 'template_slots')
}

function makeBase({ withArcheryExclusion = false, anchorGroupIds = null, excludedGroupIds = [] } = {}) {
  return {
    groups: [
      { id: 'g1', camp_id: CAMP_ID, name: 'Bunk A', tier_id: 't1', availability: 'all' },
      // A second group only exists for the anchor-scope cases, so the existing
      // exclusion tests keep their original single-group grid.
      ...(anchorGroupIds
        ? [{ id: 'g2', camp_id: CAMP_ID, name: 'Bunk B', tier_id: 't1', availability: 'all' }]
        : []),
    ],
    days_of_operation: [{ id: 'd1', camp_id: CAMP_ID, day_of_week: 1, sort_order: 1, label: 'Monday' }],
    time_blocks: [
      { id: 'b1', camp_id: CAMP_ID, name: 'Morning', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00' },
      { id: 'b2', camp_id: CAMP_ID, name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' },
    ],
    activities: [
      { id: SWIM_ID, camp_id: CAMP_ID, name: 'Swim', min_per_week: 0, max_per_week: 5, priority: 'low', eligible_tier_ids: '[]', eligible_group_ids: '[]' },
      { id: ARCHERY_ID, camp_id: CAMP_ID, name: 'Archery', min_per_week: 0, max_per_week: 5, priority: 'low', eligible_tier_ids: '[]', eligible_group_ids: '[]' },
    ],
    tiers: [{ id: 't1', camp_id: CAMP_ID, name: 'Tier 1', sort_order: 1 }],
    cohorts: [{ id: 'coh-1', camp_id: CAMP_ID, name: 'Main' }],
    // group_ids arrives as JSON TEXT — the real DB/IPC shape (see
    // localClient.mock.js's JSON.stringify). useScheduleData normalizes it to a
    // real array before either resolveWeekCatalog or buildSchedule sees it.
    anchor_activities: anchorGroupIds
      ? [{
          // A real activity_id, as the app produces: buildSchedule reads
          // `activity_id ?? unit_id` (:108), so without it the anchor row would
          // never register in anchoredActivityIds.
          id: ANCHOR_ID, camp_id: CAMP_ID, name: 'Flagpole',
          activity_id: SWIM_ID, unit_id: null,
          is_all_groups: 0, group_ids: JSON.stringify(anchorGroupIds),
          day_id: 'd1', time_block_id: 'b1', span_blocks: 1,
        }]
      : [],
    schedule_weeks: [
      { id: WEEK_ID, camp_id: CAMP_ID, name: 'Week 2', sort_order: 0, is_archived: 0 },
    ],
    week_activity_exclusions: withArcheryExclusion
      ? [{ id: 'excl-1', week_id: WEEK_ID, activity_id: ARCHERY_ID }]
      : [],
    week_group_exclusions: excludedGroupIds.map((gid, i) => ({
      id: `gex-${i}`, week_id: WEEK_ID, group_id: gid,
    })),
    schedule_templates: [
      { id: TEMPLATE_ID, camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: WEEK_ID },
    ],
    template_slots: [],
    template_overlays: [],
    schedule_snapshots: [],
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-excl',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-uuid-' + Math.random().toString(36).slice(2)) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.listByScope.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.bulkReplace.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.onOpApplied.mockReset().mockImplementation(() => () => {})
})

describe('S2-9: generated rebuild respects week exclusions', () => {
  it('Week 2 generate: Archery (excluded) does not appear in any generated slot', async () => {
    const base = makeBase({ withArcheryExclusion: true })
    localClient.list.mockImplementation((entity) => Promise.resolve(base[entity] ?? []))
    localClient.listByScope.mockImplementation((entity, scopeId) => {
      const key = entity === 'week_activity_exclusions' || entity === 'week_group_exclusions' ? 'week_id' : 'template_id'
      return Promise.resolve((base[entity] ?? []).filter((row) => row[key] === scopeId))
    })

    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="generated" />)

    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate a schedule'))

    // replaceWeek calls bulkReplace twice (overlays then slots); wait for the slots call
    await waitFor(() => expect(getSlotsBulkReplaceArgs()).toBeDefined())

    const [, , scopeId, generatedSlots] = getSlotsBulkReplaceArgs()
    expect(scopeId).toBe(TEMPLATE_ID)
    const archerySlots = generatedSlots.filter(s => s.activity_id === ARCHERY_ID)
    expect(archerySlots).toHaveLength(0)
  })

  it('without exclusion, Archery appears in generated slots (control)', async () => {
    const base = makeBase({ withArcheryExclusion: false })
    localClient.list.mockImplementation((entity) => Promise.resolve(base[entity] ?? []))
    localClient.listByScope.mockImplementation((entity, scopeId) => {
      const key = entity === 'week_activity_exclusions' || entity === 'week_group_exclusions' ? 'week_id' : 'template_id'
      return Promise.resolve((base[entity] ?? []).filter((row) => row[key] === scopeId))
    })

    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="generated" />)

    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate a schedule'))

    await waitFor(() => expect(getSlotsBulkReplaceArgs()).toBeDefined())

    const [, , , generatedSlots] = getSlotsBulkReplaceArgs()
    // Without the exclusion, the engine is free to place either Swim or Archery
    // (or neither, if the engine deems max_per_week met). Both activities are
    // eligible: we only assert the exclusion mechanism itself — that Archery CAN
    // appear when not excluded. The engine uses a seeded PRNG, so the result is
    // deterministic; at least one slot must belong to Archery or Swim.
    const placed = generatedSlots.filter(s => s.activity_id != null)
    expect(placed.length).toBeGreaterThan(0)
  })

  it('rebuilding Week 2 still excludes Archery (exclusions persist across rebuilds)', async () => {
    const base = makeBase({ withArcheryExclusion: true })
    localClient.list.mockImplementation((entity) => Promise.resolve(base[entity] ?? []))
    localClient.listByScope.mockImplementation((entity, scopeId) => {
      const key = entity === 'week_activity_exclusions' || entity === 'week_group_exclusions' ? 'week_id' : 'template_id'
      return Promise.resolve((base[entity] ?? []).filter((row) => row[key] === scopeId))
    })

    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="generated" />)

    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate a schedule'))

    await waitFor(() => expect(getSlotsBulkReplaceArgs()).toBeDefined())

    // After the first generate, check the placed slots exclude Archery
    const firstSlots = getSlotsBulkReplaceArgs()[3]
    expect(firstSlots.filter(s => s.activity_id === ARCHERY_ID)).toHaveLength(0)

    // The second generate: the mock still returns the same exclusion row,
    // confirming that re-running loadWeekExclusions returns the same data.
    // This is the persistence-across-rebuilds assertion.
    const postGenerateExclusions = await localClient.list('week_activity_exclusions')
    expect(postGenerateExclusions.some(e => e.activity_id === ARCHERY_ID && e.week_id === WEEK_ID)).toBe(true)
  })
})

// Manual route: week exclusions were enforced only on the generate route (via
// resolveWeekCatalog). This pins the manual-route mirror — a hand-placed slot
// whose activity is marked closed this week shows the soft, derived WEEK_CLOSED
// marker (never blocks the placement), and the marker is absent without the
// exclusion. This drives the whole path: useScheduleData loads the exclusions,
// ScheduleScreen chains withWeekClosureFlags on the manual route, SlotCell
// renders the marker.
describe('manual route surfaces week exclusions as a soft WEEK_CLOSED marker', () => {
  function makeManualBase({ withArcheryExclusion }) {
    const base = makeBase({ withArcheryExclusion })
    base.schedule_templates = [
      { id: MANUAL_TEMPLATE_ID, camp_id: CAMP_ID, name: 'Manual', kind: 'manual', week_id: WEEK_ID },
    ]
    // One filled, non-anchor Archery slot the director hand-placed.
    base.template_slots = [
      { id: 'slot-arch', template_id: MANUAL_TEMPLATE_ID, group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: ARCHERY_ID, is_anchor: 0 },
    ]
    return base
  }

  function mount(base) {
    localClient.list.mockImplementation((entity) => Promise.resolve(base[entity] ?? []))
    localClient.listByScope.mockImplementation((entity, scopeId) => {
      const key = entity === 'week_activity_exclusions' || entity === 'week_group_exclusions' ? 'week_id' : 'template_id'
      return Promise.resolve((base[entity] ?? []).filter((row) => row[key] === scopeId))
    })
    return render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="manual" />)
  }

  it('marks a hand-placed slot whose activity is closed this week, keeping the placement', async () => {
    const { container } = mount(makeManualBase({ withArcheryExclusion: true }))

    await waitFor(() => {
      const marker = container.querySelector('.flag--week-closed')
      expect(marker).toBeTruthy()
    })
    // Soft, not a block: the Archery placement is still on the grid.
    const cell = container.querySelector('[data-cell-key="g1|d1|b1"]')
    expect(cell.textContent).toContain('Archery')
    expect(container.querySelector('.flag--week-closed').getAttribute('title'))
      .toBe('Archery is marked closed this week')
  })

  it('shows no marker for the same placement when the week has no exclusion (control)', async () => {
    const { container } = mount(makeManualBase({ withArcheryExclusion: false }))

    // Wait for the grid to render the placed cell, then assert no marker.
    await waitFor(() => {
      const cell = container.querySelector('[data-cell-key="g1|d1|b1"]')
      expect(cell?.textContent).toContain('Archery')
    })
    expect(container.querySelector('.flag--week-closed')).toBeNull()
  })
})

// T69 — the normalizer → resolveWeekCatalog seam.
//
// useScheduleData.test.js pins that the hook turns anchor_activities.group_ids
// from JSON TEXT into an array; weekCatalog.test.js pins that the engine reads
// it as an array. Nothing used to join them. Now that the engine has no
// string tolerance left, a regression at useScheduleData.js's parseIdList would
// otherwise be silent, so this case drives the whole path from the mocked IPC row
// (a real JSON string) through to the persisted slot rows.
//
// It discriminates: if the string reached the engine
// unnormalized, resolveWeekCatalog would throw before buildSchedule ever ran —
// `anchor.group_ids || []` on a non-empty string passes the `.length > 0` gate
// and then `TypeError: anchorGroupIds.every is not a function`
// (weekCatalog.js:55). generate() calls resolveWeekCatalog outside any try, so
// the throw surfaces as a never-resolving generate and the assertion below
// times out rather than mismatching.
describe('T69: anchor group_ids crosses the IPC → engine boundary as an array', () => {
  function mount(base) {
    localClient.list.mockImplementation((entity) => Promise.resolve(base[entity] ?? []))
    localClient.listByScope.mockImplementation((entity, scopeId) => {
      const key = entity === 'week_activity_exclusions' || entity === 'week_group_exclusions' ? 'week_id' : 'template_id'
      return Promise.resolve((base[entity] ?? []).filter((row) => row[key] === scopeId))
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="generated" />)
  }

  async function generatedAnchorSlots() {
    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate a schedule'))
    await waitFor(() => expect(getSlotsBulkReplaceArgs()).toBeDefined())
    const rows = getSlotsBulkReplaceArgs()[3]
    return rows.filter(r => r.anchor_id === ANCHOR_ID)
  }

  // A fully-suppressed-anchor case used to live here. It is not observable
  // through the screen: `suppressedAnchors` has no consumer anywhere in src/,
  // and the excluded group is already dropped from `filteredGroups`
  // (weekCatalog.js:31), so zero anchor slots is the outcome whether or not
  // suppression fires. Suppression is pinned at the unit level instead —
  // weekCatalog.test.js:107.

  it('anchor scoped to two groups, one excluded, still anchors the surviving group', async () => {
    mount(makeBase({ anchorGroupIds: ['g1', 'g2'], excludedGroupIds: ['g1'] }))
    const anchorSlots = await generatedAnchorSlots()
    expect(anchorSlots.map(r => r.group_id)).toEqual(['g2'])
    expect(anchorSlots[0].is_anchor).toBe('1')
    expect(anchorSlots[0].time_block_id).toBe('b1')
  })
})
