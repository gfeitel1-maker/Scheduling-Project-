// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  freeBytesFor,
  isLowDisk,
  createDiskSpaceMonitor,
  LOW_DISK_BYTES,
  DISK_CHECK_INTERVAL_MS,
} from './diskSpace.js'

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024
const statfsOf = (freeBytes) => () => ({ bfree: freeBytes / 4096, bsize: 4096 })

describe('freeBytesFor', () => {
  it('reads a real directory without throwing', () => {
    expect(typeof freeBytesFor(process.cwd())).toBe('number')
  })

  it('answers UNKNOWN rather than throwing when the filesystem cannot be read', () => {
    // A diagnostic that can break the thing it diagnoses is not worth having.
    expect(freeBytesFor('/definitely/not/a/path/here')).toBeNull()
    expect(freeBytesFor(process.cwd(), { statfs: () => { throw new Error('EIO') } })).toBeNull()
    expect(freeBytesFor(process.cwd(), { statfs: () => ({}) })).toBeNull()
  })
})

describe('isLowDisk', () => {
  it('is true below the threshold and false above it', () => {
    expect(isLowDisk(100 * MB)).toBe(true)
    expect(isLowDisk(2 * GB)).toBe(false)
    expect(isLowDisk(LOW_DISK_BYTES - 1)).toBe(true)
    expect(isLowDisk(LOW_DISK_BYTES)).toBe(false)
  })

  it('UNKNOWN is not low — silence, never reassurance', () => {
    // The distinction that matters: "we could not measure" must not render as
    // "you have plenty of room".
    expect(isLowDisk(null)).toBe(false)
    expect(isLowDisk(undefined)).toBe(false)
  })
})

describe('createDiskSpaceMonitor', () => {
  it('does not re-measure inside the throttle window', () => {
    let calls = 0
    let t = 1000
    const monitor = createDiskSpaceMonitor({
      dir: '/x', now: () => t,
      statfs: () => { calls += 1; return { bfree: 1, bsize: 4096 } },
    })
    monitor.read()
    monitor.read()
    t += DISK_CHECK_INTERVAL_MS - 1
    monitor.read()
    expect(calls).toBe(1)
  })

  it('re-measures once the window has passed, and notices the disk filling', () => {
    let t = 0
    let free = 2 * GB
    const monitor = createDiskSpaceMonitor({ dir: '/x', now: () => t, statfs: () => statfsOf(free)() })
    expect(monitor.read().low).toBe(false)
    free = 100 * MB
    t += DISK_CHECK_INTERVAL_MS
    expect(monitor.read().low).toBe(true)
  })

  it('readFresh ignores the throttle — the moment something failed is not the hot path', () => {
    let calls = 0
    const monitor = createDiskSpaceMonitor({
      dir: '/x', now: () => 0,
      statfs: () => { calls += 1; return statfsOf(100 * MB)() },
    })
    monitor.read()
    monitor.readFresh()
    expect(calls).toBe(2)
    expect(monitor.readFresh().low).toBe(true)
  })
})
