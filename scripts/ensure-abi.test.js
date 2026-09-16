import { describe, it, expect } from 'vitest'
import { decide, decideFork, npmBinaryFor } from './ensure-abi.js'

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

// T175 finding 2. The at-rest-encryption driver (better-sqlite3-multiple-ciphers)
// is an OPTIONAL fork that loads through the same bindings('better_sqlite3.node')
// call, so it needs its own Electron-ABI binary at build/Release. It only rides
// the Electron target, only when installed, and only when not already current —
// and a fork build failure must never break the normal keyless build.
describe('decideFork', () => {
  it('does nothing for the node target (Vitest never touches the fork)', () => {
    const r = decideFork({ target: 'node', forkInstalled: true, forkBinaryClass: 'missing' })
    expect(r.rebuild).toBe(false)
    expect(r.reason).toBe('not-electron')
  })

  it('does nothing when the optional fork is not installed', () => {
    const r = decideFork({ target: 'electron', forkInstalled: false, forkBinaryClass: 'missing' })
    expect(r.rebuild).toBe(false)
    expect(r.reason).toBe('not-installed')
  })

  it('skips when the fork binary is already the Electron ABI', () => {
    const r = decideFork({ target: 'electron', forkInstalled: true, forkBinaryClass: 'electron' })
    expect(r.rebuild).toBe(false)
    expect(r.reason).toBe('confirmed')
  })

  it('rebuilds when installed for Electron but the fork binary is missing (only the bin/ prebuild exists)', () => {
    const r = decideFork({ target: 'electron', forkInstalled: true, forkBinaryClass: 'missing' })
    expect(r.rebuild).toBe(true)
    expect(r.reason).toBe('binary-missing')
  })

  it('rebuilds when the fork binary on disk is built for the wrong runtime', () => {
    const r = decideFork({ target: 'electron', forkInstalled: true, forkBinaryClass: 'node' })
    expect(r.rebuild).toBe(true)
    expect(r.reason).toBe('binary-mismatch')
  })
})

// execFileSync('npm', ...) with no shell option cannot find npm on Windows —
// npm resolves to npm.cmd there, and CreateProcess can't launch a .cmd file
// without going through a shell. `npm.cmd` is the correct binary name on
// win32; plain `npm` elsewhere.
describe('npmBinaryFor', () => {
  it('uses npm.cmd on win32', () => {
    expect(npmBinaryFor('win32')).toBe('npm.cmd')
  })

  it('uses plain npm on darwin and linux', () => {
    expect(npmBinaryFor('darwin')).toBe('npm')
    expect(npmBinaryFor('linux')).toBe('npm')
  })
})
