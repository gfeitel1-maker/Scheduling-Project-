import { describe, it, expect } from 'vitest'
import { isBackwardsBlock, partOfDayForStart } from './timeBlockRange.js'

const b = (id, start_time, end_time) => ({ id, name: id, start_time, end_time })

describe('isBackwardsBlock', () => {
  it('flags an end at or before the start', () => {
    expect(isBackwardsBlock(b('x', '16:00', '15:00'))).toBe(true)
    expect(isBackwardsBlock(b('x', '10:00', '10:00'))).toBe(true)
    expect(isBackwardsBlock(b('x', '09:00', '10:00'))).toBe(false)
  })
  it('reads stored HH:MM:SS times', () => {
    expect(isBackwardsBlock(b('x', '09:00:00', '10:00:00'))).toBe(false)
    expect(isBackwardsBlock(b('x', '16:00:00', '15:00:00'))).toBe(true)
  })
  it('does not flag a block with a missing time', () => {
    expect(isBackwardsBlock(b('x', '09:00', ''))).toBe(false)
  })
})

describe('partOfDayForStart', () => {
  it('splits at noon and 5 PM', () => {
    expect(partOfDayForStart('11:59')).toBe('morning')
    expect(partOfDayForStart('12:00')).toBe('afternoon')
    expect(partOfDayForStart('16:59')).toBe('afternoon')
    expect(partOfDayForStart('17:00')).toBe('evening')
  })
  it('returns null for no time', () => {
    expect(partOfDayForStart('')).toBe(null)
  })
})
