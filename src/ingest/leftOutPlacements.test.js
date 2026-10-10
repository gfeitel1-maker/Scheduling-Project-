import { describe, it, expect } from 'vitest'
import { leftOutPlacements } from './leftOutPlacements.js'

const item = (activityName, dayName, blockText, groupName, reason = 'activity') => ({ activityName, dayName, blockText, groupName, reason })

describe('leftOutPlacements', () => {
  it('is null when nothing was left out', () => {
    expect(leftOutPlacements({ created: true, unresolvedItems: [] })).toBeNull()
    expect(leftOutPlacements({ created: true })).toBeNull()
  })

  it('groups by name, then day and time, listing groups, with an add action', () => {
    const r = leftOutPlacements({
      created: true,
      unresolvedItems: [
        item('Kayak', 'Tuesday', '9:00–9:45 AM', 'Bunk 2'),
        item('Kayak', 'Monday', '9:00–9:45 AM', 'Bunk 1'),
        item('Kayak', 'Monday', '9:00–9:45 AM', 'Bunk 2'),
      ],
    })
    expect(r.count).toBe(3)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].spots).toEqual(['Monday 9:00–9:45 AM: Bunk 1 and Bunk 2', 'Tuesday 9:00–9:45 AM: Bunk 2'])
    expect(r.entries[0].action).toEqual({ kind: 'addActivity', label: 'Add “Kayak” as an activity' })
  })

  it('caps names and spots with and-N-more', () => {
    const items = []
    for (let n = 0; n < 7; n++) items.push(item(`Act${n}`, 'Monday', '9:00 AM', 'G'))
    for (let d = 0; d < 6; d++) items.push(item('Act0', `D${d}`, '9:00 AM', 'G'))
    const r = leftOutPlacements({ created: true, unresolvedItems: items })
    expect(r.entries).toHaveLength(5)
    expect(r.moreNames).toBe(2)
    expect(r.entries[0].spots).toHaveLength(4)
    expect(r.entries[0].moreSpots).toBe(3)
  })

  it('offers the setup screen, not an add, when a group or time block is what is missing', () => {
    const r = leftOutPlacements({ created: true, unresolvedItems: [item('Swim', 'Monday', '9:00 AM', 'Ghost', 'group'), item('Swim', 'Monday', 'Odd', 'G', 'block')] })
    expect(r.entries[0].action).toBeNull()
    expect(r.setupActions.map((a) => a.screen)).toEqual(['groups', 'timeblocks'])
  })

  it('says nothing was saved when no version exists', () => {
    expect(leftOutPlacements({ created: false, unresolvedItems: [item('A', 'Monday', 'x', 'G')] }).headline).toMatch(/wasn't saved/)
  })
})
