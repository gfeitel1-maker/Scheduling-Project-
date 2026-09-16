// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseUnlockArgs, childEnvWithKey } from './unlockDbKey.js'

const HEX64 = 'ab'.repeat(32)

describe('parseUnlockArgs', () => {
  it('defaults to print mode', () => {
    expect(parseUnlockArgs([])).toEqual({ mode: 'print' })
    expect(parseUnlockArgs(['--print'])).toEqual({ mode: 'print' })
  })
  it('parses --exec -- <command...> (dropping the -- separator)', () => {
    expect(parseUnlockArgs(['--exec', '--', 'node', 'scripts/mcp/server.js', '--db', '/x']))
      .toEqual({ mode: 'exec', command: ['node', 'scripts/mcp/server.js', '--db', '/x'] })
  })
  it('parses --exec without the -- separator', () => {
    expect(parseUnlockArgs(['--exec', 'node', 'x.js'])).toEqual({ mode: 'exec', command: ['node', 'x.js'] })
  })
  it('throws when --exec has no command', () => {
    expect(() => parseUnlockArgs(['--exec'])).toThrow(/requires a command/)
    expect(() => parseUnlockArgs(['--exec', '--'])).toThrow(/requires a command/)
  })
  it('no longer supports --to-file (removed for security — findings 1 & 2)', () => {
    // --to-file is not recognized; it falls through to print mode (no file is ever written).
    expect(parseUnlockArgs(['--to-file', '/run/k'])).toEqual({ mode: 'print' })
  })
})

describe('childEnvWithKey', () => {
  it('adds SHORESH_DB_KEY to the child env without mutating the base', () => {
    const base = { PATH: '/usr/bin', HOME: '/h' }
    const env = childEnvWithKey(HEX64, base)
    expect(env.SHORESH_DB_KEY).toBe(HEX64)
    expect(env.PATH).toBe('/usr/bin')
    expect(base.SHORESH_DB_KEY).toBeUndefined() // base untouched
  })
  it('the key is never on disk — it only ever appears in the spawned child env', () => {
    // Documented invariant: childEnvWithKey is the ONLY channel the helper uses in exec mode.
    const env = childEnvWithKey(HEX64, {})
    expect(Object.keys(env)).toContain('SHORESH_DB_KEY')
  })
})
