// @vitest-environment node
//
// T271 (docs/adr/2026-09-26-schema-version-gate-before-merge.md): the small, pure predicate that
// decides whether an incoming document's schemaVersion is safe to merge into this device's own.
// Owner-ruled policy: STRICT exact-match only — no tolerant range. A missing/unknown incoming
// version (null) is treated as incompatible ("unknown = don't merge"), per Decision 2.
import { describe, it, expect } from 'vitest'
import { isSyncCompatible } from './syncNode.js'

describe('isSyncCompatible (T271)', () => {
  it('is compatible when the incoming version exactly matches the local version', () => {
    expect(isSyncCompatible(76, 76)).toBe(true)
  })

  it('is incompatible when the incoming version is higher than the local version', () => {
    expect(isSyncCompatible(77, 76)).toBe(false)
  })

  it('is incompatible when the incoming version is lower than the local version', () => {
    expect(isSyncCompatible(75, 76)).toBe(false)
  })

  it('is incompatible when the incoming version is null/unknown (does not default to compatible)', () => {
    expect(isSyncCompatible(null, 76)).toBe(false)
  })

  it('is incompatible when the incoming version is undefined', () => {
    expect(isSyncCompatible(undefined, 76)).toBe(false)
  })
})
