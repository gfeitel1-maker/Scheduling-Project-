import { describe, it, expect } from 'vitest'
import { remapSnapshotSlots } from './snapshotRemap'
import { dropDeadReferences } from '../screens/schedule/useSnapshots.js'
import { resolveImportedPlacements } from '../../electron/ops/resolveImportedPlacements.js'

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

describe('restoring an imported version with an elective cell (F6 change 4)', () => {
  it('binds the id-only slot (no names block) to the live elective set and keeps it through the restore pipeline', () => {
    const electiveSets = [{ id: 'es-live', name: 'Chugim' }]
    const { slots: imported } = resolveImportedPlacements(
      [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] }],
      {
        groupIdByName: new Map([['bunk 1', 'g']]), dayIdByName: new Map([['monday', 'd']]), blockIdByName: new Map([['09:00', 'b']]),
        activityIdByName: new Map(), fixedEventIdByName: new Map(), electiveSetIdByName: new Map([['chugim', 'es-live']]),
      },
    )
    expect(imported[0].names).toBeUndefined()
    const saved = JSON.parse(JSON.stringify(imported))
    const { slots, skipped } = remapSnapshotSlots(saved, { ...catalog, electiveSets })
    const surviving = dropDeadReferences(slots, { ...catalog, electiveSets })
    expect(skipped).toEqual([])
    expect(surviving).toHaveLength(1)
    expect(surviving[0]).toMatchObject({ group_id: 'g', day_id: 'd', time_block_id: 'b', elective_set_id: 'es-live', activity_id: null, fixed_event_id: null })
  })
})
