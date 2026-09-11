import { describe, it, expect } from 'vitest'

const { formatEligibility } = await import('./importEligibility')

// T131. One real camp file produced activity rows reading "Groups: Mountain
// View, Lanterns, Wildcats, Falcons, Dolphins, Compass, Tulip, Sunbeams, Oaks,
// Coves, Brook, Waterfall, Ridge, Blue Jay, Cedar - Backcountry, Birch -
// Backcountry, Fox, Cub" — on every row. What the director needed to know was
// "nearly all of them".
const ALL = ['Oaks', 'Brook', 'Ridge', 'Fox', 'Cub', 'Tulip', 'Coves']

describe('formatEligibility', () => {
  it('says All groups for no restriction, however it is expressed', () => {
    expect(formatEligibility(null, ALL)).toBe('All groups')
    expect(formatEligibility([], ALL)).toBe('All groups')
    expect(formatEligibility(ALL, ALL)).toBe('All groups')
  })

  it('names the exceptions when almost everyone is included — the useful fact', () => {
    expect(formatEligibility(['Oaks', 'Brook', 'Ridge', 'Fox', 'Cub', 'Tulip'], ALL))
      .toBe('All groups except Coves')
    expect(formatEligibility(['Oaks', 'Brook', 'Ridge', 'Fox', 'Cub'], ALL))
      .toBe('All groups except Tulip and Coves')
  })

  it('still lists a genuinely short set', () => {
    expect(formatEligibility(['Oaks', 'Brook'], ALL)).toBe('Groups: Oaks, Brook')
  })

  it('summarises rather than printing a wall once the list stops informing', () => {
    // campA's real shape: 19 groups, an activity on 10 of them. Too many to
    // read, too many exceptions to name.
    const big = Array.from({ length: 19 }, (_, i) => `Bunk ${i}`)
    expect(formatEligibility(big.slice(0, 10), big)).toBe('10 of 19 groups')
  })

  it('prefers naming exceptions over a count when there are only one or two', () => {
    expect(formatEligibility(['Oaks', 'Brook', 'Ridge', 'Fox', 'Coves'], ALL))
      .toBe('All groups except Cub and Tulip')
  })

  it('lists a short set rather than naming exceptions, however small the camp', () => {
    // Two groups, activity on one: "Groups: Yeladim" reads; "All groups except
    // Bogrim" is technically true and worse.
    expect(formatEligibility(['Yeladim'], ['Yeladim', 'Bogrim'])).toBe('Groups: Yeladim')
  })

  it('is honest when it does not know the total', () => {
    expect(formatEligibility(['A', 'B', 'C', 'D', 'E'], [])).toBe('5 groups')
    expect(formatEligibility(['A', 'B'], [])).toBe('Groups: A, B')
  })

  it('never claims All groups for a genuine subset', () => {
    expect(formatEligibility(['Oaks'], ALL)).not.toMatch(/^All groups$/)
  })
})
