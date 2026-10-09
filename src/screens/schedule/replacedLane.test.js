import { describe, it, expect } from 'vitest'
import { buildReplacements, replacedLaneRows, replacedLaneNotes, replacedCellLabel } from './replacedLane'

const days = [{ id: 'd1', label: 'Mon' }, { id: 'd2', label: 'Tue' }]
const specialDays = [{ id: 'sd1', name: 'Color War', notes: '  Bring white shirts \n' }, { id: 'sd2', name: 'Visiting Day', notes: null }]
const specialBlocks = [
  { id: 'x2', special_day_id: 'sd1', name: 'Games', sort_order: 2, start_time: '10:00:00', end_time: '11:30:00' },
  { id: 'x1', special_day_id: 'sd1', name: 'Opening', sort_order: 1, start_time: '09:00:00', end_time: '09:30:00' },
  { id: 'y1', special_day_id: 'sd2', name: 'Arrive', sort_order: 1, start_time: '12:00:00', end_time: '13:00:00' },
]
const specialSlots = [
  { id: 'c1', special_day_id: 'sd1', group_id: 'g1', time_block_id: 'x1', activity_id: 'a1' },
  { id: 'c2', special_day_id: 'sd1', group_id: 'g2', time_block_id: 'x2', activity_id: 'a1' },
  { id: 'c3', special_day_id: 'sd1', group_id: 'g1', time_block_id: 'x2', activity_id: 'gone', label: 'Tug of war' },
]
const actMap = new Map([['a1', { id: 'a1', name: 'Swim' }]])

function build(placements, conflicts = []) {
  return buildReplacements({ days, weekId: 'w1', placements, specialDays, specialBlocks, specialSlots, conflicts })
}

describe('buildReplacements', () => {
  it('maps each bound day to its special day, blocks in the special day order', () => {
    const map = build([{ id: 'p1', week_id: 'w1', day_id: 'd2', special_day_id: 'sd1' }])
    expect([...map.keys()]).toEqual(['d2'])
    const r = map.get('d2')
    expect(r).toMatchObject({ dayId: 'd2', specialDayId: 'sd1', name: 'Color War', conflictTitle: null })
    expect(r.blocks.map(b => b.id)).toEqual(['x1', 'x2'])
  })

  it('replaces nothing for an orphan: other week, unknown day, deleted special day', () => {
    const map = build([
      { id: 'p1', week_id: 'w2', day_id: 'd1', special_day_id: 'sd1' },
      { id: 'p2', week_id: 'w1', day_id: 'dX', special_day_id: 'sd1' },
      { id: 'p3', week_id: 'w1', day_id: 'd1', special_day_id: 'gone' },
    ])
    expect(map.size).toBe(0)
  })

  it('marks a binding with an unresolved conflict, titled with both special days', () => {
    const map = build(
      [{ id: 'p1', week_id: 'w1', day_id: 'd1', special_day_id: 'sd1' }],
      [{ entity: 'special_day_placements', entity_id: 'p1', field: 'special_day_id', existingOp: { value: 'sd1' }, incomingOp: { value: 'sd2' } }],
    )
    expect(map.get('d1').conflictTitle).toBe('Color War or Visiting Day')
  })
})

describe('replacedLaneRows', () => {
  const replacement = () => build([{ id: 'p1', week_id: 'w1', day_id: 'd2', special_day_id: 'sd1' }]).get('d2')

  it('one row per special block, in order, labelled for this group', () => {
    expect(replacedLaneRows({ replacement: replacement(), groupId: 'g2', actMap })).toEqual([
      { blockId: 'x1', blockName: 'Opening', time: '09:00-09:30', label: '', activityId: null },
      { blockId: 'x2', blockName: 'Games', time: '10:00-11:30', label: 'Swim', activityId: 'a1' },
    ])
  })

  it('a camp activity carries its id (identity dot); free text carries none', () => {
    const rows = replacedLaneRows({ replacement: replacement(), groupId: 'g1', actMap })
    expect(rows.map(r => [r.label, r.activityId])).toEqual([['Swim', 'a1'], ['Tug of war', null]])
  })

  it('replacedCellLabel answers one (group, block) cell', () => {
    expect(replacedCellLabel({ replacement: replacement(), groupId: 'g2', blockId: 'x2', actMap })).toEqual({ label: 'Swim', activityId: 'a1' })
    expect(replacedCellLabel({ replacement: replacement(), groupId: 'g2', blockId: 'x1', actMap })).toEqual({ label: '', activityId: null })
  })

  it('a special day with no blocks has no rows', () => {
    const r = build([{ id: 'p1', week_id: 'w1', day_id: 'd1', special_day_id: 'sd2' }]).get('d1')
    expect(replacedLaneRows({ replacement: { ...r, blocks: [] }, groupId: 'g1', actMap })).toEqual([])
  })
})

describe('replacedLaneNotes', () => {
  it('trims, and is empty for no notes', () => {
    const map = build([
      { id: 'p1', week_id: 'w1', day_id: 'd1', special_day_id: 'sd1' },
      { id: 'p2', week_id: 'w1', day_id: 'd2', special_day_id: 'sd2' },
    ])
    expect(replacedLaneNotes(map.get('d1'))).toBe('Bring white shirts')
    expect(replacedLaneNotes(map.get('d2'))).toBe('')
  })
})
