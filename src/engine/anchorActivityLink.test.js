import { describe, it, expect } from 'vitest'
import { anchorNameKey, indexActivitiesByName, resolveAnchorActivityIds } from './anchorActivityLink.js'

// The link this module resolves is the one T62 assumed existed as a column and
// did not. These assertions pin the matching rule itself, so a future change to
// the recognition key is a deliberate edit and not a silent behavior shift.
describe('anchorActivityLink', () => {
  const activities = [
    { id: 'a-lunch', name: 'Lunch' },
    { id: 'a-swim', name: 'Swim' },
  ]
  const byName = indexActivitiesByName(activities)

  it('matches an anchor to its activity by name, the shape real rows have', () => {
    expect(resolveAnchorActivityIds({ id: 'anc', name: 'Lunch' }, byName)).toEqual(['a-lunch'])
  })

  it('is case- and whitespace-insensitive, like every other entity recognition in this repo', () => {
    expect(resolveAnchorActivityIds({ name: '  lunch ' }, byName)).toEqual(['a-lunch'])
    expect(resolveAnchorActivityIds({ name: 'LUNCH' }, byName)).toEqual(['a-lunch'])
  })

  it('resolves an anchor whose name is not in the catalog to nothing, not to a guess', () => {
    // Real anchor names that are events, not activities.
    expect(resolveAnchorActivityIds({ name: 'Mifkad' }, byName)).toEqual([])
    expect(resolveAnchorActivityIds({ name: 'Lunch + Leave' }, byName)).toEqual([])
    expect(resolveAnchorActivityIds({ name: '' }, byName)).toEqual([])
    expect(resolveAnchorActivityIds({}, byName)).toEqual([])
  })

  it('prefers an explicit activity_id when a caller supplies one', () => {
    expect(resolveAnchorActivityIds({ activity_id: 'a-swim', name: 'Lunch' }, byName)).toEqual(['a-swim'])
  })

  it('maps every duplicate spelling of a name, so anchoring excludes them all', () => {
    const dupes = indexActivitiesByName([{ id: 'a1', name: 'Lunch' }, { id: 'a2', name: 'lunch' }])
    expect(resolveAnchorActivityIds({ name: 'Lunch' }, dupes)).toEqual(['a1', 'a2'])
  })

  it('ignores catalog rows with no usable name rather than keying them on empty string', () => {
    const idx = indexActivitiesByName([{ id: 'a1', name: '' }, { id: 'a2', name: null }])
    expect(idx.size).toBe(0)
    expect(anchorNameKey(null)).toBe('')
  })
})
