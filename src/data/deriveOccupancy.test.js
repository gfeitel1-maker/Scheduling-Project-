import { describe, it, expect } from 'vitest'
import { deriveOccupancy } from './deriveOccupancy'

const templates = [
  { id: 'tpl-gen', week_id: 'w1', kind: 'generated' },
  { id: 'tpl-man', week_id: 'w1', kind: 'manual' },
]

const activities = [
  { id: 'act-swim', name: 'Swim', location_id: 'loc-pool' },
  { id: 'act-art', name: 'Art', location_id: null },
]

const locations = [
  { id: 'loc-pool', name: 'Pool', capacity: 1 },
]

describe('deriveOccupancy', () => {
  it('places a group at its activity location', () => {
    const slots = [
      { template_id: 'tpl-gen', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-swim', group_id: 'g1' },
    ]
    const result = deriveOccupancy({ weekId: 'w1', kind: 'generated', dayId: 'd1', blockId: 'b1', templates, slots, activities, locations })
    expect(result.located).toHaveLength(1)
    expect(result.located[0].locationId).toBe('loc-pool')
    expect(result.located[0].groups.map((g) => g.groupId)).toEqual(['g1'])
    expect(result.unlocated).toEqual([])
  })

  it('flags a jam when occupants exceed capacity', () => {
    const slots = [
      { template_id: 'tpl-gen', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-swim', group_id: 'g1' },
      { template_id: 'tpl-gen', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-swim', group_id: 'g2' },
    ]
    const result = deriveOccupancy({ weekId: 'w1', kind: 'generated', dayId: 'd1', blockId: 'b1', templates, slots, activities, locations })
    expect(result.located).toHaveLength(1)
    expect(result.located[0].isJam).toBe(true)
    expect(result.located[0].groups).toHaveLength(2)
  })

  it('puts a group whose activity has no location in unlocated', () => {
    const slots = [
      { template_id: 'tpl-gen', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-art', group_id: 'g1' },
    ]
    const result = deriveOccupancy({ weekId: 'w1', kind: 'generated', dayId: 'd1', blockId: 'b1', templates, slots, activities, locations })
    expect(result.located).toEqual([])
    expect(result.unlocated).toEqual([{ groupId: 'g1', activityId: 'act-art', activityName: 'Art' }])
  })

  it('returns empty for a week/day/block with no slots', () => {
    const result = deriveOccupancy({ weekId: 'w1', kind: 'generated', dayId: 'd9', blockId: 'b9', templates, slots: [], activities, locations })
    expect(result.located).toEqual([])
    expect(result.unlocated).toEqual([])
    expect(result.templateFound).toBe(true)
  })

  it('reports no template found when the route has no schedule for the week', () => {
    const result = deriveOccupancy({ weekId: 'w1', kind: 'generated', dayId: 'd1', blockId: 'b1', templates: [], slots: [], activities, locations })
    expect(result.templateFound).toBe(false)
  })

  it('selects the manual template when route is manual, not the generated one', () => {
    const slots = [
      { template_id: 'tpl-man', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-swim', group_id: 'g1' },
      { template_id: 'tpl-gen', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-swim', group_id: 'g2' },
    ]
    const result = deriveOccupancy({ weekId: 'w1', kind: 'manual', dayId: 'd1', blockId: 'b1', templates, slots, activities, locations })
    expect(result.located).toHaveLength(1)
    expect(result.located[0].groups.map((g) => g.groupId)).toEqual(['g1'])
  })
})
