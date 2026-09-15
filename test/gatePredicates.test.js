import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// T168. scripts/gate.sh's final line used to be
//   grep -c ... >/dev/null 2>&1 && exit 0 || exit 0
// which exits 0 on BOTH branches — the gate reported success no matter what the results file
// said. Both predicates below are exercised only against fixtures; no real gate is run.

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const RESULT_CODE = join(ROOT, 'scripts', 'gateResultCode.sh')
const SPEC_COUNT = join(ROOT, 'scripts', 'gateSpecCount.sh')
const results = (n) => join(HERE, 'fixtures', 'gateResults', n)
const specDir = (n) => join(HERE, 'fixtures', 'specDirs', n)

function resultCode(fixture) {
  const r = spawnSync('/bin/zsh', [RESULT_CODE, fixture], { encoding: 'utf8' })
  return r.status
}

function specCount(dir) {
  const r = spawnSync('/bin/zsh', [SPEC_COUNT, dir], { encoding: 'utf8' })
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('gate.sh exit-code predicate (scripts/gateResultCode.sh)', () => {
  it('exits 0 when every STEP passed', () => {
    expect(resultCode(results('all-pass.txt'))).toBe(0)
  })

  it('exits 1 when a STEP failed with rc=1', () => {
    expect(resultCode(results('rc1.txt'))).toBe(1)
  })

  it('exits 1 when a STEP failed with rc=127 (missing binary)', () => {
    expect(resultCode(results('rc127.txt'))).toBe(1)
  })

  it('exits 1 when a STEP failed with rc=143 (killed)', () => {
    expect(resultCode(results('rc143.txt'))).toBe(1)
  })

  // This is the exact defect: `grep -c ... && exit 0 || exit 0` always exits 0. Reintroducing
  // it must fail this suite.
  it('the buggy "always exit 0" form would wrongly pass a failing results file', () => {
    // Demonstrate the bug directly, to prove the test bites: the historical one-liner ignores
    // its own grep result and always exits 0, even against a results file with a failing step.
    const buggy = spawnSync(
      '/bin/zsh',
      ['-c', `grep -c '^STEP .* rc=[1-9]' "$1" >/dev/null 2>&1 && exit 0 || exit 0`, '--', results('rc1.txt')],
      { encoding: 'utf8' }
    )
    expect(buggy.status).toBe(0) // the bug: a failing results file still reports success
    expect(resultCode(results('rc1.txt'))).toBe(1) // the fix: gateResultCode.sh catches it
  })
})

describe('gate.sh zero-spec abort predicate (scripts/gateSpecCount.sh)', () => {
  it('exits non-zero and prints nothing to stdout when no test files are discoverable', () => {
    const { rc, stdout } = specCount(specDir('none-found'))
    expect(rc).not.toBe(0)
    expect(stdout.trim()).toBe('')
  })

  it('exits 0 and lists files when test files exist', () => {
    const { rc, stdout } = specCount(specDir('has-tests'))
    expect(rc).toBe(0)
    expect(stdout).toContain('foo.test.js')
  })

  // Red Hat's actual finding: a gate that ran zero test chunks still satisfied
  // lint+integration+security+governance and reported PASS. The caller (gate.sh) relies on
  // gateSpecCount.sh's non-zero exit to abort BEFORE the evidence file is written — assert the
  // predicate itself never silently returns "found files" for an empty tree.
  it('a directory with zero test files is never reported as having any', () => {
    const { stdout } = specCount(specDir('none-found'))
    expect(stdout.split('\n').filter(Boolean)).toHaveLength(0)
  })
})
