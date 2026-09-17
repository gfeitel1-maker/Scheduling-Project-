// A machine-wide mutex so only one `npm run verify` runs at a time.
//
// WHY: the gate is ~17 minutes of mostly-CPU work on a 4-core machine that also runs the editor,
// the app, and every concurrent agent session. "One gate at a time" was a convention with nothing
// enforcing it. Observed 2026-09-16: three `node scripts/verify.js` processes running at once from
// three different worktrees, 1-minute load average 267, thirteen vitest workers. Under that
// contention every one of those gates runs several times slower than it would alone.
//
// Serialising is not merely politer, it is strictly better for everyone. Three gates run
// concurrently all finish around T+51min; run in sequence, the first finishes at T+17 and the last
// still finishes around T+51. Same total, but two of the three get their answer sooner, and none of
// them thrashes memory against the other two. A convention cannot deliver that, because the session
// that ignores it is rewarded — which is exactly what was observed: a session that waited 20 minutes
// for a free slot had two others start within seconds of it finally starting.
//
// The lock is keyed to the git COMMON directory, so every worktree of this repository shares one
// lock (the contention is for the machine's cores, not for a branch). A stale lock — one whose owner
// died without releasing — is detected by probing the pid and is taken over rather than waited on,
// so a killed gate never wedges the next one.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const WAIT_POLL_MS = 5_000

// One lock per repository, shared across its worktrees. `git rev-parse --git-common-dir` resolves to
// the SAME directory from the main checkout and from every worktree, which is exactly the grouping
// wanted. Falls back to a fixed name if git is unavailable — a shared lock is still better than none.
export function repoKey(cwd = process.cwd()) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return dir.replace(/[^a-zA-Z0-9]/g, '_').slice(-80)
  } catch {
    return 'shoresh_default'
  }
}

export function lockPath(key, tmp = os.tmpdir()) {
  return path.join(tmp, `shoresh-verify-${key}.lock`)
}

export function serializeHolder({ pid, startedAt, cwd }) {
  return JSON.stringify({ pid, startedAt, cwd }, null, 0)
}

// Tolerant by design: a corrupt or truncated lock file must not crash the gate. An unparseable
// holder is treated as "unknown", and an unknown holder whose pid cannot be probed is stale.
export function parseHolder(text) {
  try {
    const h = JSON.parse(text)
    return typeof h?.pid === 'number' ? h : null
  } catch {
    return null
  }
}

// Pure: given what is on disk and whether that owner is alive, what should we do?
// Separated from the filesystem so the three branches are testable without spawning processes.
export function lockDecision({ exists, holder, holderAlive }) {
  if (!exists) return 'acquire'
  if (!holder) return 'take-stale' // unreadable lock — treat as abandoned rather than wedge forever
  if (!holderAlive) return 'take-stale'
  return 'wait'
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0) // signal 0 probes existence without touching the process
    return true
  } catch {
    return false
  }
}

function readHolder(file) {
  try {
    return parseHolder(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Try once to create the lock. 'wx' fails if the file exists, which is the atomic part — two
// processes racing here cannot both succeed.
function tryCreate(file) {
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(
      fd,
      serializeHolder({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() })
    )
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

// Acquire the lock, waiting for a live holder and taking over a dead one. `onWait` is called once
// per poll so the caller can tell the user why nothing is happening — a silent 20-minute wait is
// indistinguishable from a hang.
export function acquire({ file, onWait = () => {}, sleep = defaultSleep } = {}) {
  let announced = false
  for (;;) {
    if (tryCreate(file)) return () => release(file)
    const holder = readHolder(file)
    const decision = lockDecision({
      exists: true,
      holder,
      holderAlive: holder ? processAlive(holder.pid) : false,
    })
    if (decision === 'take-stale') {
      try { fs.rmSync(file, { force: true }) } catch { /* another waiter won the race; loop */ }
      continue
    }
    if (!announced) {
      onWait(holder)
      announced = true
    }
    sleep(WAIT_POLL_MS)
  }
}

// Only remove a lock we still own, so a takeover by a later process is never clobbered.
export function release(file) {
  const holder = readHolder(file)
  if (holder && holder.pid !== process.pid) return
  try { fs.rmSync(file, { force: true }) } catch { /* nothing to do */ }
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
