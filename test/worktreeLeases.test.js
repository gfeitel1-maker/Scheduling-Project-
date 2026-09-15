import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// T168. scripts/integration.sh runs unattended at 06:30 and DELETES worktree directories. The
// ledger reader is the only thing that stops it deleting one Claude Desktop still expects to
// reuse, and until now it had no test — every defect in it was found by reading.
//
// The exit code is the contract, not the stdout: "0 paths because the ledger is empty" and
// "0 paths because the schema moved" must never look the same, or the guard silently stops
// working and the morning report looks healthy while pruning runs unprotected.

const HERE = dirname(fileURLToPath(import.meta.url))
const READER = join(HERE, '..', 'scripts', 'readWorktreeLeases.py')
const fixture = (n) => join(HERE, 'fixtures', 'ledgers', n)

function read(path) {
  const r = spawnSync('/usr/bin/python3', [READER, path], { encoding: 'utf8' })
  return { rc: r.status, paths: r.stdout.split('\n').filter(Boolean) }
}

describe('worktree lease reader', () => {
  it('returns every tracked path on a healthy ledger', () => {
    const { rc, paths } = read(fixture('healthy.json'))
    expect(rc).toBe(0)
    expect(paths).toHaveLength(2)
  })

  // The task brief named this path class as real; awk's default field split truncated it at
  // the space, which would have silently defeated the exact-match protection downstream.
  it('preserves a path containing a space', () => {
    const { paths } = read(fixture('healthy.json'))
    expect(paths).toContain('/Users/x/dev/Mobile Prototype/.claude/worktrees/b')
  })

  it('an empty ledger is rc=0 with no paths — healthy, nothing leased', () => {
    expect(read(fixture('empty.json'))).toEqual({ rc: 0, paths: [] })
  })

  it('a torn or truncated read is rc=3, never mistaken for healthy', () => {
    expect(read(fixture('torn.json')).rc).toBe(3)
  })

  it('an absent ledger is rc=3', () => {
    expect(read(fixture('definitely-not-here.json')).rc).toBe(3)
  })

  // The finding this whole exit-code contract exists for.
  it('schema drift is rc=4 — DISTINCT from an empty ledger, not a silent zero', () => {
    const drift = read(fixture('schema-drift.json'))
    const empty = read(fixture('empty.json'))
    expect(drift.rc).toBe(4)
    expect(drift.paths).toEqual([])
    expect(empty.paths).toEqual([])
    expect(drift.rc).not.toBe(empty.rc) // identical stdout; only the code tells them apart
  })

  it('skips ragged entries without failing the whole read', () => {
    const { rc, paths } = read(fixture('ragged.json'))
    expect(rc).toBe(0)
    expect(paths).toEqual(['/ok'])
  })
})
