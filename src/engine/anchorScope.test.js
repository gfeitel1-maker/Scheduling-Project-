import { describe, it, expect } from 'vitest'
import { resolveAnchorDayIds } from './anchorScope.js'

// resolveAnchorDayIds was extracted during the Q5 review: the "null day_id
// means EVERY day" rule had just become duplicated (Pass 1's anchorLookup and
// the day-keyed exclusion Map), which is the same shape that produced the
// weekCatalog/engine scope divergence a day earlier. These pin the rule so the
// two callers cannot drift apart again.
//
// resolveAnchorGroupIds (T180) is exercised through buildSchedule's own suite
// and is deliberately not re-tested here.
describe('resolveAnchorDayIds', () => {
  const days = [
    { id: 'd1', label: 'Monday' },
    { id: 'd2', label: 'Tuesday' },
    { id: 'd3', label: 'Wednesday' },
  ]

  it('returns just the pinned day when day_id is set', () => {
    expect(resolveAnchorDayIds({ day_id: 'd2' }, days)).toEqual(['d2'])
  })

  it('treats a null day_id as EVERY day, never as no days', () => {
    expect(resolveAnchorDayIds({ day_id: null }, days)).toEqual(['d1', 'd2', 'd3'])
  })

  it('treats an absent day_id as every day', () => {
    expect(resolveAnchorDayIds({}, days)).toEqual(['d1', 'd2', 'd3'])
  })

  it('treats an EMPTY STRING day_id as every day — the shape a cleared form field leaves', () => {
    expect(resolveAnchorDayIds({ day_id: '' }, days)).toEqual(['d1', 'd2', 'd3'])
  })

  it('returns the pinned day even if that day is no longer in the live list', () => {
    // Deliberate: this resolves the anchor's CLAIM. Filtering a deleted day is
    // the caller's business — the placement loop simply never visits it — and
    // silently dropping it here would make a stale anchor look like an
    // all-days anchor, which is the more dangerous failure.
    expect(resolveAnchorDayIds({ day_id: 'gone' }, days)).toEqual(['gone'])
  })

  it('returns an empty list when there are no days to resolve against', () => {
    expect(resolveAnchorDayIds({ day_id: null }, [])).toEqual([])
    expect(resolveAnchorDayIds({ day_id: null }, undefined)).toEqual([])
  })

  it('tolerates a null anchor rather than throwing inside a pure engine', () => {
    expect(resolveAnchorDayIds(null, days)).toEqual(['d1', 'd2', 'd3'])
  })
})
