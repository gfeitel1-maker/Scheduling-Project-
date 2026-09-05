import { describe, it, expect } from 'vitest'
import { groupDuplicateLocations, duplicateSiblingsById } from './locationDuplicates.js'

describe('groupDuplicateLocations', () => {
  it('groups locations whose names normalize alike ("Gym" / "gym")', () => {
    const locations = [
      { id: 'a', name: 'Gym' },
      { id: 'b', name: 'gym' },
      { id: 'c', name: 'Pool' },
    ]
    const groups = groupDuplicateLocations(locations)
    expect(groups.size).toBe(1)
    const [rows] = [...groups.values()]
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('does not group genuinely distinct names', () => {
    const locations = [
      { id: 'a', name: 'Gym' },
      { id: 'b', name: 'Gym Hall' },
    ]
    expect(groupDuplicateLocations(locations).size).toBe(0)
  })

  it('trim-only differences ("Gym" / "Gym ") still group, matching normalizeWordKey', () => {
    const locations = [
      { id: 'a', name: 'Gym' },
      { id: 'b', name: 'Gym  ' },
    ]
    expect(groupDuplicateLocations(locations).size).toBe(1)
  })
})

describe('duplicateSiblingsById', () => {
  it('maps each duplicate row to its siblings, and non-duplicates to nothing', () => {
    const locations = [
      { id: 'a', name: 'Gym' },
      { id: 'b', name: 'gym' },
      { id: 'c', name: 'Pool' },
    ]
    const map = duplicateSiblingsById(locations)
    expect(map.get('a').map((r) => r.id)).toEqual(['b'])
    expect(map.get('b').map((r) => r.id)).toEqual(['a'])
    expect(map.has('c')).toBe(false)
  })
})
