import { describe, it, expect } from 'vitest'
import { dropRedundantEndpoints } from './dropRedundantEndpoints'

// T140. Splitting a blank-line block into its real periods recovers periods
// that used to be lost, but leaves one-ended fragments behind from the wrap
// shapes it does not model. Every one of campA's fragments turned out to be an
// endpoint of a range the split now produces.
describe('dropRedundantEndpoints', () => {
  it('drops a start time that a range already covers', () => {
    expect(dropRedundantEndpoints(['9:50-10:25', '9:50'])).toEqual(['9:50-10:25'])
  })

  it('drops an end time that a range already covers', () => {
    expect(dropRedundantEndpoints(['9:50-10:25', '10:25'])).toEqual(['9:50-10:25'])
  })

  it("drops all of campA's fragments, because every one is an endpoint", () => {
    const labels = [
      '9:15-9:40', '9:50-10:25', '9:50', '10:25', '10:30-11:05', '11:10-11:45',
      '11:10', '11:45', '11:50-12:25', '12:25', '12:30-1:05', '12:30',
      '1:10-1:45', '1:45', '1:50-2:25', '2:30-3:05', '3:05', '3:15-3:40', '4:00-4:15',
    ]
    expect(dropRedundantEndpoints(labels)).toEqual([
      '9:15-9:40', '9:50-10:25', '10:30-11:05', '11:10-11:45', '11:50-12:25',
      '12:30-1:05', '1:10-1:45', '1:50-2:25', '2:30-3:05', '3:15-3:40', '4:00-4:15',
    ])
  })

  it('KEEPS a one-ended block no range covers — it may be the only trace of a period', () => {
    // campC's shape: "02:40" is covered by "02:40-03:20" and goes; "03:25" and
    // "04:00" match nothing and stay.
    expect(dropRedundantEndpoints(['02:40-03:20', '02:40', '03:25', '04:00']))
      .toEqual(['02:40-03:20', '03:25', '04:00'])
  })

  it('matches by minute, not by string, because the corpus writes both forms', () => {
    expect(dropRedundantEndpoints(['1:10-1:45', '01:45'])).toEqual(['1:10-1:45'])
    expect(dropRedundantEndpoints(['01:10-01:45', '1:45'])).toEqual(['01:10-01:45'])
  })

  it('keeps a named period, which no range can be an endpoint of', () => {
    expect(dropRedundantEndpoints(['9:15-9:40', 'Block 2'])).toEqual(['9:15-9:40', 'Block 2'])
  })

  it('never drops a range', () => {
    const ranges = ['9:15-9:40', '9:40-10:00']
    expect(dropRedundantEndpoints(ranges)).toEqual(ranges)
  })

  it('leaves a list with no ranges completely alone', () => {
    expect(dropRedundantEndpoints(['9:50', '10:25'])).toEqual(['9:50', '10:25'])
  })

  it('preserves order', () => {
    expect(dropRedundantEndpoints(['9:50', '9:15-9:40', '9:50-10:25', 'Block 2']))
      .toEqual(['9:15-9:40', '9:50-10:25', 'Block 2'])
  })

  it('tolerates an empty or missing list', () => {
    expect(dropRedundantEndpoints([])).toEqual([])
    expect(dropRedundantEndpoints()).toEqual([])
  })
})
