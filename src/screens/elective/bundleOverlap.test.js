// T301 slice 2 — the authoring-time overlap warning. Two bundles of one
// activity whose EFFECTIVE divisions intersect at a SHARED cell will both be
// refused by the solver's tier 1 at generate time (buildElectiveAssignments.js
// case (c)); warning here is strictly earlier feedback for the same fact, not
// a new rule. A raw shared cell is NOT enough on its own — two bundles scoped
// to disjoint divisions sharing a cell is fine, since no camper can be
// eligible for both, and warning there would be crying wolf.
import { describe, it, expect } from 'vitest'
import { resolveScope, findBundleOverlap } from './bundleOverlap.js'

describe('resolveScope', () => {
  it("'all' resolves to every division present, regardless of the tier list", () => {
    expect(resolveScope('all', [], ['tier-jr', 'tier-sr'])).toEqual(['tier-jr', 'tier-sr'])
    expect(resolveScope('all', ['tier-jr'], ['tier-jr', 'tier-sr'])).toEqual(['tier-jr', 'tier-sr'])
  })
  it("'only' resolves to exactly the named tiers that are actually present", () => {
    expect(resolveScope('only', ['tier-jr'], ['tier-jr', 'tier-sr'])).toEqual(['tier-jr'])
    // Named but not present at this cell -> not in the result.
    expect(resolveScope('only', ['tier-mid'], ['tier-jr', 'tier-sr'])).toEqual([])
  })
  it("'except' resolves to every present division EXCEPT the named ones", () => {
    expect(resolveScope('except', ['tier-sr'], ['tier-jr', 'tier-sr'])).toEqual(['tier-jr'])
  })
})

function bundle(overrides) {
  return {
    id: 'sibling-1', name: 'Sibling', activity_id: 'act-1', scope_mode: 'all', tierIds: [],
    periods: [{ day_id: 'day-1', time_block_id: 'tb-1' }],
    ...overrides,
  }
}

describe('findBundleOverlap', () => {
  const CELL = { day_id: 'day-1', time_block_id: 'tb-1' }
  const DIVISIONS_AT_CELL = ['tier-jr', 'tier-sr']

  it('warns when two bundles of the SAME activity share a cell and both resolve to overlapping divisions', () => {
    const result = findBundleOverlap({
      activityId: 'act-1',
      cell: CELL,
      effectiveDivisions: ['tier-jr', 'tier-sr'],
      divisionsAtCell: DIVISIONS_AT_CELL,
      siblingBundles: [bundle({ scope_mode: 'all' })],
    })
    expect(result).not.toBeNull()
    expect(result.bundleName).toBe('Sibling')
    expect(result.divisionIds.sort()).toEqual(['tier-jr', 'tier-sr'])
  })

  it('does NOT warn when two bundles of the same activity share a cell but are scoped to DISJOINT divisions', () => {
    const result = findBundleOverlap({
      activityId: 'act-1',
      cell: CELL,
      effectiveDivisions: ['tier-jr'],
      divisionsAtCell: DIVISIONS_AT_CELL,
      siblingBundles: [bundle({ scope_mode: 'only', tierIds: ['tier-sr'] })],
    })
    expect(result).toBeNull()
  })

  it('does NOT warn for a bundle of a DIFFERENT activity, even sharing a cell', () => {
    const result = findBundleOverlap({
      activityId: 'act-1',
      cell: CELL,
      effectiveDivisions: ['tier-jr', 'tier-sr'],
      divisionsAtCell: DIVISIONS_AT_CELL,
      siblingBundles: [bundle({ activity_id: 'act-2' })],
    })
    expect(result).toBeNull()
  })

  it('does NOT warn for a sibling bundle that does not share this cell at all', () => {
    const result = findBundleOverlap({
      activityId: 'act-1',
      cell: CELL,
      effectiveDivisions: ['tier-jr', 'tier-sr'],
      divisionsAtCell: DIVISIONS_AT_CELL,
      siblingBundles: [bundle({ periods: [{ day_id: 'day-2', time_block_id: 'tb-1' }] })],
    })
    expect(result).toBeNull()
  })

  it("an 'except' bundle and an 'only' bundle overlap exactly on the division the except one still covers", () => {
    const result = findBundleOverlap({
      activityId: 'act-1',
      cell: CELL,
      effectiveDivisions: resolveScope('except', ['tier-sr'], DIVISIONS_AT_CELL), // -> ['tier-jr']
      divisionsAtCell: DIVISIONS_AT_CELL,
      siblingBundles: [bundle({ scope_mode: 'only', tierIds: ['tier-jr'] })],
    })
    expect(result).not.toBeNull()
    expect(result.divisionIds).toEqual(['tier-jr'])
  })

  it('ignores itself — a bundle never overlaps its own periods', () => {
    // The caller is responsible for excluding the bundle being edited from
    // siblingBundles; this proves the function does not need its own id to
    // do so (no self-filtering logic to trust or forget).
    const result = findBundleOverlap({
      activityId: 'act-1',
      cell: CELL,
      effectiveDivisions: ['tier-jr'],
      divisionsAtCell: DIVISIONS_AT_CELL,
      siblingBundles: [],
    })
    expect(result).toBeNull()
  })
})
