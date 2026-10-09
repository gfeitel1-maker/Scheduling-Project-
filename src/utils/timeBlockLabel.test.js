import { describe, it, expect } from 'vitest'
import { timeBlockLabel } from './timeBlockLabel'

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
