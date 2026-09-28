import { describe, it, expect } from 'vitest'
import { resolveAnchorActivityIds } from './anchorActivityLink.js'

// T267 PR2: resolution is by `fixed_events.activity_id` ONLY. The name-
// matching fallback (and anchorNameKey/indexActivitiesByName, which existed
// only to support it) is deleted — a fixed event whose name happens to match
// a catalog activity must NOT resolve unless it carries a real link.
describe('anchorActivityLink', () => {
  it('resolves to the linked activity id', () => {
    expect(resolveAnchorActivityIds({ id: 'anc', activity_id: 'a-lunch' })).toEqual(['a-lunch'])
  })

  it('resolves an anchor with no activity_id to nothing, not a name guess', () => {
    expect(resolveAnchorActivityIds({ name: 'Lunch' })).toEqual([])
    expect(resolveAnchorActivityIds({})).toEqual([])
    expect(resolveAnchorActivityIds(null)).toEqual([])
  })

  it('does NOT fall back to a name match even when a same-named activity exists', () => {
    // The deleted fallback used to resolve this to ['a-lunch']; it must not now.
    expect(resolveAnchorActivityIds({ name: 'Lunch', activity_id: null })).toEqual([])
  })

  it('does not require an activitiesByName argument (signature is single-arg)', () => {
    expect(resolveAnchorActivityIds.length).toBe(1)
  })
})
