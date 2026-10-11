import { describe, it, expect } from 'vitest'
import { createDayLedger, removeOwnPlaceEntry } from './placementLedger.js'

// The engine's per-day and per-place bookkeeping, inverted by unplace() during repair. Both
// used to be inverted by key alone: a Set dropped "on today" with one of two same-day sessions,
// and a place entry was found by group alone. Neither is reachable through today's repairs
// (they never lift a preplaced slot), so the ledger is tested directly.
describe('createDayLedger', () => {
  it('keeps "already on today" while any same-day session remains', () => {
    const day = createDayLedger()
    day.add('g1', 'mon', 'swim')
    day.add('g1', 'mon', 'swim') // two locked Swims the same day
    day.remove('g1', 'mon', 'swim')
    expect(day.has('g1', 'mon', 'swim')).toBe(true)
    day.remove('g1', 'mon', 'swim')
    expect(day.has('g1', 'mon', 'swim')).toBe(false)
  })
  it('keeps groups, days and activities apart', () => {
    const day = createDayLedger()
    day.add('g1', 'mon', 'swim')
    expect(day.has('g2', 'mon', 'swim')).toBe(false)
    expect(day.has('g1', 'tue', 'swim')).toBe(false)
    expect(day.has('g1', 'mon', 'art')).toBe(false)
  })
})

describe('removeOwnPlaceEntry', () => {
  it('removes the entry of this activity, not another unlabelled entry of the same group', () => {
    const list = [
      { groupId: 'g1', tierId: 't', sourceLabel: null, activityId: 'art' },
      { groupId: 'g1', tierId: 't', sourceLabel: null, activityId: 'swim' },
    ]
    removeOwnPlaceEntry(list, 'g1', 'swim')
    expect(list.map((o) => o.activityId)).toEqual(['art'])
  })
  it('never removes an overlay (labelled) entry, and tolerates a missing list', () => {
    const list = [{ groupId: 'g1', tierId: 't', sourceLabel: 'Lunch', activityId: null }]
    removeOwnPlaceEntry(list, 'g1', 'swim')
    expect(list).toHaveLength(1)
    expect(() => removeOwnPlaceEntry(undefined, 'g1', 'swim')).not.toThrow()
  })
})
