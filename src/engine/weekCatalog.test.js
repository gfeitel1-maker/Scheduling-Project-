import { describe, it, expect } from 'vitest'
import { resolveWeekCatalog } from './weekCatalog.js'

const WEEK = 'week-1'

const activities = [
  { id: 'act-swim', name: 'Swim', location_id: 'loc-pool' },
  { id: 'act-art', name: 'Art', location_id: null },
  { id: 'act-soccer', name: 'Soccer', location_id: 'loc-field' },
]

const groups = [
  { id: 'grp-1', name: 'Bunk 1' },
  { id: 'grp-2', name: 'Bunk 2' },
  { id: 'grp-3', name: 'Bunk 3' },
]

// T69: group_ids is an array of ids. resolveWeekCatalog does not deserialize —
// the boundary (src/screens/schedule/useScheduleData.js) normalizes the stored
// JSON TEXT before the engine sees it, so these fixtures must be real arrays.
const anchors = [
  { id: 'anch-1', activity_id: 'act-swim', is_all_groups: false, group_ids: ['grp-1', 'grp-2'] },
  { id: 'anch-2', activity_id: 'act-art', is_all_groups: true, group_ids: null },
  { id: 'anch-3', activity_id: 'act-soccer', is_all_groups: false, group_ids: ['grp-3'] },
]

describe('resolveWeekCatalog', () => {
  it('no exclusions → returns input unchanged with empty suppressedAnchors', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [], groupExclusions: [],
    })
    expect(result.activities).toBe(activities)
    expect(result.groups).toBe(groups)
    expect(result.anchors).toBe(anchors)
    expect(result.suppressedAnchors).toEqual([])
  })

  it('null/undefined exclusion arrays → treated as no exclusions', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: null, groupExclusions: undefined,
    })
    expect(result.activities).toBe(activities)
    expect(result.groups).toBe(groups)
    expect(result.suppressedAnchors).toEqual([])
  })

  it('all activities excluded → empty activities array (Red Hat regression test)', () => {
    const activityExclusions = activities.map((a) => ({ week_id: WEEK, activity_id: a.id }))
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions, groupExclusions: [],
    })
    expect(result.activities).toHaveLength(0)
    // Must NOT return the full camp catalog
    expect(result.activities).not.toBe(activities)
  })

  it('single activity excluded → that activity absent, others present', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [{ week_id: WEEK, activity_id: 'act-swim' }],
      groupExclusions: [],
    })
    expect(result.activities.map((a) => a.id)).not.toContain('act-swim')
    expect(result.activities.map((a) => a.id)).toContain('act-art')
    expect(result.activities.map((a) => a.id)).toContain('act-soccer')
  })

  it('anchor whose activity is excluded → suppressed with reason activity-excluded', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [{ week_id: WEEK, activity_id: 'act-swim' }],
      groupExclusions: [],
    })
    expect(result.suppressedAnchors).toHaveLength(1)
    expect(result.suppressedAnchors[0].anchor.id).toBe('anch-1')
    expect(result.suppressedAnchors[0].reason).toBe('activity-excluded')
    expect(result.anchors.map((a) => a.id)).not.toContain('anch-1')
  })

  it('anchor whose every group is excluded → suppressed with reason all-groups-excluded', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [{ week_id: WEEK, group_id: 'grp-3' }],
    })
    expect(result.suppressedAnchors).toHaveLength(1)
    expect(result.suppressedAnchors[0].anchor.id).toBe('anch-3')
    expect(result.suppressedAnchors[0].reason).toBe('all-groups-excluded')
  })

  it('anchor with one excluded group but others remaining → NOT suppressed', () => {
    // anch-1 has grp-1 and grp-2; only grp-1 is excluded
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [{ week_id: WEEK, group_id: 'grp-1' }],
    })
    const suppressedIds = result.suppressedAnchors.map((s) => s.anchor.id)
    expect(suppressedIds).not.toContain('anch-1')
    expect(result.anchors.map((a) => a.id)).toContain('anch-1')
  })

  // T69: pin the array-only contract for anchor group_ids explicitly, including
  // the `length > 0` gate that keeps a scopeless anchor alive.
  it('array group_ids: suppressed only when EVERY listed group is excluded', () => {
    const anchor = { id: 'anch-x', activity_id: 'act-swim', is_all_groups: false, group_ids: ['grp-1', 'grp-2'] }

    const partial = resolveWeekCatalog({
      groups, activities, anchors: [anchor], weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [{ week_id: WEEK, group_id: 'grp-1' }],
    })
    expect(partial.suppressedAnchors).toEqual([])
    expect(partial.anchors.map((a) => a.id)).toContain('anch-x')

    const all = resolveWeekCatalog({
      groups, activities, anchors: [anchor], weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [
        { week_id: WEEK, group_id: 'grp-1' },
        { week_id: WEEK, group_id: 'grp-2' },
      ],
    })
    expect(all.suppressedAnchors).toHaveLength(1)
    expect(all.suppressedAnchors[0].anchor.id).toBe('anch-x')
    expect(all.suppressedAnchors[0].reason).toBe('all-groups-excluded')
    expect(all.anchors).toHaveLength(0)
  })

  it('empty group_ids with is_all_groups false → kept (the length > 0 gate)', () => {
    const anchor = { id: 'anch-empty', activity_id: 'act-swim', is_all_groups: false, group_ids: [] }
    const result = resolveWeekCatalog({
      groups, activities, anchors: [anchor], weekId: WEEK,
      activityExclusions: [],
      groupExclusions: groups.map((g) => ({ week_id: WEEK, group_id: g.id })),
    })
    expect(result.suppressedAnchors).toEqual([])
    expect(result.anchors.map((a) => a.id)).toContain('anch-empty')
  })

  it('null group_ids with is_all_groups false → kept (NULL is a real DB state)', () => {
    const anchor = { id: 'anch-null', activity_id: 'act-swim', is_all_groups: false, group_ids: null }
    const result = resolveWeekCatalog({
      groups, activities, anchors: [anchor], weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [{ week_id: WEEK, group_id: 'grp-1' }],
    })
    expect(result.suppressedAnchors).toEqual([])
    expect(result.anchors.map((a) => a.id)).toContain('anch-null')
  })

  it('exclusions for a different week are ignored', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [{ week_id: 'other-week', activity_id: 'act-swim' }],
      groupExclusions: [{ week_id: 'other-week', group_id: 'grp-1' }],
    })
    expect(result.activities).toBe(activities)
    expect(result.groups).toBe(groups)
    expect(result.suppressedAnchors).toEqual([])
  })

  // M5 — location-excluded → the location→activity hop. A closed location
  // filters every activity bound to it, not the locations array (the engine
  // treats an unmapped location_id as unconstrained — filtering activities is
  // the only enforcement that actually stops placement).
  it('location excluded → activities bound to that location are filtered, others kept', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [], groupExclusions: [],
      locationExclusions: [{ week_id: WEEK, location_id: 'loc-pool' }],
    })
    expect(result.activities.map((a) => a.id)).not.toContain('act-swim')
    expect(result.activities.map((a) => a.id)).toContain('act-art')
    expect(result.activities.map((a) => a.id)).toContain('act-soccer')
  })

  it('activity with no location_id is never filtered by a location exclusion', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [], groupExclusions: [],
      locationExclusions: [{ week_id: WEEK, location_id: 'loc-pool' }, { week_id: WEEK, location_id: 'loc-field' }],
    })
    expect(result.activities.map((a) => a.id)).toEqual(['act-art'])
  })

  it('anchor whose activity\'s location is excluded → suppressed with reason location-excluded', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [], groupExclusions: [],
      locationExclusions: [{ week_id: WEEK, location_id: 'loc-pool' }],
    })
    expect(result.suppressedAnchors).toHaveLength(1)
    expect(result.suppressedAnchors[0].anchor.id).toBe('anch-1')
    expect(result.suppressedAnchors[0].reason).toBe('location-excluded')
    expect(result.anchors.map((a) => a.id)).not.toContain('anch-1')
  })

  it('null/undefined locationExclusions → treated as no location exclusions', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [], groupExclusions: [], locationExclusions: null,
    })
    expect(result.activities).toBe(activities)
    expect(result.suppressedAnchors).toEqual([])
  })

  it('location exclusion for a different week is ignored', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors, weekId: WEEK,
      activityExclusions: [], groupExclusions: [],
      locationExclusions: [{ week_id: 'other-week', location_id: 'loc-pool' }],
    })
    expect(result.activities).toBe(activities)
    expect(result.suppressedAnchors).toEqual([])
  })
})

// The anchors above all carry `activity_id`, a column `anchor_activities` has
// never had (see anchorActivityLink.js). Every suppression assertion built on
// that shape passed while the production path — a name-only anchor — matched
// nothing and left the anchor standing. These use the real row shape.
describe('resolveWeekCatalog — anchors linked by NAME (real row shape)', () => {
  const nameAnchor = { id: 'anch-name', name: 'Swim', is_all_groups: true, group_ids: null }

  it('suppresses a name-linked anchor when its activity is closed for the week', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors: [nameAnchor], weekId: WEEK,
      activityExclusions: [{ week_id: WEEK, activity_id: 'act-swim' }],
      groupExclusions: [], locationExclusions: [],
    })
    expect(result.anchors).toHaveLength(0)
    expect(result.suppressedAnchors).toEqual([{ anchor: nameAnchor, reason: 'activity-excluded' }])
  })

  it('suppresses a name-linked anchor when its activity’s location is closed for the week', () => {
    const result = resolveWeekCatalog({
      groups, activities, anchors: [nameAnchor], weekId: WEEK,
      activityExclusions: [], groupExclusions: [],
      locationExclusions: [{ week_id: WEEK, location_id: 'loc-pool' }],
    })
    expect(result.anchors).toHaveLength(0)
    expect(result.suppressedAnchors).toEqual([{ anchor: nameAnchor, reason: 'location-excluded' }])
  })

  it('keeps an anchor whose name is an event, not an activity, when an unrelated activity closes', () => {
    const mifkad = { id: 'anch-mifkad', name: 'Mifkad', is_all_groups: true, group_ids: null }
    const result = resolveWeekCatalog({
      groups, activities, anchors: [mifkad], weekId: WEEK,
      activityExclusions: [{ week_id: WEEK, activity_id: 'act-swim' }],
      groupExclusions: [], locationExclusions: [],
    })
    expect(result.anchors).toEqual([mifkad])
    expect(result.suppressedAnchors).toEqual([])
  })
})

// ── T180: division-scoped anchors ────────────────────────────────────────────
//
// A recurring event scoped by unit_ids carries an EMPTY group_ids — its groups
// are resolved from the divisions at build time. Week exclusion has to resolve
// them the same way, or such an event can never be suppressed.

describe('resolveWeekCatalog — unit_ids (division) scope', () => {
  const tieredGroups = [
    { id: 'grp-1', name: 'Bunk 1', tier_id: 't1' },
    { id: 'grp-2', name: 'Bunk 2', tier_id: 't1' },
    { id: 'grp-3', name: 'Bunk 3', tier_id: 't2' },
  ]
  // Real row shape post-#443: an anchor NAMES its activity, it has no
  // activity_id column. So this fixture is both name-linked (T62's axis) and
  // division-scoped (T180's axis) — which is the shape that actually exists
  // once both land, and the one worth pinning.
  const divisionAnchor = {
    id: 'anch-div', name: 'Swim', is_all_groups: false,
    group_ids: [], unit_ids: ['t1'],
  }

  it('suppresses a division-scoped anchor when every group in that division is excluded', () => {
    const result = resolveWeekCatalog({
      groups: tieredGroups, activities, anchors: [divisionAnchor], weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [{ week_id: WEEK, group_id: 'grp-1' }, { week_id: WEEK, group_id: 'grp-2' }],
    })
    expect(result.suppressedAnchors).toHaveLength(1)
    expect(result.suppressedAnchors[0].reason).toBe('all-groups-excluded')
  })

  it('keeps it when only SOME of the division is excluded', () => {
    const result = resolveWeekCatalog({
      groups: tieredGroups, activities, anchors: [divisionAnchor], weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [{ week_id: WEEK, group_id: 'grp-1' }],
    })
    expect(result.suppressedAnchors).toEqual([])
    expect(result.anchors.map((a) => a.id)).toContain('anch-div')
  })

  it('keeps it when a group OUTSIDE the division is excluded', () => {
    const result = resolveWeekCatalog({
      groups: tieredGroups, activities, anchors: [divisionAnchor], weekId: WEEK,
      activityExclusions: [],
      groupExclusions: [{ week_id: WEEK, group_id: 'grp-3' }],
    })
    expect(result.suppressedAnchors).toEqual([])
  })
})
