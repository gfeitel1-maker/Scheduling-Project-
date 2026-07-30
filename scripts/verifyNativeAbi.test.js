import { describe, it, expect } from 'vitest'
import { classifyLoad, verdict } from './verifyNativeAbi.js'

// T20. The install script reported success for an app that could not start.
// These cover the decision, which is the part that was missing — there was no
// check at all, not a wrong one.

// The first attempt at this read `nodedir` from build/config.gypi. It was
// wrong, and only running it revealed why: `npm rebuild` leaves a Node-ABI
// binary behind a config.gypi that still names Electron's headers. The guard
// approved shipping the exact module it existed to stop. Hence: probe the
// artifact, never the build config.
describe('classifyLoad', () => {
  it('treats "loads under Node" as a NODE build — wrong for packaging', () => {
    expect(classifyLoad({ loaded: true, error: null })).toBe('node')
  })

  it('treats a NODE_MODULE_VERSION mismatch as the Electron build', () => {
    expect(classifyLoad({
      loaded: false,
      error: "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 148.",
    })).toBe('electron')
  })

  it('returns unknown for any other failure rather than guessing', () => {
    // A missing file or a corrupt binary must not be read as either answer.
    expect(classifyLoad({ loaded: false, error: 'not a mach-o file' })).toBe('unknown')
    expect(classifyLoad({ loaded: false, error: '' })).toBe('unknown')
    expect(classifyLoad(null)).toBe('unknown')
  })
})

describe('verdict', () => {
  it('refuses a Node-ABI module and names the exact recovery', () => {
    const v = verdict({ target: 'node', projectHash: 'a', bundleHash: 'a' })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('built-for-node')
    expect(v.message).toMatch(/electron-rebuild/)
  })

  it('refuses an unknown target rather than shipping unverified provenance', () => {
    // Silence here is what produced the original defect: no signal read as a
    // good signal.
    expect(verdict({ target: 'unknown', projectHash: 'a', bundleHash: 'a' }).ok).toBe(false)
  })

  it('refuses when the bundled module is not the one this project built', () => {
    // Without this the ABI check proves nothing about what actually ships.
    const v = verdict({ target: 'electron', projectHash: 'a', bundleHash: 'b' })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('bundle-mismatch')
  })

  it('passes only when the module is Electron-built AND is the one in the bundle', () => {
    const v = verdict({ target: 'electron', projectHash: 'a', bundleHash: 'a' })
    expect(v.ok).toBe(true)
  })

  it('checks the ABI before the hashes, so the message names the real cause', () => {
    // A Node-ABI module copied faithfully is still a Node-ABI module; reporting
    // "bundle mismatch" there would send someone after the wrong problem.
    const v = verdict({ target: 'node', projectHash: 'a', bundleHash: 'b' })
    expect(v.reason).toBe('built-for-node')
  })
})
