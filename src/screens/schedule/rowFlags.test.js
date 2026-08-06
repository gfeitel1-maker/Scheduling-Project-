import { describe, it, expect } from 'vitest'
import { rowFlagKind } from './rowFlags'

// A stand-in for makeGridGeometry's read surface: rowFlagKind only ever calls
// getSlot, and pinning the precedence rule needs no engine.
function geometryOf(slots) {
  return {
    getSlot: (groupId, dayId, blockId) =>
      slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId),
  }
}

const acrossDays = [{ groupId: 'g1', dayId: 'd1' }, { groupId: 'g1', dayId: 'd2' }]
const acrossGroups = [{ groupId: 'g1', dayId: 'd1' }, { groupId: 'g2', dayId: 'd1' }]

describe('rowFlagKind', () => {
  it('returns null when nothing in the row is flagged', () => {
    const g = geometryOf([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', flags: {} }])
    expect(rowFlagKind(g, acrossDays, 'b1')).toBeNull()
  })

  it('reports an OVERLAP anywhere in the row as advisory', () => {
    const g = geometryOf([{ group_id: 'g1', day_id: 'd2', time_block_id: 'b1', flags: { OVERLAP: true } }])
    expect(rowFlagKind(g, acrossDays, 'b1')).toBe('advisory')
  })

  it('lets UNFILLABLE outrank OVERLAP — one dot, never two', () => {
    const g = geometryOf([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', flags: { OVERLAP: true } },
      { group_id: 'g1', day_id: 'd2', time_block_id: 'b1', flags: { UNFILLABLE: true } },
    ])
    expect(rowFlagKind(g, acrossDays, 'b1')).toBe('unfillable')
  })

  it('ignores a dismissed UNFILLABLE', () => {
    const g = geometryOf([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', flags: { UNFILLABLE: true, UNFILLABLE_dismissed: true } },
    ])
    expect(rowFlagKind(g, acrossDays, 'b1')).toBeNull()
  })

  it('scans whichever axis the caller passes — day view scans GROUPS', () => {
    const g = geometryOf([{ group_id: 'g2', day_id: 'd1', time_block_id: 'b1', flags: { UNFILLABLE: true } }])
    expect(rowFlagKind(g, acrossGroups, 'b1')).toBe('unfillable')
    // The same flagged slot is invisible along the other axis.
    expect(rowFlagKind(g, acrossDays, 'b1')).toBeNull()
  })
})
