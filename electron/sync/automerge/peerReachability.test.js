// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createPeerReachabilityTracker, PEERS_UNREACHABLE_AFTER_MS } from './peerReachability.js'

function tracker() {
  let t = 0
  const timers = []
  const crossed = []
  const tr = createPeerReachabilityTracker({
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length },
    clearTimer: () => {},
    onThresholdCrossed: () => crossed.push(t),
  })
  return { tr, advance: (ms) => { t += ms }, timers, crossed }
}

const ALONE = { nodeRunning: true, otherDeviceCount: 1, peerReachable: false }

describe('peer reachability flag (device offline through a revoke cannot find its camp)', () => {
  it('is false at first, and true only after no camp peer has been reachable for the whole bound', () => {
    const { tr, advance } = tracker()
    expect(tr.update(ALONE)).toBe(false)
    advance(PEERS_UNREACHABLE_AFTER_MS - 1)
    expect(tr.update(ALONE)).toBe(false)
    advance(1)
    expect(tr.update(ALONE)).toBe(true)
  })

  it('no flag while a peer is reachable, and reaching one resets the clock', () => {
    const { tr, advance } = tracker()
    tr.update(ALONE)
    advance(PEERS_UNREACHABLE_AFTER_MS)
    expect(tr.update({ ...ALONE, peerReachable: true })).toBe(false)
    expect(tr.update(ALONE)).toBe(false)
    advance(PEERS_UNREACHABLE_AFTER_MS - 1)
    expect(tr.update(ALONE)).toBe(false)
  })

  it('no flag for a single-device camp, however long', () => {
    const { tr, advance } = tracker()
    tr.update({ ...ALONE, otherDeviceCount: 0 })
    advance(PEERS_UNREACHABLE_AFTER_MS * 10)
    expect(tr.update({ ...ALONE, otherDeviceCount: 0 })).toBe(false)
  })

  it('no flag when the sync node is not running (that is the sync-not-running flag, not this one)', () => {
    const { tr, advance } = tracker()
    tr.update({ ...ALONE, nodeRunning: false })
    advance(PEERS_UNREACHABLE_AFTER_MS * 2)
    expect(tr.update({ ...ALONE, nodeRunning: false })).toBe(false)
  })

  it('arms one timer so the status is re-pushed when the bound passes, even with no other event', () => {
    const { tr, timers, crossed } = tracker()
    tr.update(ALONE)
    tr.update(ALONE)
    expect(timers).toHaveLength(1)
    expect(timers[0].at).toBe(PEERS_UNREACHABLE_AFTER_MS)
    timers[0].fn()
    expect(crossed).toHaveLength(1)
  })

  it('a throwing status push is contained; it never escapes the timer', () => {
    const timers = []
    const tr = createPeerReachabilityTracker({
      now: () => 0,
      setTimer: (fn) => { timers.push(fn); return 1 },
      clearTimer: () => {},
      onThresholdCrossed: () => { throw new Error('window gone') },
    })
    tr.update(ALONE)
    expect(() => timers[0]()).not.toThrow()
  })
})
