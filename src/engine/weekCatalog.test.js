import { describe, it, expect } from 'vitest'
import { resolveWeekCatalog } from './weekCatalog.js'

const WEEK = 'week-1'

const activities = [
  { id: 'act-swim', name: 'Swim' },
  { id: 'act-art', name: 'Art' },
  { id: 'act-soccer', name: 'Soccer' },
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
})
