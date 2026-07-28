import { describe, it, expect } from 'vitest'
import { parseBuildInfo, formatBuildLabel, readBuildInfo } from './buildInfo.js'

// T13 — a stale packaged build was indistinguishable from a current one, which
// cost a diagnosis cycle on T12.

describe('parseBuildInfo', () => {
  it('reads a real stamp', () => {
    const info = parseBuildInfo(JSON.stringify({ commit: 'abc1234def', builtAt: '2026-07-28T14:00:00.000Z' }))
    expect(info).toEqual({ commit: 'abc1234def', builtAt: '2026-07-28T14:00:00.000Z', isDev: false })
  })

  it('treats a missing stamp as a dev build, not an unknown one', () => {
    // No file is the normal state of `npm run electron:dev`, and the DEV badge
    // already identifies that case. It is an answer, not a gap.
    expect(parseBuildInfo(undefined).isDev).toBe(true)
    expect(parseBuildInfo('').isDev).toBe(true)
  })

  it('never reports a corrupt stamp as a real build', () => {
    // Unknown provenance is exactly what this exists to surface — silently
    // presenting garbage as a version would be worse than showing nothing.
    expect(parseBuildInfo('{not json').isDev).toBe(true)
    expect(parseBuildInfo('null').isDev).toBe(true)
    expect(parseBuildInfo('[]').isDev).toBe(true)
    expect(parseBuildInfo('{"commit":"","builtAt":""}').isDev).toBe(true)
  })

  it('accepts a stamp with only a build date', () => {
    // Building outside a git checkout is legitimate; a date still beats nothing.
    const info = parseBuildInfo(JSON.stringify({ builtAt: '2026-07-28T14:00:00.000Z' }))
    expect(info.isDev).toBe(false)
    expect(info.commit).toBeNull()
  })
})

describe('formatBuildLabel', () => {
  it('shows version, short commit and date for a packaged build', () => {
    const label = formatBuildLabel({ commit: 'abc1234def5678', builtAt: '2026-07-28T14:00:00.000Z', isDev: false }, '0.1.0')
    expect(label).toBe('v0.1.0 · abc1234 · 2026-07-28')
  })

  it('marks a development build as dev rather than inventing a commit', () => {
    expect(formatBuildLabel({ isDev: true }, '0.1.0')).toBe('v0.1.0 · dev')
    expect(formatBuildLabel(null, null)).toBe('dev')
  })

  it('distinguishes two builds from different commits', () => {
    // The T12 failure in one line: two packaged builds must not look identical.
    const a = formatBuildLabel({ commit: 'aaaaaaa1', builtAt: '2026-07-27T13:01:00.000Z', isDev: false }, '0.1.0')
    const b = formatBuildLabel({ commit: 'bbbbbbb2', builtAt: '2026-07-28T14:00:00.000Z', isDev: false }, '0.1.0')
    expect(a).not.toBe(b)
  })

  it('surfaces a dirty build so it is not mistaken for a clean commit', () => {
    const label = formatBuildLabel({ commit: 'abc1234-dirty', builtAt: '2026-07-28T14:00:00.000Z', isDev: false }, '0.1.0')
    expect(label).toContain('abc1234')
  })
})

describe('readBuildInfo', () => {
  it('returns a dev build when no stamp file exists', () => {
    expect(readBuildInfo('/tmp/definitely-not-a-build-dir-xyz').isDev).toBe(true)
  })
})
