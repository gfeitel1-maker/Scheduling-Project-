import { describe, it, expect } from 'vitest'
import { decide } from './ensure-abi.js'

// T44. ensure-abi decided whether to rebuild purely by comparing .abi-target's
// contents against the wanted signature — it never checked that the compiled
// binary actually exists or loads. Under concurrent agent sessions running
// electron-rebuild/npm rebuild at the same time, the binary vanished while the
// marker still said "built for node:XXX": pretest printed "nothing to do",
// and the suite then failed 47/47 with "Could not locate the bindings file".
// A marker lying about reality is exactly the failure class
// scripts/verifyNativeAbi.js (T20) exists to catch — so this applies the same
// principle: ask the binary, not the build config.

describe('decide', () => {
  it('skips the rebuild when the marker matches and the node binary confirms it', () => {
    const result = decide({ target: 'node', want: 'node:127', have: 'node:127', binaryClass: 'node' })
    expect(result.rebuild).toBe(false)
    expect(result.reason).toBe('confirmed')
  })

  it('skips the rebuild when the marker matches and the electron binary confirms it', () => {
    const result = decide({ target: 'electron', want: 'electron:33.0.0', have: 'electron:33.0.0', binaryClass: 'electron' })
    expect(result.rebuild).toBe(false)
    expect(result.reason).toBe('confirmed')
  })

  it('rebuilds when the marker matches but the binary is missing (T44 regression)', () => {
    // This is the exact scenario that broke the suite: marker says "built for
    // node:XXX" but the .node file is gone because a concurrent rebuild
    // removed it mid-flight.
    const result = decide({ target: 'node', want: 'node:127', have: 'node:127', binaryClass: 'missing' })
    expect(result.rebuild).toBe(true)
    expect(result.reason).toBe('binary-missing')
    expect(result.message).toMatch(/T44/)
  })

  it('rebuilds when the marker matches but the node binary is actually built for electron', () => {
    const result = decide({ target: 'node', want: 'node:127', have: 'node:127', binaryClass: 'electron' })
    expect(result.rebuild).toBe(true)
    expect(result.reason).toBe('binary-mismatch')
  })

  it('rebuilds when the marker matches but the electron binary is actually built for node', () => {
    const result = decide({ target: 'electron', want: 'electron:33.0.0', have: 'electron:33.0.0', binaryClass: 'node' })
    expect(result.rebuild).toBe(true)
    expect(result.reason).toBe('binary-mismatch')
  })

  it('rebuilds when the marker matches but the binary classification is unknown', () => {
    const result = decide({ target: 'node', want: 'node:127', have: 'node:127', binaryClass: 'unknown' })
    expect(result.rebuild).toBe(true)
    expect(result.reason).toBe('binary-mismatch')
  })

  it('rebuilds when the marker is absent', () => {
    const result = decide({ target: 'node', want: 'node:127', have: null, binaryClass: 'node' })
    expect(result.rebuild).toBe(true)
    expect(result.reason).toBe('marker-stale')
  })

  it('rebuilds when the marker is stale (wrong target recorded)', () => {
    const result = decide({ target: 'electron', want: 'electron:33.0.0', have: 'node:127', binaryClass: 'electron' })
    expect(result.rebuild).toBe(true)
    expect(result.reason).toBe('marker-stale')
  })
})
