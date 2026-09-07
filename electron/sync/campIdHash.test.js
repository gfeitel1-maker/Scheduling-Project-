// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { campIdHash } from './campIdHash.js'

// This value is broadcast in the clear on the LAN by both discovery paths, so
// its properties are a privacy contract, not an implementation detail.
describe('campIdHash', () => {
  it('is deterministic', () => {
    expect(campIdHash('camp-1')).toBe(campIdHash('camp-1'))
  })

  it('separates camps', () => {
    expect(campIdHash('camp-1')).not.toBe(campIdHash('camp-2'))
  })

  it('is 16 lowercase hex chars', () => {
    expect(campIdHash('camp-1')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('does not leak the input', () => {
    expect(campIdHash('camp-ohalo-2026')).not.toContain('ohalo')
  })

  it('refuses a missing or non-string camp id', () => {
    expect(() => campIdHash('')).toThrow()
    expect(() => campIdHash(undefined)).toThrow()
    expect(() => campIdHash(null)).toThrow()
    expect(() => campIdHash(123)).toThrow()
  })
})
