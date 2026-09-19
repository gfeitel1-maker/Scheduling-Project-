// T233 round 2, finding 2 (docs/adr/2026-09-19-multi-device-erasure-propagation.md "Residual
// risks" — concurrency): a per-device purge/regen serialization lock the ADR required but the
// first implementation never built. purgeCamperRecord and rebuildProjectionFromDocumentAtPath
// both unlink-and-recreate the whole SQLite file at dbPath; two of them racing (two purges, or a
// purge racing an ordinary rebuild) on the same file can corrupt it.
//
// Modeled on scripts/gateLock.js's own design (atomic `wx` create, probe-and-take-over a dead
// holder's pid so a killed process never wedges the next one) — kept as its own small file rather
// than importing scripts/gateLock.js, which is dev-tooling keyed to the repository as a whole
// (one lock per checkout), not to an arbitrary db path, and not meant to be an electron runtime
// dependency.
//
// SCOPE (documented per the brief, not silently assumed): this lock only serializes the purge and
// rebuild SUPPORT COMMANDS against each other. It does NOT make the app's hot projectAll/sync path
// lock-aware — that would be a much larger change to a hot path, out of scope for this ticket.
// purge-vs-live-app-sync is covered operationally instead: both purge and rebuild are offline
// support commands a person runs deliberately (see rebuildSupportCommand.js's own header), not
// something that fires during normal app operation, so the realistic race this lock prevents is
// two support commands run back-to-back or from two terminals — not a purge racing a live sync.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function lockPathFor(dbPath) {
  const key = dbPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-120)
  return path.join(os.tmpdir(), `shoresh-support-command-lock-${key}.lock`)
}

function processAlive(pid) {
  try {
    process.kill(pid, 0) // signal 0 probes existence without touching the process
    return true
  } catch {
    return false
  }
}

function readHolder(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof parsed?.pid === 'number' ? parsed : null
  } catch {
    return null
  }
}

function tryCreate(file) {
  try {
    const fd = fs.openSync(file, 'wx') // fails if the file exists — the atomic part
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

function release(file) {
  const holder = readHolder(file)
  if (holder && holder.pid !== process.pid) return // a takeover by a later process — don't clobber it
  try { fs.rmSync(file, { force: true }) } catch { /* nothing to do */ }
}

export class SupportCommandLockedError extends Error {}

// Blocks (synchronously — this runs in the main/support-command process, not the UI thread, and
// these commands are already expected to block their caller for their whole duration) until the
// lock is acquired or timeoutMs elapses, whichever comes first. Returns a release() function.
export function acquireSupportCommandLock(dbPath, { timeoutMs = 30_000, pollMs = 100 } = {}) {
  const file = lockPathFor(dbPath)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (tryCreate(file)) return () => release(file)
    const holder = readHolder(file)
    if (!holder || !processAlive(holder.pid)) {
      try { fs.rmSync(file, { force: true }) } catch { /* another waiter won the race; loop */ }
      continue
    }
    if (Date.now() > deadline) {
      throw new SupportCommandLockedError(
        `Refusing: another purge or rebuild is already running against ${dbPath} (held by pid ` +
          `${holder.pid}). These commands rewrite the whole database file and cannot run ` +
          'concurrently — wait for it to finish and retry.'
      )
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs)
  }
}
