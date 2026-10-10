import { describe, it, expect } from 'vitest'
import { remapSnapshotSlots } from './snapshotRemap'

const catalog = {
  groups: [{ id: 'g', name: 'Bunk 1' }],
  days: [{ id: 'd', label: 'Monday' }],
  timeBlocks: [{ id: 'b', name: '09:00', start_time: '09:00', end_time: '10:00' }],
  activities: [{ id: 'a-new', name: 'Music' }],
  fixedEvents: [{ id: 'fe-new', name: 'Music' }],
}
const names = { group: 'Bunk 1', day: 'Monday', block: '09:00', block_start: '09:00', block_end: '10:00' }

describe('remapSnapshotSlots — recurring-event cells that carry an activity link', () => {
  it('re-binds the dead activity link by name and keeps the cell', () => {
    const cell = { group_id: 'x', day_id: 'x', time_block_id: 'x', is_fixed_event: true, fixed_event_id: 'x', activity_id: 'a-old', names: { ...names, fixed_event: 'Music', activity: 'Music' } }
    const { slots, skipped } = remapSnapshotSlots([cell], catalog)
    expect(skipped).toEqual([])
    expect(slots[0].activity_id).toBe('a-new')
    expect(slots[0].fixed_event_id).toBe('fe-new')
  })

  it('drops an unmatched link to null instead of skipping the cell', () => {
    const cell = { group_id: 'x', day_id: 'x', time_block_id: 'x', is_fixed_event: true, fixed_event_id: 'x', activity_id: 'a-old', names: { ...names, fixed_event: 'Music', activity: 'Gone' } }
    const { slots, skipped } = remapSnapshotSlots([cell], catalog)
    expect(skipped).toEqual([])
    expect(slots[0].activity_id).toBeNull()
  })
})
