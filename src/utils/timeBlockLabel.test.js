import { describe, it, expect } from 'vitest'
import { timeBlockLabel, isTimeRangeName, blockLabelParts, formatTime12 } from './timeBlockLabel.js'

describe('timeBlockLabel', () => {
  it('renders a block whose name only restates its times once, with AM/PM', () => {
    expect(timeBlockLabel({ name: '15:20-15:40', start_time: '15:20:00', end_time: '15:40:00' })).toBe('3:20–3:40 PM')
    expect(timeBlockLabel({ name: '03:20-03:40', start_time: '03:20', end_time: '03:40' })).toBe('3:20–3:40 AM')
  })
  it('keeps a real name and appends the formatted range', () => {
    expect(timeBlockLabel({ name: 'Period 1', start_time: '09:00', end_time: '09:45' })).toBe('Period 1 (9:00–9:45 AM)')
  })
  it('spans noon with both suffixes', () => {
    expect(timeBlockLabel({ name: 'Lunch', start_time: '11:30', end_time: '12:15' })).toBe('Lunch (11:30 AM–12:15 PM)')
  })
  it('falls back to the name when times are missing', () => {
    expect(timeBlockLabel({ name: 'Flex' })).toBe('Flex')
  })
})

// Audit I3 — an imported block named after its own times must render once, in
// the 12-hour form, whatever shape the file printed the range in.
describe('isTimeRangeName', () => {
  it.each([
    '12:55-01:35', '12:55–13:35', '3:20-3:40', '03:20-03:40', '9:15 - 9:40', '08:40—09:00',
    '3:20pm-3:40pm', '3:20 PM – 3:40 PM', '11:30 AM-12:15 PM', '9.15-9.40', '10:00 to 10:45', '9am-10am',
  ])('recognises %s as a time range', (name) => {
    expect(isTimeRangeName(name)).toBe(true)
  })
  it.each(['Period 1', 'Lunch', 'Swim Period', '', null, 'Block 2 (9:00-9:45)', '9-10', '12:55'])(
    'does not treat %s as a time range', (name) => {
      expect(isTimeRangeName(name)).toBe(false)
    })
})

describe('timeBlockLabel — imported time-range names render once (I3)', () => {
  it.each([
    ['12:55-01:35', '12:55:00', '13:35:00', '12:55–1:35 PM'],
    ['12:55–13:35', '12:55', '13:35', '12:55–1:35 PM'],
    ['03:20-03:40', '15:20:00', '15:40:00', '3:20–3:40 PM'],
    ['3:20pm-3:40pm', '15:20', '15:40', '3:20–3:40 PM'],
    ['11:30-12:15', '11:30', '12:15', '11:30 AM–12:15 PM'],
    ['9:00-9:45', '09:00', '09:45', '9:00–9:45 AM'],
  ])('%s (%s–%s) → %s', (name, start_time, end_time, want) => {
    expect(timeBlockLabel({ name, start_time, end_time })).toBe(want)
  })
  it('keeps a time-range name verbatim when the block has no times to format', () => {
    expect(timeBlockLabel({ name: '12:55-01:35' })).toBe('12:55-01:35')
  })
})

describe('blockLabelParts — the row-header form (name line + time line)', () => {
  it('drops the time line when the name IS the time range', () => {
    expect(blockLabelParts({ name: '12:55-01:35', start_time: '12:55', end_time: '13:35' }))
      .toEqual({ name: '12:55–1:35 PM', time: '' })
  })
  it('keeps a real name and puts the 12-hour range on the time line', () => {
    expect(blockLabelParts({ name: 'Swim Period', start_time: '16:00:00', end_time: '16:45:00' }))
      .toEqual({ name: 'Swim Period', time: '4:00–4:45 PM' })
  })
  it('a block with no times shows just its name', () => {
    expect(blockLabelParts({ name: 'Flex' })).toEqual({ name: 'Flex', time: '' })
  })
})

describe('formatTime12 — one clock time', () => {
  it.each([['00:30', '12:30 AM'], ['09:05:00', '9:05 AM'], ['12:00', '12:00 PM'], ['13:35:00', '1:35 PM'], ['23:59', '11:59 PM']])(
    '%s → %s', (t, want) => { expect(formatTime12(t)).toBe(want) })
  it('returns empty for a value that is not a time', () => {
    expect(formatTime12('')).toBe('')
    expect(formatTime12(null)).toBe('')
    expect(formatTime12('noon')).toBe('')
  })
})
