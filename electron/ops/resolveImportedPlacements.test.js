import { describe, it, expect } from 'vitest'
import { resolveImportedPlacements } from './resolveImportedPlacements.js'
import { normalizeName } from '../../src/ingest/preview.js'

function maps({ groups = [], days = [], blocks = [], activities = [], anchors = [] } = {}) {
  return {
    groupIdByName: new Map(groups.map(([n, id]) => [normalizeName(n), id])),
    dayIdByName: new Map(days.map(([n, id]) => [normalizeName(n), id])),
    blockIdByName: new Map(blocks.map(([n, id]) => [normalizeName(n), id])),
    activityIdByName: new Map(activities.map(([n, id]) => [normalizeName(n), id])),
    anchorIdByName: new Map(anchors.map(([n, id]) => [normalizeName(n), id])),
  }
}

describe('resolveImportedPlacements', () => {
  it('resolves a mix of activity and anchor placements, happy path', () => {
    const m = maps({
      groups: [['Bunk 1', 'g1']],
      days: [['Monday', 'd1']],
      blocks: [['09:00', 'b1']],
      activities: [['Swim', 'a1']],
      anchors: [['Lunch', 'anc1']],
    })
    const placements = [
      { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' },
      { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Lunch' },
    ]
    const { slots, unresolved } = resolveImportedPlacements(placements, m)
    expect(unresolved).toEqual([])
    expect(slots).toEqual([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', anchor_id: null, is_anchor: false, flags: {} },
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: 'anc1', is_anchor: true, flags: {} },
    ])
  })

  it('anchor wins when an activity name collides with an anchor name', () => {
    const m = maps({
      groups: [['Bunk 1', 'g1']],
      days: [['Monday', 'd1']],
      blocks: [['09:00', 'b1']],
      activities: [['Lunch', 'act-lunch']],
      anchors: [['Lunch', 'anc-lunch']],
    })
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Lunch' }]
    const { slots } = resolveImportedPlacements(placements, m)
    expect(slots).toEqual([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: 'anc-lunch', is_anchor: true, flags: {} },
    ])
  })

  it('unresolved activity name lands in unresolved with reason "activity"', () => {
    const m = maps({
      groups: [['Bunk 1', 'g1']],
      days: [['Monday', 'd1']],
      blocks: [['09:00', 'b1']],
    })
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Mystery' }]
    const { slots, unresolved } = resolveImportedPlacements(placements, m)
    expect(slots).toEqual([])
    expect(unresolved).toEqual([
      { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Mystery', reason: 'activity' },
    ])
  })

  it('unresolved group/day/block lands with the reason matching which axis missed', () => {
    const m = maps({
      groups: [['Bunk 1', 'g1']],
      days: [['Monday', 'd1']],
      blocks: [['09:00', 'b1']],
      activities: [['Swim', 'a1']],
    })
    const placements = [
      { groupName: 'Ghost Bunk', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' },
      { groupName: 'Bunk 1', dayName: 'Ghost Day', blockLabel: '09:00', activityName: 'Swim' },
      { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: 'Ghost Block', activityName: 'Swim' },
    ]
    const { slots, unresolved } = resolveImportedPlacements(placements, m)
    expect(slots).toEqual([])
    expect(unresolved.map((u) => u.reason)).toEqual(['group', 'day', 'block'])
  })

  it('returns empty slots and unresolved for empty placements', () => {
    const m = maps()
    expect(resolveImportedPlacements([], m)).toEqual({ slots: [], unresolved: [] })
  })

  it('flags is always {} on every resolved slot', () => {
    const m = maps({
      groups: [['Bunk 1', 'g1']],
      days: [['Monday', 'd1']],
      blocks: [['09:00', 'b1']],
      activities: [['Swim', 'a1']],
    })
    const { slots } = resolveImportedPlacements(
      [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }],
      m
    )
    expect(slots[0].flags).toEqual({})
  })
})
