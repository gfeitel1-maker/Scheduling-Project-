import { describe, it, expect } from 'vitest'
import { resolveImportedPlacements, describeUnresolved } from './resolveImportedPlacements.js'
import { normalizeName } from '../../src/ingest/preview.js'

function maps({ groups = [], days = [], blocks = [], activities = [], anchors = [], electiveSets = [] } = {}) {
  return {
    electiveSetIdByName: new Map(electiveSets.map(([n, id]) => [normalizeName(n), id])),
    groupIdByName: new Map(groups.map(([n, id]) => [normalizeName(n), id])),
    dayIdByName: new Map(days.map(([n, id]) => [normalizeName(n), id])),
    blockIdByName: new Map(blocks.map(([n, id]) => [normalizeName(n), id])),
    activityIdByName: new Map(activities.map(([n, id]) => [normalizeName(n), id])),
    fixedEventIdByName: new Map(anchors.map(([n, id]) => [normalizeName(n), id])),
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
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', fixed_event_id: null, is_fixed_event: false, flags: {} },
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, fixed_event_id: 'anc1', is_fixed_event: true, flags: {} },
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
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-lunch', fixed_event_id: 'anc-lunch', is_fixed_event: true, flags: {} },
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

  it('a list cell the camp holds as an elective set resolves to that set, in any printed order', () => {
    const m = maps({ groups: [['Hawks', 'g1']], days: [['Monday', 'd1']], blocks: [['10:00-10:45', 'b1']], electiveSets: [['Electives (Fishing, Hiking, Kayaking)', 'es1']] })
    const { slots, unresolved } = resolveImportedPlacements([{ groupName: 'Hawks', dayName: 'Monday', blockLabel: '10:00-10:45', activityName: 'Kayaking / Hiking / Fishing' }], m)
    expect(unresolved).toEqual([])
    expect(slots).toMatchObject([{ elective_set_id: 'es1', activity_id: null }])
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

  describe('elective cells', () => {
    const cell = { groupName: 'Hawks', dayName: 'Tuesday', blockLabel: '14:00', electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] }
    const base = { groups: [['Hawks', 'g1']], days: [['Tuesday', 'd2']], blocks: [['14:00', 'b3']] }

    it('resolves an elective cell to a slot carrying elective_set_id and no activity or fixed event', () => {
      const { slots, unresolved } = resolveImportedPlacements([cell], maps({ ...base, electiveSets: [['chugim', 'es1']] }))
      expect(unresolved).toEqual([])
      expect(slots).toEqual([
        { group_id: 'g1', day_id: 'd2', time_block_id: 'b3', elective_set_id: 'es1', activity_id: null, fixed_event_id: null, is_fixed_event: false, flags: {} },
      ])
    })

    it('an elective set that does not exist goes to unresolved with reason elective_set, and the notice names the set, never "undefined"', () => {
      const { slots, unresolved } = resolveImportedPlacements([cell], maps(base))
      expect(slots).toEqual([])
      expect(unresolved).toEqual([{ ...cell, reason: 'elective_set' }])
      const [item] = describeUnresolved(unresolved, [])
      expect(item.activityName).toBe('Chugim')
      expect(item.reason).toBe('elective_set')
      const { activityName: _omit, ...bare } = cell
      expect(describeUnresolved([{ ...bare, reason: 'elective_set' }], [])[0].activityName).toBe('Chugim')
    })
  })
})

// T219: an elective printed in adjacent blocks of one day for one group is ONE
// session spanning those blocks (head + tails), the way an activity span is.
describe('resolveImportedPlacements — spanning electives (T219)', () => {
  const m = () => ({
    ...maps({
      groups: [['Bunk 1', 'g1'], ['Bunk 2', 'g2']],
      days: [['Monday', 'd1']],
      blocks: [['9:00', 'b1'], ['10:00', 'b2'], ['11:00', 'b3'], ['12:00', 'b4']],
      electiveSets: [['Chugim', 'set1']],
    }),
    blockOrder: new Map([['b1', 0], ['b2', 1], ['b3', 2], ['b4', 3]]),
  })
  const at = (groupName, blockLabel) => ({ groupName, dayName: 'Monday', blockLabel, activityName: 'Chugim', electiveSetName: 'Chugim' })
  const heads = (slots) => slots.map((s) => [s.group_id, s.time_block_id, s.is_span_head])

  it('marks adjacent blocks of one set as head then tails', () => {
    const { slots } = resolveImportedPlacements([at('Bunk 1', '10:00'), at('Bunk 1', '9:00'), at('Bunk 1', '11:00')], m())
    expect(heads(slots).sort()).toEqual([['g1', 'b1', true], ['g1', 'b2', false], ['g1', 'b3', false]])
  })

  it('a gap starts a new session; other groups and single blocks are untouched', () => {
    const { slots } = resolveImportedPlacements([at('Bunk 1', '9:00'), at('Bunk 1', '11:00'), at('Bunk 1', '12:00'), at('Bunk 2', '9:00')], m())
    expect(heads(slots).sort()).toEqual([['g1', 'b1', undefined], ['g1', 'b3', true], ['g1', 'b4', false], ['g2', 'b1', undefined]])
  })
})
