// @vitest-environment node
//
// T233 round 2, finding 2: the purge/rebuild advisory lock. Unit-level coverage for the primitive
// itself; purgeSupportCommand.test.js covers it wired into purgeCamperRecord.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireSupportCommandLock, SupportCommandLockedError } from './supportCommandLock.js'

let dbPaths = []
afterEach(() => {
  for (const p of dbPaths) {
    const key = p.replace(/[^a-zA-Z0-9]/g, '_').slice(-120)
    const lockFile = path.join(os.tmpdir(), `shoresh-support-command-lock-${key}.lock`)
    try { fs.rmSync(lockFile, { force: true }) } catch { /* already gone */ }
  }
  dbPaths = []
})

function fakeDbPath(tag) {
  const p = path.join(os.tmpdir(), `shoresh-lock-test-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  dbPaths.push(p)
  return p
}

describe('acquireSupportCommandLock', () => {
  it('acquires immediately when no lock exists, and release() lets a second acquire succeed', () => {
    const dbPath = fakeDbPath('basic')
    const release = acquireSupportCommandLock(dbPath)
    release()
    const release2 = acquireSupportCommandLock(dbPath)
    release2()
  })

  it('refuses deterministically when the lock is held by a live process', () => {
    const dbPath = fakeDbPath('held')
    const release = acquireSupportCommandLock(dbPath)
    try {
      expect(() => acquireSupportCommandLock(dbPath, { timeoutMs: 50, pollMs: 10 }))
        .toThrow(SupportCommandLockedError)
      expect(() => acquireSupportCommandLock(dbPath, { timeoutMs: 50, pollMs: 10 }))
        .toThrow(/another purge or rebuild is already running/)
    } finally {
      release()
    }
  })

  it('takes over a stale lock left by a dead pid instead of waiting forever', () => {
    const dbPath = fakeDbPath('stale')
    const key = dbPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-120)
    const lockFile = path.join(os.tmpdir(), `shoresh-support-command-lock-${key}.lock`)
    // A pid essentially guaranteed not to be alive on this machine.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }))
    const release = acquireSupportCommandLock(dbPath, { timeoutMs: 1000, pollMs: 10 })
    release()
  })
})
