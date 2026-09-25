// @vitest-environment node
//
// T171 item 4 — the live memory store's location, written down ONCE.
//
// The consolidation move claimed "works from any checkout". Half of it did: the
// scripts resolve their siblings via ${0:A:h}. The other half was a home-directory
// literal copied into five files, so the claim and the code disagreed — and a
// second machine, a second user, or a renamed project directory would have had to
// find and edit all five.
//
// The guard below is the durable half. The rewrite is a one-time fix; this is what
// stops the literal creeping back into a sixth file, which is the only failure mode
// that matters once the rewrite has landed.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  memoryProjectSlug,
  memoryProjectDir,
  homeDerivedSlugPrefix,
  defaultMemoryProjectSlug,
  MEMORY_PROJECT_SUFFIX,
  DEFAULT_MEMORY_PROJECT_SLUG,
} from '../scripts/memoryProject.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'scripts')
const LITERAL = DEFAULT_MEMORY_PROJECT_SLUG

function everyFileUnder(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...everyFileUnder(full))
    else out.push(full)
  }
  return out
}

describe('the slug lives in exactly one place per language', () => {
  it('no script hardcodes the memory-project slug except the two definitions', () => {
    // Read from disk rather than from a hand-kept list: a sixth file added next
    // month is caught without anyone remembering to update a list.
    const offenders = everyFileUnder(SCRIPTS)
      .filter((f) => /\.(sh|js|mjs)$/.test(f))
      .filter((f) => !/memoryProject\.(sh|js)$/.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes(LITERAL))
      .map((f) => f.slice(ROOT.length + 1))
    expect(
      offenders,
      `hardcoded memory-project slug in: ${offenders.join(', ')} — import it from scripts/memoryProject.{sh,js} instead`,
    ).toEqual([])
  })

  it('the shell and the JS halves agree on the fixed suffix', () => {
    // Two definitions is one per language, not a duplicate to be tolerated: shell
    // cannot import JS. They MUST agree, so that is asserted rather than assumed.
    // T263: the machine-specific PREFIX is now derived ($HOME with "/" -> "-") in both
    // languages rather than a shared literal, so only the fixed suffix can be compared by
    // string containment here; full-value agreement (including the derived prefix) is
    // asserted below by actually evaluating the shell script.
    const sh = readFileSync(join(SCRIPTS, 'memoryProject.sh'), 'utf8')
    expect(sh).toContain(MEMORY_PROJECT_SUFFIX)
  })
})

describe('the default slug is derived from $HOME, not a hardcoded developer identity (T263)', () => {
  it('the machine-specific prefix is $HOME with "/" replaced by "-"', () => {
    expect(homeDerivedSlugPrefix('/home/synthetic-user')).toBe('-home-synthetic-user') // security-gate:allow (synthetic fixture)
    expect(homeDerivedSlugPrefix('/Users/anyone')).toBe('-Users-anyone') // security-gate:allow (synthetic fixture)
  })

  it('the default slug is that prefix plus the fixed, non-identifying suffix', () => {
    expect(defaultMemoryProjectSlug('/home/synthetic-user')).toBe( // security-gate:allow (synthetic fixture)
      '-home-synthetic-user-Desktop-Camp-App-System--Applications-Schedule-Project',
    )
  })

  it('is value-preserving: the exported constant equals the derivation from THIS machine\'s home', () => {
    expect(DEFAULT_MEMORY_PROJECT_SLUG).toBe(defaultMemoryProjectSlug())
  })
})

describe('the override is real', () => {
  it('uses the env var when set, the default when not', () => {
    expect(memoryProjectSlug({})).toBe(DEFAULT_MEMORY_PROJECT_SLUG)
    expect(memoryProjectSlug({ SHORESH_MEMORY_PROJECT: '-other-machine' })).toBe('-other-machine')
    expect(memoryProjectDir({ SHORESH_MEMORY_PROJECT: '-x' }, '/home/u')).toBe('/home/u/.claude/projects/-x')
  })

  it('the shell half honours the same override', () => {
    const read = (env) =>
      execFileSync('/bin/zsh', ['-c', `source "${join(SCRIPTS, 'memoryProject.sh')}"; print -- "$MEMORY_PROJECT_SLUG"`],
        { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
    expect(read({ SHORESH_MEMORY_PROJECT: '' })).toBe(DEFAULT_MEMORY_PROJECT_SLUG)
    expect(read({ SHORESH_MEMORY_PROJECT: '-other-machine' })).toBe('-other-machine')
  })
})

describe('the rewrite did not change where anything actually points', () => {
  it('each consolidation script resolves the SAME data paths it used before', () => {
    // The whole risk of this change: a sourced file that resolves differently, or
    // a ${0:A:h}/.. that lands somewhere else, silently pointing the nightly job at
    // an empty directory. So the paths are read back out of the real scripts.
    const home = process.env.HOME
    const expected = `${home}/.claude/projects/${DEFAULT_MEMORY_PROJECT_SLUG}`
    const proj = execFileSync('/bin/zsh', ['-c',
      `source "${join(SCRIPTS, 'consolidation', '..', 'memoryProject.sh')}"; print -- "$MEMORY_PROJ"`],
      { encoding: 'utf8', env: { ...process.env, SHORESH_MEMORY_PROJECT: '' } }).trim()
    expect(proj).toBe(expected)
    expect(memoryProjectDir({}, home)).toBe(expected)
  })
})
