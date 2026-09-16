// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { resolveHeadlessDbKey } from './headlessDbKey.js'

const HEX64 = 'ab'.repeat(32) // 64 hex chars = 32 bytes

describe('resolveHeadlessDbKey', () => {
  it('returns null when neither env var is set (→ plaintext, current behavior)', () => {
    expect(resolveHeadlessDbKey({ env: {} })).toBeNull()
  })

  it('reads a valid hex key from SHORESH_DB_KEY', () => {
    const key = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: HEX64 } })
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(32)
    expect(key.toString('hex')).toBe(HEX64)
  })

  it('trims surrounding whitespace/newlines', () => {
    const key = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: `\n  ${HEX64}\n` } })
    expect(key.toString('hex')).toBe(HEX64)
  })

  it('reads the key from a file named by SHORESH_DB_KEY_FILE', () => {
    const fsImpl = { readFileSync: (p) => (p === '/run/key' ? `${HEX64}\n` : (() => { throw new Error('nope') })()) }
    const key = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY_FILE: '/run/key' }, fsImpl })
    expect(key.toString('hex')).toBe(HEX64)
  })

  it('prefers SHORESH_DB_KEY over the file when both are set', () => {
    const fsImpl = { readFileSync: () => '00'.repeat(32) }
    const key = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: HEX64, SHORESH_DB_KEY_FILE: '/run/key' }, fsImpl })
    expect(key.toString('hex')).toBe(HEX64)
  })

  it('THROWS (never silently plaintext) on a wrong-length key', () => {
    expect(() => resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: 'abcd' } })).toThrow(/hex characters/)
  })

  it('THROWS on a non-hex value', () => {
    expect(() => resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: 'z'.repeat(64) } })).toThrow(/hex characters/)
  })
})
