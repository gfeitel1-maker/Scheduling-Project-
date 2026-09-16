// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseUnlockArgs, emitDbKey } from './unlockDbKey.js'

const HEX64 = 'ab'.repeat(32)

describe('parseUnlockArgs', () => {
  it('defaults to print mode', () => {
    expect(parseUnlockArgs([])).toEqual({ mode: 'print' })
    expect(parseUnlockArgs(['--print'])).toEqual({ mode: 'print' })
  })
  it('parses --to-file <path>', () => {
    expect(parseUnlockArgs(['--to-file', '/run/k'])).toEqual({ mode: 'file', filePath: '/run/k' })
  })
  it('throws when --to-file has no path', () => {
    expect(() => parseUnlockArgs(['--to-file'])).toThrow(/requires a path/)
  })
})

describe('emitDbKey', () => {
  it('print mode writes the hex key + newline to stdout', () => {
    let out = ''
    const res = emitDbKey(HEX64, { mode: 'print', stdout: { write: (s) => { out += s } } })
    expect(res).toEqual({ mode: 'print' })
    expect(out).toBe(HEX64 + '\n')
  })

  it('file mode writes the key with 0600 perms and enforces them', () => {
    const calls = []
    const fsImpl = {
      writeFileSync: (p, data, opts) => calls.push(['write', p, data, opts?.mode]),
      chmodSync: (p, mode) => calls.push(['chmod', p, mode]),
    }
    const res = emitDbKey(HEX64, { mode: 'file', filePath: '/run/k', fsImpl })
    expect(res).toEqual({ mode: 'file', filePath: '/run/k' })
    expect(calls).toEqual([
      ['write', '/run/k', HEX64, 0o600],
      ['chmod', '/run/k', 0o600],
    ])
  })

  it('file mode requires a path', () => {
    expect(() => emitDbKey(HEX64, { mode: 'file', fsImpl: {} })).toThrow(/requires a path/)
  })
})
