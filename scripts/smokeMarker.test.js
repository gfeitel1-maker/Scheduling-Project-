import { describe, it, expect } from 'vitest'
import { markerMatchesDeploy, stripDirtySuffix } from './smokeMarker.js'

describe('markerMatchesDeploy', () => {
  it('accepts a marker whose commit matches the deployed commit', () => {
    expect(markerMatchesDeploy('abc123', 'abc123')).toBe(true)
  })

  it('accepts a marker matching an expected commit that carries a -dirty suffix', () => {
    expect(markerMatchesDeploy('abc123', 'abc123-dirty')).toBe(true)
  })

  it('rejects a stale marker from a different commit', () => {
    expect(markerMatchesDeploy('deadbeef', 'abc123')).toBe(false)
  })

  it('rejects a stale marker even when only the -dirty suffix differs from a mismatched sha', () => {
    expect(markerMatchesDeploy('deadbeef-dirty', 'abc123-dirty')).toBe(false)
  })

  it('rejects a missing marker commit', () => {
    expect(markerMatchesDeploy(null, 'abc123')).toBe(false)
    expect(markerMatchesDeploy(undefined, 'abc123')).toBe(false)
    expect(markerMatchesDeploy('', 'abc123')).toBe(false)
  })

  it('rejects a missing expected commit', () => {
    expect(markerMatchesDeploy('abc123', null)).toBe(false)
    expect(markerMatchesDeploy('abc123', undefined)).toBe(false)
    expect(markerMatchesDeploy('abc123', '')).toBe(false)
  })
})

describe('stripDirtySuffix', () => {
  it('strips a trailing -dirty suffix', () => {
    expect(stripDirtySuffix('abc123-dirty')).toBe('abc123')
  })

  it('leaves a clean commit untouched', () => {
    expect(stripDirtySuffix('abc123')).toBe('abc123')
  })

  it('passes through non-string input unchanged', () => {
    expect(stripDirtySuffix(null)).toBe(null)
    expect(stripDirtySuffix(undefined)).toBe(undefined)
  })
})
