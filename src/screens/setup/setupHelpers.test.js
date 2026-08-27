import { describe, it, expect } from 'vitest'
import { DOW, parseIdList, makeSerializeFieldValue, minutesFromMidnight } from './setupHelpers'

describe('setupHelpers', () => {
  it('DOW is Sunday-first and 7 long', () => {
    expect(DOW).toHaveLength(7)
    expect(DOW[0]).toBe('Sunday')
    expect(DOW[6]).toBe('Saturday')
  })

  it('parseIdList returns [] for null/garbage and array for valid JSON', () => {
    expect(parseIdList(null)).toEqual([])
    expect(parseIdList('not json')).toEqual([])
    expect(parseIdList('{"a":1}')).toEqual([]) // object, not array
    expect(parseIdList('["x","y"]')).toEqual(['x', 'y'])
  })

  it('makeSerializeFieldValue coerces bools to 1/0 and arrays to JSON', () => {
    const serialize = makeSerializeFieldValue(new Set(['is_all_groups']), new Set(['group_ids']))
    expect(serialize('is_all_groups', true)).toBe(1)
    expect(serialize('is_all_groups', false)).toBe(0)
    expect(serialize('group_ids', ['a'])).toBe('["a"]')
    expect(serialize('group_ids', null)).toBe('[]')
    expect(serialize('name', 'Swim')).toBe('Swim')
    expect(serialize('notes', undefined)).toBe(null)
  })

  it('minutesFromMidnight parses "HH:MM" into minutes since midnight', () => {
    expect(minutesFromMidnight('09:00')).toBe(540)
    expect(minutesFromMidnight('10:00')).toBe(600)
    expect(minutesFromMidnight('00:00')).toBe(0)
    expect(minutesFromMidnight('23:59')).toBe(1439)
  })

  it('minutesFromMidnight guards null/malformed input to 0', () => {
    expect(minutesFromMidnight(null)).toBe(0)
    expect(minutesFromMidnight(undefined)).toBe(0)
    expect(minutesFromMidnight('')).toBe(0)
    expect(minutesFromMidnight('not a time')).toBe(0)
    expect(minutesFromMidnight('25:00')).toBe(0)
    expect(minutesFromMidnight('09:70')).toBe(0)
  })
})
