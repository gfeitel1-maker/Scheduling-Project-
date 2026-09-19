import { describe, it, expect } from 'vitest'
import { deriveDayId, parseDayOfWeek } from './dayId.js'

describe('deriveDayId / parseDayOfWeek', () => {
  it('is deterministic for the same camp+weekday', () => {
    expect(deriveDayId('camp-1', 1)).toBe(deriveDayId('camp-1', 1))
  })

  it('differs across camps and across weekdays', () => {
    expect(deriveDayId('camp-1', 1)).not.toBe(deriveDayId('camp-2', 1))
    expect(deriveDayId('camp-1', 1)).not.toBe(deriveDayId('camp-1', 2))
  })

  it('round-trips the weekday back out of a derived id', () => {
    expect(parseDayOfWeek(deriveDayId('camp-1', 3))).toBe(3)
  })

  it('returns null for a legacy random-UUID row instead of throwing', () => {
    expect(parseDayOfWeek('550e8400-e29b-41d4-a716-446655440000')).toBeNull()
  })

  it('returns null for non-string input instead of throwing', () => {
    expect(parseDayOfWeek(null)).toBeNull()
    expect(parseDayOfWeek(undefined)).toBeNull()
  })
})
