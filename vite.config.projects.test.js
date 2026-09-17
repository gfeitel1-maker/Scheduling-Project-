// @vitest-environment node
//
// Guards the two-project split in vite.config.js (T188 §6 / F3).
//
// The `pure` project runs without per-file process isolation, which is what makes it
// ~4.7x faster and also what makes it dangerous: test files in one worker share a
// module registry, so module-level state leaks between them.
//
// Two properties have to hold, and neither fails loudly on its own.
//
// 1. THE PROJECTS MUST PARTITION THE SUITE. The first draft of the split did not: it
//    listed src/engine in the fast project's includes with a single-file carve-out,
//    and because the isolated project is defined by SUBTRACTING those includes, the
//    carved-out file was excluded from both. It ran nowhere. A test that does not run
//    does not fail, so nothing reported it — it was found by diffing collected files
//    before and after the config change. This test is that diff, made permanent.
//
// 2. EVERY FILE IN THE FAST PROJECT MUST BE PURE. The exemption is granted by
//    DIRECTORY, so it applies to files that do not exist yet. Someone adding a
//    database-backed test under src/ingest/ would inherit the exemption silently.
//    This fails the build instead.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { UNISOLATED_INCLUDE } from './vite.config.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// Markers for state that cannot be shared safely across files in one worker.
//
// HONEST LIMITATION, stated because the config comment next door rejects exactly this
// shape of rule: this list is itself a DENYLIST, and denylists fail open. It greps test
// files for known hazards; it cannot see module-level mutable state in a NON-test module
// that several ingest tests import — a memoised Map in a parser would be invisible to it.
//
// It is acceptable here only because it is the SECONDARY control. The primary one is the
// whole-directory allowlist in vite.config.js, which is reviewed by a human when it
// changes and is deliberately tiny. This list catches the common accident (someone adds
// a database-backed test to src/ingest) and is not claimed to prove purity.
//
// Red Hat audited src/ingest's non-test source directly on 2026-09-17 — module-scope
// `let`/`var`, exported mutable singletons, vi.mock/spyOn/useFakeTimers, process.env and
// process.chdir writes, top-level side effects — and found none. That audit, not this
// grep, is what "src/ingest is pure" currently rests on. Re-run it, do not trust this
// list, before adding a directory here.
const IMPURE_MARKERS = [
  'openLocalDb', 'openTemplatedDb', 'better-sqlite3', 'node:sqlite',
  'libp2p', 'WebSocket', 'child_process', 'jsdom', '@testing-library',
]

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', '.claude'])

function allTestFiles(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (full.includes(`${path.sep}test${path.sep}fixtures`)) continue
      allTestFiles(full, out)
      continue
    }
    if (/\.test\.jsx?$/.test(e.name)) out.push(path.relative(ROOT, full))
  }
  return out
}

// The fast project's includes are directory globs; match on the directory prefix
// rather than reimplementing glob semantics.
function unisolatedDirs() {
  return UNISOLATED_INCLUDE.map((g) => g.replace(/\/\*\*.*$/, ''))
}

function isUnisolated(rel) {
  return unisolatedDirs().some((d) => rel === d || rel.startsWith(d + '/'))
}

describe('vite.config.js project split', () => {
  it('exposes the fast-project include list', () => {
    expect(Array.isArray(UNISOLATED_INCLUDE)).toBe(true)
    expect(UNISOLATED_INCLUDE.length).toBeGreaterThan(0)
  })

  it('every include is a plain whole-directory glob', () => {
    // Two separate reasons, both learned the hard way.
    //
    // A PER-FILE ENTRY is how the dropped-file bug happened: a carve-out inside a
    // directory the isolated project subtracts wholesale.
    //
    // BRACE EXPANSION AND NEGATION are barred because `unisolatedDirs()` below strips
    // everything from the first `/**` and prefix-matches the remainder. For
    // `src/ingest/{a,b}/**/*.test.js` that yields the literal string `src/ingest/{a,b}`,
    // which matches no real path — so this guard would quietly conclude the fast project
    // is empty while vitest's real glob engine happily routes files into it. The guard
    // and the engine would disagree, silently, in the guard's favour. Rather than
    // reimplement vitest's matcher, the supported syntax is restricted to what a prefix
    // match provably handles. (Red Hat, 2026-09-17.)
    for (const g of UNISOLATED_INCLUDE) {
      expect(g, `${g} must be a directory glob like 'dir/**/*.test.{js,jsx}'`).toMatch(/\/\*\*\//)
      expect(g, `${g} must not use negation — the prefix matcher cannot honour it`).not.toMatch(/^!/)
      const dir = g.replace(/\/\*\*.*$/, '')
      expect(dir, `${g}: the part before /** must be a literal path, no glob syntax`).toMatch(/^[\w./-]+$/)
    }
  })

  // Asks VITEST what each project actually collects, rather than re-deriving it from
  // UNISOLATED_INCLUDE. That distinction is the whole point of this test, and the first
  // version of it got this wrong: it reimplemented the include-matching locally and then
  // asserted properties of its own reimplementation. Two of its assertions were literal
  // tautologies — `files.filter(f => isUnisolated(f) && !isUnisolated(f))` is `X && !X`,
  // always empty, unfailable — and none of them could have caught the actual incident
  // this file exists for, because that incident lived in the DISAGREEMENT between the
  // two projects' include/exclude arrays, which a local mirror of one array cannot see.
  //
  // Spawning vitest costs a few seconds. That is the price of testing the real thing;
  // the repo already spawns ESLint and the agent-profile generator in tests for the
  // same reason.
  function collect(project) {
    const out = execFileSync(
      'npx',
      ['vitest', 'list', '--filesOnly', ...(project ? ['--project', project] : [])],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return out
      .split('\n')
      .map((l) => l.replace(/^\[[a-z]+\]\s*/, '').trim())
      .filter(Boolean)
      .map((l) => path.relative(ROOT, path.resolve(ROOT, l)))
      .sort()
  }

  it('the two projects partition the suite: nothing in both, nothing in neither', () => {
    // GROUND TRUTH COMES FROM DISK, NOT FROM VITEST. `vitest list` with no --project
    // returns the UNION OF THE PROJECTS, so a file both projects drop also disappears
    // from that listing — comparing it against the two projects compares them with
    // themselves and can never fail. The first rewrite of this test did exactly that,
    // passed, and was only exposed by planting the bug it claimed to catch. The disk
    // walk is the only source here that does not depend on the config under test.
    const all = allTestFiles().sort()
    const pure = collect('pure')
    const isolated = collect('isolated')

    expect(all.length).toBeGreaterThan(100)
    expect(pure.length).toBeGreaterThan(0)

    // In BOTH — a file would run twice.
    const inBoth = pure.filter((f) => isolated.includes(f))
    expect(inBoth, 'these files are collected by both projects and would run twice').toEqual([])

    // In NEITHER — a file silently stops being tested. This is the real incident:
    // src/engine/fixtureSchemaParity.test.js was excluded from the fast project and,
    // because the isolated project subtracts the fast project's includes wholesale, from
    // that one too. Collection went 443 -> 442 and no test failed, because a test that
    // does not run cannot fail.
    const union = new Set([...pure, ...isolated])
    const inNeither = all.filter((f) => !union.has(f))
    expect(inNeither, 'these files are collected by NEITHER project and never run').toEqual([])

    // Not a complement identity: `all` is an independent disk walk, so this genuinely
    // constrains the two collections against it.
    expect(pure.length + isolated.length).toBe(all.length)
  }, 120000)

  it('every file in the unisolated project is pure', () => {
    const offenders = []
    for (const rel of allTestFiles().filter(isUnisolated)) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      const hits = IMPURE_MARKERS.filter((m) => src.includes(m))
      if (hits.length) offenders.push(`${rel} -> ${hits.join(', ')}`)
    }
    // A hit here means either the file belongs in the isolated project, or the
    // directory should not be in UNISOLATED_INCLUDE at all. It does NOT mean the
    // marker list should be trimmed to make this pass.
    expect(offenders).toEqual([])
  })
})
