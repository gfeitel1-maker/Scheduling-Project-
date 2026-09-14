// Warn about a disk that is nearly full, BEFORE it is full.
//
// The reason this exists is a limit found while hardening the write path
// (T148): every safeguard that records a failed document write is itself a
// write, to the same disk that just refused one. On a genuinely full disk the
// whole mechanism degrades to console lines — it now tags them so they can be
// tied together and says plainly when nothing durable landed, but it cannot fix
// itself with no space to write into.
//
// Nothing can, on a full disk. What works is not being surprised by one. So
// this is the only useful lever: notice the disk getting low while there is
// still room to act, and put it where the director already looks.
//
// Pure and injectable — no Electron, no module-level clock — so the threshold
// and the throttle are testable without a real filesystem.
import fs from 'node:fs'

// 500 MB. Chosen against what this app actually writes: a camp's SQLite and its
// Automerge document are measured in megabytes, so 500 MB is many times the
// headroom a save needs. Much lower and the warning arrives too late to act on;
// much higher and it nags on a normally-loaded laptop, which trains people to
// ignore it — and a warning that is ignored is worse than no warning, because
// it looks like coverage.
export const LOW_DISK_BYTES = 500 * 1024 * 1024

// Checking free space means a syscall. The write path can call this thousands
// of times during an import, and disk usage does not change meaningfully in a
// second, so the answer is cached.
export const DISK_CHECK_INTERVAL_MS = 60_000

/**
 * Free bytes on the filesystem holding `dir`, or null if it cannot be measured.
 *
 * Never throws: this is a diagnostic, and a diagnostic that can break the thing
 * it is diagnosing is not worth having. A null answer means "unknown", which
 * callers must render as silence rather than as reassurance.
 */
export function freeBytesFor(dir, { statfs = fs.statfsSync } = {}) {
  try {
    const s = statfs(dir)
    if (!s || typeof s.bfree !== 'number' || typeof s.bsize !== 'number') return null
    return s.bfree * s.bsize
  } catch {
    return null
  }
}

/** null (unknown) is NOT low — see freeBytesFor. */
export function isLowDisk(freeBytes, { threshold = LOW_DISK_BYTES } = {}) {
  return typeof freeBytes === 'number' && freeBytes < threshold
}

/**
 * A throttled reader. Returns `{ freeBytes, low }`, recomputing at most once
 * per DISK_CHECK_INTERVAL_MS.
 *
 * `now` and `statfs` are injected so a test can advance time without waiting
 * and without a real disk.
 */
export function createDiskSpaceMonitor({
  dir,
  threshold = LOW_DISK_BYTES,
  intervalMs = DISK_CHECK_INTERVAL_MS,
  now = () => Date.now(),
  statfs = fs.statfsSync,
} = {}) {
  let lastCheckedAt = null
  let cached = { freeBytes: null, low: false }

  return {
    read() {
      const t = now()
      if (lastCheckedAt !== null && t - lastCheckedAt < intervalMs) return cached
      lastCheckedAt = t
      const freeBytes = freeBytesFor(dir, { statfs })
      cached = { freeBytes, low: isLowDisk(freeBytes, { threshold }) }
      return cached
    },
    // For a caller that has just seen a write fail and wants the current answer
    // rather than a cached one — the throttle exists for the hot path, not for
    // the moment something has already gone wrong.
    readFresh() {
      lastCheckedAt = now()
      const freeBytes = freeBytesFor(dir, { statfs })
      cached = { freeBytes, low: isLowDisk(freeBytes, { threshold }) }
      return cached
    },
  }
}
