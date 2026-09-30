// @vitest-environment node
//
// THE MINING LOCK'S STALENESS PREDICATE, TESTED (T169).
//
// scripts/consolidation/mineFromPacket.sh takes a `mkdir`-style lock per day and releases it
// via `rmdir`/`rm -rf` on every normal exit path plus a `trap ... EXIT INT TERM`. A `kill -9`
// bypasses the trap and leaves the lock directory on disk forever — every future run for that
// day then reads the `mkdir` failure as "another recovery is running" and SKIPs, permanently
// and silently.
//
// scripts/consolidation/lockIsStale.sh is the pure predicate the miner consults before treating
// a held lock as abandoned. Following gateResultCode.sh's lesson: this must answer three ways,
// not two — stale, not-stale, and CANNOT TELL — because folding "cannot tell" into either
// answer is exactly how absence becomes a licence to act.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/consolidation/lockIsStale.sh')

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-stale-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

// Runs the real script and returns its exit code. Never throws on non-zero —
// the exit code IS the thing under test.
function run(args) {
  try {
    execFileSync('/bin/zsh', [SCRIPT, ...args], { stdio: 'pipe' })
    return 0
  } catch (err) {
    return err.status
  }
}

function makeLock(name) {
  const p = path.join(dir, name)
  fs.mkdirSync(p)
  return p
}

// Sets an mtime two days in the past using `touch -t` — never sleep, never fake the
// script's notion of "now".
function ageLock(lockPath, daysAgo) {
  const stamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  const yyyy = stamp.getFullYear()
  const MM = String(stamp.getMonth() + 1).padStart(2, '0')
  const dd = String(stamp.getDate()).padStart(2, '0')
  const hh = String(stamp.getHours()).padStart(2, '0')
  const mm = String(stamp.getMinutes()).padStart(2, '0')
  execFileSync('touch', ['-t', `${yyyy}${MM}${dd}${hh}${mm}`, lockPath])
}

describe('lockIsStale.sh — stale, not-stale, and cannot tell', () => {
  it('a fresh lock (just created) is not stale', () => {
    expect(run([makeLock('fresh.lock')])).toBe(1)
  })

  it('a lock aged two days back is stale', () => {
    const lock = makeLock('old.lock')
    ageLock(lock, 2)
    expect(run([lock])).toBe(0)
  })

  it('a missing lock is not stale — nothing to break', () => {
    expect(run([path.join(dir, 'nope.lock')])).toBe(1)
  })

  it('no argument at all is cannot-tell (2), never stale', () => {
    expect(run([])).toBe(2)
  })

  it('a non-numeric max-age argument is cannot-tell (2)', () => {
    const lock = makeLock('weird-age.lock')
    expect(run([lock, 'banana'])).toBe(2)
  })

  it('respects a custom max-age: a lock aged 2 days is not stale under a 10-day threshold', () => {
    const lock = makeLock('under-threshold.lock')
    ageLock(lock, 2)
    expect(run([lock, String(10 * 24 * 60 * 60)])).toBe(1)
  })

  it('distinguishes stale from missing, because the caller responds differently', () => {
    const stale = makeLock('stale-for-diff.lock')
    ageLock(stale, 2)
    expect(run([stale])).toBe(0)
    expect(run([path.join(dir, 'absent-for-diff.lock')])).toBe(1)
  })
})
