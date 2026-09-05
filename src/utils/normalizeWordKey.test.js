import { describe, it, expect } from 'vitest'
import { normalizeWordKey } from './normalizeWordKey.js'

describe('normalizeWordKey', () => {
  it('lowercases and collapses/trims whitespace', () => {
    expect(normalizeWordKey('  Barn  ')).toBe('barn')
    expect(normalizeWordKey('Back   Playground')).toBe('back playground')
    expect(normalizeWordKey('301')).toBe('301')
  })

  it('treats null/undefined as empty', () => {
    expect(normalizeWordKey(null)).toBe('')
    expect(normalizeWordKey(undefined)).toBe('')
  })
})
