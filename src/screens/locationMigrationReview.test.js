import { describe, it, expect } from 'vitest'
import { deriveLocationId } from '../../electron/ops/locationId'
import {
  groupNearDuplicateReviews,
  activeNearDuplicateGroups,
  defaultWinner,
  capacityDisagreementCopy,
  wasUnlimitedCopy,
  variantList,
} from './locationMigrationReview'

const CAMP_ID = 'camp-1'

describe('groupNearDuplicateReviews', () => {
  it('groups the two rows per pair by their sorted variants', () => {
    const reviews = [
      { id: 'r1', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } },
      { id: 'r2', kind: 'near_duplicate', detail: { variants: ['pool', 'Pool'] } },
      { id: 'r3', kind: 'was_unlimited', detail: { seededCapacity: 1 } },
    ]
    const groups = groupNearDuplicateReviews(reviews)
    expect(groups).toHaveLength(1)
    expect(groups[0].variants).toEqual(['Pool', 'pool'])
    expect(groups[0].reviewIds.sort()).toEqual(['r1', 'r2'])
  })

  // Code Reviewer LOW: joining sorted variants with a space collided for
  // space-containing names — ["A B","C"] and ["A","B C"] both sorted-and-
  // joined to "A B C", making React's key={group.key} on NearDuplicateGate
  // treat two different merge decisions as one component instance.
  it('does not collide two distinct variant sets that share a space-joined form', () => {
    const reviews = [
      { id: 'r1', kind: 'near_duplicate', detail: { variants: ['A B', 'C'] } },
      { id: 'r2', kind: 'near_duplicate', detail: { variants: ['A', 'B C'] } },
    ]
    const groups = groupNearDuplicateReviews(reviews)
    expect(groups).toHaveLength(2)
    expect(groups[0].key).not.toBe(groups[1].key)
  })

  it('keeps a group with more than two variants together', () => {
    const reviews = [
      { id: 'r1', kind: 'near_duplicate', detail: { variants: ['Gym', 'gym', 'GYM'] } },
      { id: 'r2', kind: 'near_duplicate', detail: { variants: ['gym', 'Gym', 'GYM'] } },
      { id: 'r3', kind: 'near_duplicate', detail: { variants: ['GYM', 'Gym', 'gym'] } },
    ]
    const groups = groupNearDuplicateReviews(reviews)
    expect(groups).toHaveLength(1)
    expect(groups[0].variants).toEqual(['GYM', 'Gym', 'gym'])
    expect(groups[0].reviewIds).toHaveLength(3)
  })
})

describe('activeNearDuplicateGroups (D4 self-heal)', () => {
  const poolId = deriveLocationId(CAMP_ID, 'Pool')
  const poolLowerId = deriveLocationId(CAMP_ID, 'pool')
  const reviews = [
    { id: 'r1', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } },
    { id: 'r2', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } },
  ]

  it('resolves both variants to live locations and counts bound activities', () => {
    const locations = [{ id: poolId, name: 'Pool', capacity: 3 }, { id: poolLowerId, name: 'pool', capacity: 1 }]
    const activities = [
      { id: 'a1', location_id: poolId },
      { id: 'a2', location_id: poolId },
      { id: 'a3', location_id: poolLowerId },
    ]
    const groups = activeNearDuplicateGroups(reviews, CAMP_ID, locations, activities)
    expect(groups).toHaveLength(1)
    const byName = Object.fromEntries(groups[0].variantRows.map((v) => [v.name, v]))
    expect(byName.Pool.activityCount).toBe(2)
    expect(byName.pool.activityCount).toBe(1)
  })

  it('hides the group when one variant location no longer exists (already merged elsewhere)', () => {
    const locations = [{ id: poolId, name: 'Pool', capacity: 3 }]
    const groups = activeNearDuplicateGroups(reviews, CAMP_ID, locations, [])
    expect(groups).toEqual([])
  })

  it('hides the group when neither variant location exists', () => {
    const groups = activeNearDuplicateGroups(reviews, CAMP_ID, [], [])
    expect(groups).toEqual([])
  })
})

describe('defaultWinner', () => {
  it('picks the variant with the most bound activities', () => {
    const rows = [
      { name: 'Pool', capacity: 3, activityCount: 2 },
      { name: 'pool', capacity: 1, activityCount: 1 },
    ]
    expect(defaultWinner(rows).name).toBe('Pool')
  })

  it('breaks a tie in activity count by the higher capacity', () => {
    const rows = [
      { name: 'Pool', capacity: 1, activityCount: 2 },
      { name: 'pool', capacity: 3, activityCount: 2 },
    ]
    expect(defaultWinner(rows).name).toBe('pool')
  })
})

describe('capacityDisagreementCopy (D-2 numbers-only)', () => {
  it('renders two declared caps as "N and M"', () => {
    expect(capacityDisagreementCopy({ declaredCaps: [1, 3], seededCapacity: 3 })).toBe(
      'activities here asked for different limits (1 and 3 groups at once). Shoresh kept the most room: 3.'
    )
  })

  it('never names an activity — numbers only', () => {
    const copy = capacityDisagreementCopy({ declaredCaps: [1, 3], seededCapacity: 3 })
    expect(copy).not.toMatch(/Swim|Lessons|activit(y|ies) named/i)
  })
})

describe('wasUnlimitedCopy', () => {
  it('renders the seeded capacity as the new limit', () => {
    expect(wasUnlimitedCopy({ seededCapacity: 1 })).toBe(
      'had no limit set and is now 1 group at a time. That may change a generated week or two — take a look before you regenerate.'
    )
  })
})

describe('variantList', () => {
  it('joins two names with "and"', () => {
    expect(variantList(['Pool', 'pool'])).toBe('“Pool” and “pool”')
  })

  it('joins three names with commas and a final "and"', () => {
    expect(variantList(['Gym', 'gym', 'GYM'])).toBe('“Gym”, “gym” and “GYM”')
  })
})
