// @vitest-environment node
//
// T354 (absorbs T348 round 4): sessionOnFreePort serves pinned-port waiters in ARRIVAL order.
// Two waiters released by the same close compute timers to the same instant; Node gives no
// ordering guarantee between timers that expire together (they sit in per-duration lists), so
// the later arrival can run first. This drives a manual clock and manual timers, so the
// adversarial firing order is chosen, not hoped for - no wall time, no sleeps.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { punchTransport } from './punchTransport.js'

const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
const components = { logger: { forComponent: () => noop } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function manualTime(start) {
  let now = start
  let seq = 0
  let timers = []
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('setTimeout', (fn, ms) => {
    const t = { fn, at: now + ms, id: ++seq }
    timers.push(t)
    return t
  })
  vi.stubGlobal('clearTimeout', (t) => { timers = timers.filter((x) => x !== t) })
  return {
    pending: () => [...timers],
    async fire(t) {
      timers = timers.filter((x) => x !== t)
      now = Math.max(now, t.at)
      t.fn()
      await flush()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function pinnedTransport() {
  const t = punchTransport({
    signaling: { sendSignal() {}, onSignal: () => () => {} },
    portRange: { begin: 50123, end: 50123 },
    ice: { iceUfrag: 'abcd', icePwd: 'p'.repeat(22) },
  })(components)
  const taken = []
  t.newSession = (args) => {
    taken.push(args.sid)
    const s = { sid: args.sid, whenClosed: new Promise(() => {}) }
    t.sessions.set(args.sid, s)
    return s
  }
  return { t, taken }
}

describe('sessionOnFreePort ordering', () => {
  it('serves the earlier waiter first even when the later waiter timer fires first', async () => {
    const time = manualTime(1_000_000)
    const { t, taken } = pinnedTransport()
    t.lastCloseAt = 1_000_000
    const a = t.sessionOnFreePort({ sid: 'A' }, { timeoutMs: 60_000 })
    const abortB = new AbortController()
    const b = t.sessionOnFreePort({ sid: 'B' }, { timeoutMs: 60_000, signal: abortB.signal })
    b.catch(() => {})
    await flush()
    const [timerA, timerB] = time.pending()
    expect(timerA.at).toBe(timerB.at)

    await time.fire(timerB)
    expect(taken).toEqual([])
    await time.fire(timerA)
    await a
    expect(taken).toEqual(['A'])

    abortB.abort()
    for (const tm of time.pending()) await time.fire(tm)
    await expect(b).rejects.toThrow()
    expect(taken).toEqual(['A'])
  })
})
