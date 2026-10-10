// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { resolvePendingProfile, parseUlimit, readOpenFileSoftLimit, describeFdSelection, LOW_PROFILE, NORMAL_PROFILE } from './fdLimitProfile.js'

describe('pending-slot profile from the open-file soft limit (T340)', () => {
  it('256 picks the low profile 32/128', () => {
    expect(resolvePendingProfile({ platform: 'darwin', readLimit: () => 256 })).toMatchObject({ publicSubCap: 32, globalPending: 128, name: 'low' })
  })
  it('10240 picks 64/256', () => {
    expect(resolvePendingProfile({ platform: 'darwin', readLimit: () => 10240 })).toMatchObject({ publicSubCap: 64, globalPending: 256, name: 'normal' })
  })
  it('exactly 512 is normal, 511 is low', () => {
    expect(resolvePendingProfile({ platform: 'linux', readLimit: () => 512 }).name).toBe('normal')
    expect(resolvePendingProfile({ platform: 'linux', readLimit: () => 511 }).name).toBe('low')
  })
  it('a read failure picks the conservative profile on darwin/linux', () => {
    const boom = () => { throw new Error('spawn failed') }
    expect(resolvePendingProfile({ platform: 'darwin', readLimit: boom })).toMatchObject(LOW_PROFILE)
    expect(resolvePendingProfile({ platform: 'linux', readLimit: () => null })).toMatchObject(LOW_PROFILE)
  })
  it('win32 is treated as high without reading', () => {
    let called = false
    expect(resolvePendingProfile({ platform: 'win32', readLimit: () => { called = true; return 1 } })).toMatchObject(NORMAL_PROFILE)
    expect(called).toBe(false)
  })
  it('"unlimited" falls back conservatively by platform (low on darwin/linux)', () => {
    expect(parseUlimit('unlimited\n')).toBeNull()
    expect(resolvePendingProfile({ platform: 'darwin', readLimit: () => parseUlimit('unlimited') }).name).toBe('low')
    expect(parseUlimit('256\n')).toBe(256)
    expect(parseUlimit('garbage')).toBeNull()
  })
  it('logs the chosen profile once as a fixed string with the number and no addresses', () => {
    const lines = []
    resolvePendingProfile({ platform: 'darwin', readLimit: () => 256, log: (m) => lines.push(m) })
    expect(lines).toEqual(['automerge sync: open-file soft limit 256 -> pending profile low (public 32, global 128)'])
  })
  it('readOpenFileSoftLimit runs /bin/sh -c "ulimit -n" through the injected spawn', () => {
    const calls = []
    const n = readOpenFileSoftLimit((cmd, args, opts) => { calls.push([cmd, args, opts.timeout > 0]); return { status: 0, stdout: '4096\n' } })
    expect(n).toBe(4096)
    expect(calls).toEqual([['/bin/sh', ['-c', 'ulimit -n'], true]])
    expect(readOpenFileSoftLimit(() => ({ status: 1, stdout: '' }))).toBeNull()
  })
  it('reads with a 500ms timeout, and a timed-out or killed child yields the low profile', () => {
    let timeout
    readOpenFileSoftLimit((c, a, o) => { timeout = o.timeout; return { status: 0, stdout: '4096\n' } })
    expect(timeout).toBe(500)
    const timedOut = () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '' })
    const killed = () => ({ status: null, signal: 'SIGKILL', stdout: '4096\n' })
    for (const spawn of [timedOut, killed]) {
      expect(readOpenFileSoftLimit(spawn)).toBeNull()
      expect(resolvePendingProfile({ platform: 'darwin', readLimit: () => readOpenFileSoftLimit(spawn) }).name).toBe('low')
    }
  })
})

describe('describeFdSelection (what the packaged app reports in its smoke marker)', () => {
  it('reports the limit and the profile name resolved from that same limit', () => {
    expect(describeFdSelection({ platform: 'darwin', readLimit: () => 256 })).toEqual({ fdLimit: 256, selectedProfile: 'low' })
    expect(describeFdSelection({ platform: 'darwin', readLimit: () => 10240 })).toEqual({ fdLimit: 10240, selectedProfile: 'normal' })
    expect(describeFdSelection({ platform: 'darwin', readLimit: () => null })).toEqual({ fdLimit: null, selectedProfile: 'low' })
  })
})
