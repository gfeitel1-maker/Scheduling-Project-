// T232 — propose the division a misspelled sheet value probably meant.
import { describe, it, expect } from 'vitest'
import { suggestDivisionMatch } from './suggestDivisionMatch.js'

const TIERS = ['Bogrim', 'Machanayim', 'Tzeirim']

describe('suggestDivisionMatch', () => {
  it('proposes the obvious near match', () => {
    expect(suggestDivisionMatch('Bogrimm', TIERS)).toBe('Bogrim')
    expect(suggestDivisionMatch('Machanaim', TIERS)).toBe('Machanayim')
    expect(suggestDivisionMatch('Tzierim', TIERS)).toBe('Tzeirim')
  })

  it('returns null for a value that is nothing like any division', () => {
    expect(suggestDivisionMatch('Waterfront', TIERS)).toBeNull()
    expect(suggestDivisionMatch('', TIERS)).toBeNull()
    expect(suggestDivisionMatch('Bogrim', [])).toBeNull()
  })

  // Precision over recall, the same posture as nearDuplicateNames.js: a wrong
  // proposal costs a director a judgement call about two things that were never
  // related. When two divisions are equally close, we do not guess.
  it('refuses to guess when two divisions are equally near', () => {
    expect(suggestDivisionMatch('Xaaa', ['Yaaa', 'Zaaa'])).toBeNull()
  })

  // An exact (normalized) match is not this function's job — buildAttendance
  // has already matched it. Returning it here would make a matched camper look
  // like a proposal.
  it('returns null for a value that already matches exactly', () => {
    expect(suggestDivisionMatch('bogrim', TIERS)).toBeNull()
    expect(suggestDivisionMatch('  BOGRIM  ', TIERS)).toBeNull()
  })

  // The distance budget must not scale into nonsense on short names: at
  // distance 2, 'Bog' would reach 'Bogrim' and every other 3-letter string
  // would reach something.
  it('does not propose across a distance too large to be a typo', () => {
    expect(suggestDivisionMatch('Bog', TIERS)).toBeNull()
    expect(suggestDivisionMatch('Machane', ['Machanayim'])).toBeNull()
  })
})
