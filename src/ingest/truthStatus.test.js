import { describe, it, expect } from 'vitest'
import { activityTruthStatus } from './truthStatus.js'

describe('activityTruthStatus', () => {
  // Exhaustive over all 8 combinations of the three booleans.
  it('isElective true -> permission, regardless of the other two (precedence)', () => {
    expect(activityTruthStatus({ isFixedEvent: false, hasObligationRule: false, isElective: true })).toBe('permission')
    expect(activityTruthStatus({ isFixedEvent: true, hasObligationRule: false, isElective: true })).toBe('permission')
    expect(activityTruthStatus({ isFixedEvent: false, hasObligationRule: true, isElective: true })).toBe('permission')
    expect(activityTruthStatus({ isFixedEvent: true, hasObligationRule: true, isElective: true })).toBe('permission')
  })

  it('isFixedEvent && hasObligationRule (dual-use), not elective -> null (genuinely mixed)', () => {
    expect(activityTruthStatus({ isFixedEvent: true, hasObligationRule: true, isElective: false })).toBeNull()
  })

  it('isFixedEvent only -> asserted', () => {
    expect(activityTruthStatus({ isFixedEvent: true, hasObligationRule: false, isElective: false })).toBe('asserted')
  })

  it('hasObligationRule only -> obligation', () => {
    expect(activityTruthStatus({ isFixedEvent: false, hasObligationRule: true, isElective: false })).toBe('obligation')
  })

  it('none of the three -> null (not classified)', () => {
    expect(activityTruthStatus({ isFixedEvent: false, hasObligationRule: false, isElective: false })).toBeNull()
  })
})
