import { describe, it, expect } from 'vitest'
import { DOW, parseIdList, makeSerializeFieldValue } from './setupHelpers'

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
})
