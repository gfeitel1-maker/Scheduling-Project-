import { describe, it, expect } from 'vitest'
import { isChangeOverSpan, CHANGE_OVER_MAX_MINUTES } from './periodSpan'

// T132. Importing one real camp file produced 15 "time blocks", two of which
// were five-minute gaps between periods rather than periods anyone schedules
// into: "1:05-1:10" and "11:45-11:50". The source file names these explicitly
// elsewhere ("11:10-11:20 Change", "9:40-9:50 Change") — they are passing time.
describe('isChangeOverSpan', () => {
  it('calls the five-minute gaps a real file produced change-overs', () => {
    expect(isChangeOverSpan('1:05-1:10')).toBe(true)
    expect(isChangeOverSpan('11:45-11:50')).toBe(true)
  })

  it('calls the ten-minute gaps the file labels "Change" change-overs', () => {
    expect(isChangeOverSpan('11:10-11:20')).toBe(true)
    expect(isChangeOverSpan('9:40-9:50')).toBe(true)
  })

  it('leaves real periods alone, including the shortest one in the corpus', () => {
    // campB's "Group Time" is a real 15-minute period. A first pass set the
    // threshold at 15 and deleted it; this is the regression that moved the
    // line to 10.
    expect(isChangeOverSpan('09:00-09:15')).toBe(false) // 15 min, real
    expect(isChangeOverSpan('3:20-3:40')).toBe(false)   // 20 min
    expect(isChangeOverSpan('9:15-9:40')).toBe(false)   // 25 min
    expect(isChangeOverSpan('10:30-11:05')).toBe(false) // 35 min
  })

  it('keeps a label it cannot measure — silence is not evidence of a gap', () => {
    expect(isChangeOverSpan('11:10')).toBe(false)
    expect(isChangeOverSpan('Block 2')).toBe(false)
    expect(isChangeOverSpan('')).toBe(false)
  })

  it('measures across noon without the clock running backwards', () => {
    // 11:50am -> 12:25pm is 35 minutes, not a negative number.
    expect(isChangeOverSpan('11:50-12:25')).toBe(false)
    // 12:55pm -> 1:35pm is 40 minutes.
    expect(isChangeOverSpan('12:55-01:35')).toBe(false)
  })

  it('states its threshold rather than hiding it', () => {
    expect(CHANGE_OVER_MAX_MINUTES).toBe(10)
  })
})
