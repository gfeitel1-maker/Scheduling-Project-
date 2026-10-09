import { describe, it, expect } from 'vitest'
import { slotIdsForFinding, highlightMapForKind, inViewLabel, railEmptyText } from './findingHighlight'

// docs/work/specs/2026-08-01-generated-flag-review.md — the derivation Code
// Reviewer singled out as the one genuinely new, easy-to-get-wrong piece of
// logic in the flag-review feature. Every case here is a way it could pick up
// the wrong cell.

const slot = (over) => ({
  id: over.id,
  group_id: 'g1',
  activity_id: 'a1',
  is_fixed_event: false,
  ...over,
})

describe('slotIdsForFinding', () => {
  const finding = { groupId: 'g1', activityId: 'a1', kind: 'DISTRIBUTION' }

  it('matches placed cells of the same group and activity', () => {
    const slots = [slot({ id: 's1' }), slot({ id: 's2' })]
    expect(slotIdsForFinding(finding, slots)).toEqual(['s1', 's2'])
  })

  it("ignores another group's cells", () => {
    const slots = [slot({ id: 's1' }), slot({ id: 's2', group_id: 'g2' })]
    expect(slotIdsForFinding(finding, slots)).toEqual(['s1'])
  })

  it('ignores another activity in the same group', () => {
    const slots = [slot({ id: 's1' }), slot({ id: 's2', activity_id: 'a2' })]
    expect(slotIdsForFinding(finding, slots)).toEqual(['s1'])
  })

  it('never matches an anchor, even if group and activity line up', () => {
    const slots = [slot({ id: 's1', is_fixed_event: true })]
    expect(slotIdsForFinding(finding, slots)).toEqual([])
  })

  it('never matches an empty cell (no activity placed)', () => {
    const slots = [slot({ id: 's1', activity_id: null }), slot({ id: 's2', activity_id: '' })]
    expect(slotIdsForFinding(finding, slots)).toEqual([])
  })

  it('returns [] for the absence case — the activity is not on the week yet', () => {
    // UNDERSERVED is precisely this: the concern exists BECAUSE there are no
    // (or too few) placements. An empty result is the honest answer, not a bug.
    const slots = [slot({ id: 's1', activity_id: 'other' })]
    expect(slotIdsForFinding({ groupId: 'g1', activityId: 'missing', kind: 'UNDERSERVED' }, slots)).toEqual([])
  })

  it('is safe on a missing finding or missing slots', () => {
    expect(slotIdsForFinding(null, [slot({ id: 's1' })])).toEqual([])
    expect(slotIdsForFinding(finding, null)).toEqual([])
    expect(slotIdsForFinding(undefined, undefined)).toEqual([])
  })
})

describe('highlightMapForKind', () => {
  const rows = [
    { key: 'u1', kind: 'UNFILLABLE', reason: 'nothing fits', slotIds: ['s9'] },
    { key: 'd1', kind: 'DISTRIBUTION', reason: 'bunched up', groupId: 'g1', activityId: 'a1' },
    { key: 'n1', kind: 'UNDERSERVED', reason: 'needs more', groupId: 'g1', activityId: 'a2' },
  ]
  const slots = [
    slot({ id: 's1', activity_id: 'a1' }),
    slot({ id: 's2', activity_id: 'a1' }),
    slot({ id: 's3', activity_id: 'a2' }),
  ]

  it('uses a row\'s own slotIds when it carries them (UNFILLABLE)', () => {
    const map = highlightMapForKind('UNFILLABLE', rows, slots)
    expect([...map.keys()]).toEqual(['s9'])
    expect(map.get('s9')).toBe('nothing fits')
  })

  it('derives slotIds for aggregate findings and carries their reason', () => {
    const map = highlightMapForKind('DISTRIBUTION', rows, slots)
    expect([...map.keys()].sort()).toEqual(['s1', 's2'])
    expect(map.get('s1')).toBe('bunched up')
  })

  it('only includes the kind asked for', () => {
    const map = highlightMapForKind('UNDERSERVED', rows, slots)
    expect([...map.keys()]).toEqual(['s3'])
  })

  it('returns an empty map for no kind or no rows', () => {
    expect(highlightMapForKind(null, rows, slots).size).toBe(0)
    expect(highlightMapForKind('DISTRIBUTION', null, slots).size).toBe(0)
  })

  it('keeps the first (more urgent) reason when two rows share a cell', () => {
    const dup = [
      { kind: 'DISTRIBUTION', reason: 'first', groupId: 'g1', activityId: 'a1' },
      { kind: 'DISTRIBUTION', reason: 'second', groupId: 'g1', activityId: 'a1' },
    ]
    const map = highlightMapForKind('DISTRIBUTION', dup, slots)
    expect(map.get('s1')).toBe('first')
  })
})

// Packaged-app audit #21: the list is already open while a concern is lit, so
// the note is a bare count, never "open the list".
describe('inViewLabel', () => {
  it('is a bare in-view count when some are off view', () => {
    expect(inViewLabel(2, 6)).toBe('2 of 6 in view')
    expect(inViewLabel(0, 6)).toBe('0 of 6 in view')
  })
  it('says nothing when all are in view or there are none', () => {
    expect(inViewLabel(6, 6)).toBeNull()
    expect(inViewLabel(0, 0)).toBeNull()
  })
})

// Packaged-app audit #23: the empty needs list agrees with the Placed badge.
describe('railEmptyText', () => {
  it('reports open cells while any remain', () => {
    expect(railEmptyText({ filled: 0, open: 80 })).toBe('80 open')
  })
  it('says everything is placed only when it is', () => {
    expect(railEmptyText({ filled: 80, open: 80 })).toBe('Everything on your list is placed.')
  })
})
