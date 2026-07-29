import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBuildInfo, formatBuildLabel, readBuildInfo, readAppVersion } from './buildInfo.js'

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

// T14. Both causes lived OUTSIDE the pure functions this file already covered,
// which is why a green suite shipped them. These tests target the two seams
// that were actually broken: which file readBuildInfo is allowed to read, and
// where the version number comes from.
describe('T14: a development run must not claim to be a packaged build', () => {
  function withStampDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-stamp-'))
    fs.writeFileSync(
      path.join(dir, 'build-info.json'),
      JSON.stringify({ commit: 'deadbee1234567', builtAt: '2026-07-29T12:00:00.000Z' }),
    )
    try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }

  it('ignores a real build-info.json entirely when the run is not packaged', () => {
    // The regression: write-build-info.js leaves this file in the working tree
    // after packaging, it is gitignored rather than cleaned up, and every later
    // dev run read it and reported a stale commit as if it were this build.
    withStampDir((dir) => {
      const info = readBuildInfo(dir, false)
      expect(info.isDev).toBe(true)
      expect(info.commit).toBe(null)
      expect(formatBuildLabel(info, '0.1.0')).toBe('v0.1.0 · dev')
    })
  })

  it('still reads the stamp when the run IS packaged', () => {
    withStampDir((dir) => {
      const info = readBuildInfo(dir, true)
      expect(info.isDev).toBe(false)
      expect(info.commit).toBe('deadbee1234567')
      expect(formatBuildLabel(info, '0.1.0')).toBe('v0.1.0 · deadbee · 2026-07-29')
    })
  })

  it('reads the app version from package.json, not Electron’s', () => {
    // app.getVersion() returns Electron's own version (e.g. 43.1.1) in an
    // unpackaged run, which is how "v43.1.1" reached the sidebar footer.
    const version = readAppVersion(path.join(process.cwd(), 'electron'))
    const expected = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version
    expect(version).toBe(expected)
    expect(version).not.toMatch(/^4[0-9]\./)
  })

  it('returns null rather than guessing when package.json cannot be read', () => {
    expect(readAppVersion('/tmp/definitely-not-a-project-dir-xyz')).toBe(null)
  })
})
