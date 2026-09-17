// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  lockDecision, parseHolder, serializeHolder, lockPath, repoKey, acquire, release, processAlive,
} from './gateLock.js'

const files = []
function tmpLock() {
  const f = path.join(os.tmpdir(), `gatelock-test-${process.pid}-${Date.now()}-${Math.random()}.lock`)
  files.push(f)
  return f
}
afterEach(() => {
  for (const f of files.splice(0)) fs.rmSync(f, { force: true })
})

describe('lockDecision', () => {
  it('acquires when no lock exists', () => {
    expect(lockDecision({ exists: false })).toBe('acquire')
  })

  it('waits for a live holder', () => {
    expect(lockDecision({ exists: true, holder: { pid: 1 }, holderAlive: true })).toBe('wait')
  })

  it('takes over a lock whose owner is gone — a killed gate must not wedge the next one', () => {
    expect(lockDecision({ exists: true, holder: { pid: 999999 }, holderAlive: false })).toBe('take-stale')
  })

  it('takes over an unreadable lock rather than waiting forever on it', () => {
    // A truncated or corrupt file must not be able to block every future gate.
    expect(lockDecision({ exists: true, holder: null, holderAlive: false })).toBe('take-stale')
  })
})

describe('holder serialisation', () => {
  it('round-trips', () => {
    const h = { pid: 42, startedAt: '2026-09-16T00:00:00.000Z', cwd: '/x' }
    expect(parseHolder(serializeHolder(h))).toEqual(h)
  })

  it('returns null on garbage instead of throwing', () => {
    expect(parseHolder('not json')).toBeNull()
    expect(parseHolder('')).toBeNull()
    expect(parseHolder('{"no":"pid"}')).toBeNull()
  })
})

describe('processAlive', () => {
  it('sees this process', () => {
    expect(processAlive(process.pid)).toBe(true)
  })

  it('does not see an impossible pid', () => {
    expect(processAlive(2 ** 30)).toBe(false)
  })
})

describe('repoKey / lockPath', () => {
  it('is identical from two directories in the same repository — one lock per repo, not per worktree', () => {
    // The whole point of keying on the git COMMON dir: every worktree of this repository resolves
    // the same key, because the contention is for the machine's cores rather than for a branch.
    //
    // This asserted that against a HARDCODED '/Users/gregfeitel/dev/shoresh' until CI caught it:
    // on a runner that path does not exist, repoKey fell back to 'shoresh_default', and the test
    // failed comparing a real key to the fallback. A test for machine-independent behaviour must
    // not itself name one machine. Two directories inside whatever repo is actually being tested
    // prove the same property and travel.
    const fromRoot = repoKey(process.cwd())
    const fromSubdir = repoKey(path.join(process.cwd(), 'scripts'))
    expect(fromRoot).toBe(fromSubdir)
    expect(fromRoot).not.toBe('shoresh_default') // a real repo, not the no-git fallback
  })

  it('falls back to a shared default outside a git repository, rather than throwing', () => {
    // A lock is still better than no lock when the repo cannot be identified.
    expect(repoKey(os.tmpdir())).toBe('shoresh_default')
  })

  it('produces a filesystem-safe path', () => {
    expect(path.basename(lockPath(repoKey()))).toMatch(/^shoresh-verify-[A-Za-z0-9_]+\.lock$/)
  })
})

describe('acquire / release', () => {
  it('acquires a free lock and writes this process as the holder', () => {
    const f = tmpLock()
    const rel = acquire({ file: f })
    expect(fs.existsSync(f)).toBe(true)
    expect(parseHolder(fs.readFileSync(f, 'utf8')).pid).toBe(process.pid)
    rel()
    expect(fs.existsSync(f)).toBe(false)
  })

  it('takes over a stale lock left by a dead process, and says nothing about waiting', () => {
    const f = tmpLock()
    fs.writeFileSync(f, serializeHolder({ pid: 2 ** 30, startedAt: 'x', cwd: '/gone' }))
    let waited = false
    const rel = acquire({ file: f, onWait: () => { waited = true }, sleep: () => {} })
    expect(waited).toBe(false) // a dead holder is taken over, never waited on
    expect(parseHolder(fs.readFileSync(f, 'utf8')).pid).toBe(process.pid)
    rel()
  })

  it('waits while a live holder is present, and announces the wait exactly once', () => {
    const f = tmpLock()
    // A live holder that this process does not own: use the real parent pid.
    fs.writeFileSync(f, serializeHolder({ pid: process.ppid, startedAt: 'x', cwd: '/other' }))
    let announcements = 0
    let polls = 0
    const rel = acquire({
      file: f,
      onWait: () => { announcements += 1 },
      // Simulate the holder finishing after a few polls, so the loop terminates.
      sleep: () => { polls += 1; if (polls === 3) fs.rmSync(f, { force: true }) },
    })
    expect(announcements).toBe(1) // announced once, not once per poll
    expect(polls).toBe(3)
    expect(parseHolder(fs.readFileSync(f, 'utf8')).pid).toBe(process.pid)
    rel()
  })

  it('release does NOT remove a lock another process has since taken over', () => {
    const f = tmpLock()
    fs.writeFileSync(f, serializeHolder({ pid: process.ppid, startedAt: 'x', cwd: '/other' }))
    release(f) // we are not the holder
    expect(fs.existsSync(f)).toBe(true)
  })
})
