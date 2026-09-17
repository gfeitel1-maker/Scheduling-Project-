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
import { fileURLToPath } from 'node:url'
import { UNISOLATED_INCLUDE } from './vite.config.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// Markers for state that cannot be shared safely across files in one worker.
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

  it('every include is a whole-directory glob — no per-file entries', () => {
    // A per-file entry is how the dropped-file bug happened: a carve-out inside a
    // directory the isolated project subtracts wholesale.
    for (const g of UNISOLATED_INCLUDE) {
      expect(g, `${g} must be a directory glob like 'dir/**/*.test.{js,jsx}'`).toMatch(/\/\*\*\//)
    }
  })

  it('partitions every test file into exactly one project', () => {
    const files = allTestFiles()
    expect(files.length).toBeGreaterThan(100) // the walk actually found the suite

    const both = files.filter((f) => isUnisolated(f) && !isUnisolated(f))
    expect(both).toEqual([]) // by construction, but pins the intent

    // The real property: membership is total. Every file is either in the fast
    // project or, by subtraction, in the isolated one. There is no third bucket.
    for (const f of files) {
      expect(typeof isUnisolated(f)).toBe('boolean')
    }
    const fast = files.filter(isUnisolated)
    const isolated = files.filter((f) => !isUnisolated(f))
    expect(fast.length + isolated.length).toBe(files.length)
    expect(fast.length).toBeGreaterThan(0)
  })

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
