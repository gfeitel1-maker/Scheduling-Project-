import { describe, it, expect } from 'vitest'
import { tripDefaultWeekId, weeksForImport, defaultWeekId } from './defaultWeek.js'

// Board ruling 2026-10-13 (T379 follow-up): a trip or whole day is never left unbound, and so never imports
// as an activity for want of a week. It binds to the open week, else the camp's first week.
describe('tripDefaultWeekId', () => {
  const w = (id, sort_order, is_archived = '0') => ({ id, name: id, sort_order, is_archived })

  it('is the open week when the import lists it', () => {
    expect(tripDefaultWeekId([w('a', 0), w('b', 1)], 'b')).toBe('b')
  })

  it('is the first week by sort order when none is open, whatever order the list is in', () => {
    expect(tripDefaultWeekId([w('later', 2), w('first', 0), w('mid', 1)], null)).toBe('first')
  })

  it('skips an archived week, and takes the first one only when every week is archived', () => {
    expect(tripDefaultWeekId([w('old', 0, '1'), w('cur', 1)], null)).toBe('cur')
    expect(tripDefaultWeekId([w('old', 1, '1'), w('older', 0, '1')], null)).toBe('older')
  })

  it("ignores an open week id the list does not hold", () => {
    expect(tripDefaultWeekId([w('a', 0)], 'gone')).toBe('a')
  })

  it("is a fresh camp's Week 1, which the commit creates", () => {
    expect(tripDefaultWeekId(weeksForImport([], 'c1'), null)).toBe(defaultWeekId('c1'))
  })
})
