import { describe, it, expect } from 'vitest'
import { orderTimeBlocks, startMinutesForOrdering } from './orderTimeBlocks'

// The labels a real camp file produced (docs/work/specs/samples/campA-bunk-
// schedules.txt), in the order extractEntities emitted them. The file itself is
// not in time order — "3:15-3:40" appears before "12:30" — which is why a
// running-clock/monotonic reading cannot work here and the resolution has to be
// a stated camp-day rule instead.
const CAMP_A = [
  '9:15-9:40', '10:30-11:05', '11:10-11:45', '11:50-12:25', '3:15-3:40',
  '12:30-1:05', '1:50-2:25', '11:10', '11:45', '12:30', '1:05-1:10',
  '10:25', '2:30-3:05', '1:10-1:45', '11:45-11:50',
]

describe('startMinutesForOrdering — resolving a bare 12-hour label to a camp day', () => {
  it('reads 1 through 6 as afternoon', () => {
    expect(startMinutesForOrdering('1:05-1:10')).toBe(13 * 60 + 5)
    expect(startMinutesForOrdering('3:15-3:40')).toBe(15 * 60 + 15)
    expect(startMinutesForOrdering('6:00-6:30')).toBe(18 * 60)
  })

  it('reads 7 through 11 as morning', () => {
    expect(startMinutesForOrdering('7:30-8:00')).toBe(7 * 60 + 30)
    expect(startMinutesForOrdering('11:50-12:25')).toBe(11 * 60 + 50)
  })

  it('reads 12 as noon, not midnight', () => {
    expect(startMinutesForOrdering('12:30-1:05')).toBe(12 * 60 + 30)
  })

  it('believes an explicit meridiem over the camp-day rule', () => {
    expect(startMinutesForOrdering('3:15pm')).toBe(15 * 60 + 15)
    expect(startMinutesForOrdering('3:15am')).toBe(3 * 60 + 15)
  })

  it('believes an hour past noon as 24-hour notation', () => {
    expect(startMinutesForOrdering('15:15-15:40')).toBe(15 * 60 + 15)
  })

  it('ignores a leading zero, because real camp files zero-pad 12-hour times', () => {
    // campB-by-day.txt runs 08:40 … 12:55, 01:40, 02:25, 03:20 — zero-padded
    // throughout, with 01:40 plainly after lunch. Reading the zero as 24-hour
    // sorted that camp's entire afternoon before its breakfast.
    expect(startMinutesForOrdering('03:15-03:40')).toBe(15 * 60 + 15)
    expect(startMinutesForOrdering('08:40-09:00')).toBe(8 * 60 + 40)
    expect(startMinutesForOrdering('01:40-02:20')).toBe(13 * 60 + 40)
  })

  it('orders campB (zero-padded 12-hour) as the day actually runs', () => {
    expect(orderTimeBlocks(['12:55-01:35', '01:40-02:20', '08:40-09:00', '03:20-03:40']))
      .toEqual(['08:40-09:00', '12:55-01:35', '01:40-02:20', '03:20-03:40'])
  })

  it('returns null for a label carrying no time at all', () => {
    expect(startMinutesForOrdering('Block 2')).toBeNull()
    expect(startMinutesForOrdering('')).toBeNull()
  })
})

describe('orderTimeBlocks', () => {
  it('puts a real camp file back into the order the day actually runs', () => {
    expect(orderTimeBlocks(CAMP_A)).toEqual([
      '9:15-9:40',
      '10:25',
      '10:30-11:05',
      // Equal minutes keep the order the FILE had them in, not alphabetical:
      // '11:10-11:45' was read before the bare '11:10'.
      '11:10-11:45',
      '11:10',
      '11:45',
      '11:45-11:50',
      '11:50-12:25',
      '12:30-1:05',
      '12:30',
      '1:05-1:10',
      '1:10-1:45',
      '1:50-2:25',
      '2:30-3:05',
      '3:15-3:40',
    ])
  })

  it('is the fix for the reported defect: 3:15 no longer precedes 12:30', () => {
    const ordered = orderTimeBlocks(CAMP_A)
    expect(ordered.indexOf('3:15-3:40')).toBeGreaterThan(ordered.indexOf('12:30-1:05'))
    expect(ordered.indexOf('11:45-11:50')).toBeLessThan(ordered.indexOf('2:30-3:05'))
  })

  it('keeps untimed labels in their original relative order, after the timed ones', () => {
    expect(orderTimeBlocks(['Block 2', '9:00-9:30', 'Block 1']))
      .toEqual(['9:00-9:30', 'Block 2', 'Block 1'])
  })

  it('is stable for labels that resolve to the same minute', () => {
    expect(orderTimeBlocks(['11:45-11:50', '11:45'])).toEqual(['11:45-11:50', '11:45'])
    expect(orderTimeBlocks(['11:45', '11:45-11:50'])).toEqual(['11:45', '11:45-11:50'])
  })

  it('does not mutate its input', () => {
    const input = ['3:15-3:40', '9:15-9:40']
    orderTimeBlocks(input)
    expect(input).toEqual(['3:15-3:40', '9:15-9:40'])
  })

  it('leaves an already-ordered list alone', () => {
    const ordered = ['9:00-9:30', '10:00-10:30', '1:00-1:30']
    expect(orderTimeBlocks(ordered)).toEqual(ordered)
  })
})
