// @vitest-environment node
//
// S4c: the ladder order and the rung-3 invariants. Rung 3 is observed through a network spy
// (rendezvous.request is the only way the coordinator can reach it).
import { describe, it, expect, vi } from 'vitest'
import { createReconnectCoordinator, RUNG3_WAIT_MS } from './reconnectCoordinator.js'
import { EVENTS, createConnectivityEmitter } from './connectivityEvents.js'

const PEER = { peerId: 'peer-b', deviceId: 'dev-b' }

function setup({ lan = false, r1 = false, r2 = false, withRendezvous = true, rung3Connects = false, lanGraceMs = 0, waitMdnsPass, attemptRung2: rung2Override } = {}) {
  const calls = []
  let connected = false
  let nowMs = 0
  const rendezvous = withRendezvous ? { request: vi.fn(() => calls.push('rung3-request')), release: vi.fn() } : null
  const events = []
  const timers = []
  const coord = createReconnectCoordinator({
    listPeers: () => [PEER],
    isConnected: () => connected,
    attemptLan: async () => { calls.push('lan'); return lan },
    attemptRung1: async () => { calls.push('rung1'); return { ok: r1 } },
    attemptRung2: rung2Override ? async (p) => { calls.push('rung2'); return rung2Override(p, { setConnected: (v) => { connected = v } }) } : async () => { calls.push('rung2'); return { ok: r2 } },
    rendezvous,
    emit: (name, fields) => events.push([name, fields]),
    rung3WaitMs: 90_000,
    lanGraceMs,
    waitMdnsPass,
    now: () => nowMs,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
    random: () => 1,
  })
  if (rung3Connects) rendezvous.request.mockImplementation(() => { calls.push('rung3-request'); queueMicrotask(() => coord.peerConnected(PEER.peerId)) })
  return { coord, calls, rendezvous, events, timers, setConnected: (v) => { connected = v }, advance: (ms) => { nowMs += ms } }
}

describe('ladder order and strict escalation', () => {
  it('LAN success: no later rung is attempted', async () => {
    const { coord, calls, rendezvous } = setup({ lan: true })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'lan' })
    expect(calls).toEqual(['lan'])
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('rung 1 success: ZERO rung-3 calls and rung 2 is not attempted', async () => {
    const { coord, calls, rendezvous } = setup({ r1: true })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'rung1' })
    expect(calls).toEqual(['lan', 'rung1'])
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('rung 2 success: ZERO rung-3 calls', async () => {
    const { coord, calls, rendezvous } = setup({ r2: true })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'rung2' })
    expect(calls).toEqual(['lan', 'rung1', 'rung2'])
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('URL unset (no rendezvous): ZERO rung-3 calls ever, and the ladder ends in same-network-required', async () => {
    const { coord, calls, events } = setup({ withRendezvous: false })
    expect(await coord.reconnect(PEER)).toEqual({ ok: false, reason: 'same-network-required' })
    expect(calls).toEqual(['lan', 'rung1', 'rung2'])
    expect(events.map((e) => e[0])).toEqual([EVENTS.SAME_NETWORK_REQUIRED])
  })

  it('rungs 1 and 2 both failing DOES try rung 3, after them, and waits the full window before failing', async () => {
    const { coord, calls, rendezvous, timers, events } = setup()
    const p = coord.reconnect(PEER)
    await vi.waitFor(() => expect(rendezvous.request).toHaveBeenCalledTimes(1))
    expect(calls).toEqual(['lan', 'rung1', 'rung2', 'rung3-request'])
    expect(timers.at(-1).ms).toBe(90_000)
    expect(events).toEqual([])
    timers.at(-1).fn()
    expect(await p).toEqual({ ok: false, reason: 'same-network-required' })
    expect(events).toEqual([[EVENTS.SAME_NETWORK_REQUIRED, { peerId: 'peer-b', reason: 'all-rungs-failed' }]])
  })

  it('a peer reached through rung 3 succeeds and releases the demand', async () => {
    const { coord, rendezvous } = setup({ rung3Connects: true })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'rung3' })
    expect(rendezvous.release).toHaveBeenCalledWith('peer-b')
  })

  it('a LAN attempt that throws counts as a failed rung and the ladder continues', async () => {
    const coord = createReconnectCoordinator({
      listPeers: () => [PEER], isConnected: () => false, lanGraceMs: 0,
      attemptLan: async () => { throw new Error('boom') },
      attemptRung1: async () => ({ ok: true }),
      attemptRung2: async () => ({ ok: false }),
    })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'rung1' })
  })
})

describe('re-check after every rung (the owner rule: the relay only when nothing else can work)', () => {
  it('rung 2 connects the peer and then reports false: ZERO rung-3 calls, no SAME_NETWORK_REQUIRED', async () => {
    const { coord, rendezvous, events } = setup({ attemptRung2: async (_p, { setConnected }) => { setConnected(true); return false } })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'connected' })
    expect(rendezvous.request).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('a peer that connected during LAN is not handed to rung 1', async () => {
    const calls = []
    let connected = false
    const coord = createReconnectCoordinator({
      listPeers: () => [PEER], isConnected: () => connected, lanGraceMs: 0,
      attemptLan: async () => { connected = true; return false },
      attemptRung1: async () => { calls.push('rung1'); return false },
      attemptRung2: async () => { calls.push('rung2'); return false },
    })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'connected' })
    expect(calls).toEqual([])
  })

  it('the peer becomes connected during the rung-3 wait without a notification: demand released, no false event', async () => {
    const { coord, rendezvous, timers, events, setConnected } = setup()
    const p = coord.reconnect(PEER)
    await vi.waitFor(() => expect(rendezvous.request).toHaveBeenCalledTimes(1))
    setConnected(true)
    timers.at(-1).fn()
    expect(await p).toEqual({ ok: true, rung: 'rung3' })
    expect(rendezvous.release).toHaveBeenCalledWith('peer-b')
    expect(events).toEqual([])
  })
})

describe('rung errors are not "unreachable"', () => {
  it('rung 1 throwing emits PUNCH_RUNG_ERROR {rung:1}, skips rung 3 and SAME_NETWORK_REQUIRED', async () => {
    const events = []
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const coord = createReconnectCoordinator({
      listPeers: () => [PEER], isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false,
      attemptRung1: async () => { throw new Error('/secret/path') },
      attemptRung2: async () => ({ ok: false }),
      emit: (n, f) => events.push([n, f]),
    })
    expect(await coord.reconnect(PEER)).toEqual({ ok: false, reason: 'rung-error' })
    expect(events).toEqual([[EVENTS.PUNCH_RUNG_ERROR, { peerId: 'peer-b', rung: 1 }]])
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('rung 2 reporting reason "error" is a rung error too', async () => {
    const events = []
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const coord = createReconnectCoordinator({
      listPeers: () => [PEER], isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false,
      attemptRung1: async () => ({ ok: false, reason: 'no-memory' }),
      attemptRung2: async () => ({ ok: false, reason: 'error' }),
      emit: (n, f) => events.push([n, f]),
    })
    expect(await coord.reconnect(PEER)).toEqual({ ok: false, reason: 'rung-error' })
    expect(events).toEqual([[EVENTS.PUNCH_RUNG_ERROR, { peerId: 'peer-b', rung: 2 }]])
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('the event vocabulary carries only the rung number', () => {
    const sink = vi.fn()
    createConnectivityEmitter({ sink }).emit(EVENTS.PUNCH_RUNG_ERROR, { peerId: 'peer-b', rung: 2, error: '/secret/path' })
    const payload = JSON.parse(sink.mock.calls[0][0])
    expect(payload.rung).toBe(2)
    expect(JSON.stringify(payload)).not.toContain('secret')
  })
})

describe('LAN grace', () => {
  const tick = () => new Promise((r) => setImmediate(r))

  it('a peer that mDNS discovers within the grace never reaches rung 1, 2 or 3', async () => {
    const { coord, calls, rendezvous, setConnected } = setup({ lanGraceMs: 30_000, waitMdnsPass: () => new Promise(() => {}) })
    const p = coord.reconnect(PEER)
    await tick()
    setConnected(true)
    coord.peerConnected(PEER.peerId)
    expect(await p).toEqual({ ok: true, rung: 'connected' })
    expect(calls).toEqual(['lan'])
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('without discovery the 30s grace elapses and the ladder escalates', async () => {
    const { coord, calls, timers } = setup({ lanGraceMs: 30_000, waitMdnsPass: () => new Promise(() => {}), r1: true })
    const p = coord.reconnect(PEER)
    await tick()
    expect(timers.at(-1).ms).toBe(30_000)
    expect(calls).toEqual(['lan'])
    timers.at(-1).fn()
    expect(await p).toEqual({ ok: true, rung: 'rung1' })
  })

  it('the next completed mDNS pass ends the grace early', async () => {
    let finishPass
    const { coord, calls } = setup({ lanGraceMs: 30_000, waitMdnsPass: () => new Promise((r) => { finishPass = r }), r1: true })
    const p = coord.reconnect(PEER)
    await tick()
    expect(calls).toEqual(['lan'])
    finishPass()
    expect(await p).toEqual({ ok: true, rung: 'rung1' })
  })
})

describe('sweeps', () => {
  it('every peer connected: no rung runs and rendezvous is never requested', async () => {
    const { coord, calls, rendezvous, setConnected, timers } = setup()
    setConnected(true)
    coord.start()
    expect(timers).toHaveLength(1)
    await coord.sweep()
    expect(calls).toEqual([])
    expect(rendezvous.request).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)
  })

  it('a failed sweep reschedules with a doubling backoff; a clean sweep stops rescheduling', async () => {
    const { coord, timers, setConnected, advance } = setup({ withRendezvous: false })
    await coord.sweep()
    expect(timers.map((t) => t.ms)).toEqual([60_000])
    advance(60_000)
    await coord.sweep()
    expect(timers.map((t) => t.ms)).toEqual([60_000, 120_000])
    setConnected(true)
    advance(120_000)
    await coord.sweep()
    expect(timers).toHaveLength(2)
  })

  it('backoff is per peer: A fails repeatedly, then B disconnects and B is tried promptly', async () => {
    const connected = { 'peer-a': false, 'peer-b': true }
    const tried = []
    const timers = []
    let nowMs = 0
    const coord = createReconnectCoordinator({
      listPeers: () => [{ peerId: 'peer-a', deviceId: 'dev-a' }, { peerId: 'peer-b', deviceId: 'dev-b' }],
      isConnected: (id) => connected[id],
      lanGraceMs: 0,
      attemptLan: async (p) => { tried.push(p.peerId); return false },
      attemptRung1: async () => false,
      attemptRung2: async () => false,
      now: () => nowMs,
      setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t },
      clearTimer: (t) => { t.cleared = true },
      random: () => 1,
    })
    await coord.sweep()
    for (let i = 0; i < 3; i++) { nowMs += timers.at(-1).ms; await coord.sweep() }
    expect(timers.map((t) => t.ms)).toEqual([60_000, 120_000, 240_000, 480_000])
    expect(new Set(tried)).toEqual(new Set(['peer-a']))
    const pending = timers.at(-1)
    tried.length = 0
    connected['peer-b'] = false
    coord.notifyPeersChanged()
    expect(pending.cleared).toBe(true)
    expect(timers.at(-1).ms).toBe(15_000)
    nowMs += 15_000
    await coord.sweep()
    expect(tried).toEqual(['peer-b'])
  })

  it('a peer already connected at sweep time releases any rendezvous demand for it', async () => {
    const { coord, rendezvous, setConnected } = setup()
    setConnected(true)
    await coord.sweep()
    expect(rendezvous.release).toHaveBeenCalledWith('peer-b')
  })

  it('concurrent reconnects for the same peer share one ladder run', async () => {
    const { coord, calls } = setup({ r1: true })
    await Promise.all([coord.reconnect(PEER), coord.reconnect(PEER)])
    expect(calls.filter((c) => c === 'rung1')).toHaveLength(1)
  })

  it('stop() ends a pending rung-3 wait without a SAME_NETWORK_REQUIRED and releases the demand', async () => {
    const { coord, rendezvous, events } = setup()
    const p = coord.reconnect(PEER)
    await vi.waitFor(() => expect(rendezvous.request).toHaveBeenCalled())
    coord.stop()
    expect((await p).ok).toBe(false)
    expect(events).toEqual([])
    expect(rendezvous.release).toHaveBeenCalledWith('peer-b')
  })

  it('a peer removed from listPeers releases its demand and ends its wait with no event', async () => {
    let peers = [PEER]
    const events = []
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const coord = createReconnectCoordinator({
      listPeers: () => peers, isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false, attemptRung1: async () => false, attemptRung2: async () => false,
      emit: (n, f) => events.push([n, f]),
      setTimer: () => ({ unref() {} }), clearTimer: () => {},
    })
    const p = coord.reconnect(PEER)
    await vi.waitFor(() => expect(rendezvous.request).toHaveBeenCalled())
    peers = []
    coord.notifyPeersChanged()
    expect((await p).ok).toBe(false)
    expect(rendezvous.release).toHaveBeenCalledWith('peer-b')
    expect(events).toEqual([])
  })

  it('a peer revoked during rungs 1-2 is never handed to the rendezvous', async () => {
    let peers = [PEER]
    const events = []
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const coord = createReconnectCoordinator({
      listPeers: () => peers, isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false, attemptRung1: async () => false,
      attemptRung2: async () => { peers = []; return false },
      emit: (n, f) => events.push([n, f]),
    })
    expect(await coord.reconnect(PEER)).toEqual({ ok: false, reason: 'cancelled' })
    expect(rendezvous.request).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})

describe('consecutive rung errors (keeper ruling: 3 in a row count as failed)', () => {
  function errSetup(rung1) {
    const events = []
    const timers = []
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    // A rung-3 wait times out as soon as it starts, so every ladder run settles.
    const coord = createReconnectCoordinator({
      listPeers: () => [PEER], isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false,
      attemptRung1: async () => rung1(),
      attemptRung2: async () => ({ ok: false }),
      emit: (n, f) => events.push([n, f]),
      setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); if (ms === RUNG3_WAIT_MS) queueMicrotask(fn); return t }, clearTimer: () => {},
    })
    return { events, rendezvous, run: () => coord.reconnect(PEER) }
  }

  it('the third consecutive error lets the ladder reach rung 3, and every error is still emitted', async () => {
    const { events, rendezvous, run } = errSetup(() => { throw new Error('x') })
    expect(await run()).toEqual({ ok: false, reason: 'rung-error' })
    expect(await run()).toEqual({ ok: false, reason: 'rung-error' })
    expect(rendezvous.request).not.toHaveBeenCalled()
    expect(await run()).toEqual({ ok: false, reason: 'same-network-required' })
    expect(rendezvous.request).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e[0] === EVENTS.PUNCH_RUNG_ERROR)).toEqual(Array(3).fill([EVENTS.PUNCH_RUNG_ERROR, { peerId: 'peer-b', rung: 1 }]))
  })

  it('a non-error outcome resets the count: error, error, fail, error, error never escalates on an error', async () => {
    const seq = ['err', 'err', 'fail', 'err', 'err']
    const { rendezvous, run } = errSetup(() => { if (seq.shift() === 'err') throw new Error('x'); return { ok: false } })
    const reasons = []
    for (let i = 0; i < 5; i++) reasons.push((await run()).reason)
    expect(reasons).toEqual(['rung-error', 'rung-error', 'same-network-required', 'rung-error', 'rung-error'])
    expect(rendezvous.request).toHaveBeenCalledTimes(1)
  })

  it('an ok rung resets the count: error, error, ok, error does not escalate', async () => {
    const seq = ['err', 'err', 'ok', 'err']
    const { rendezvous, run } = errSetup(() => { if (seq.shift() === 'err') throw new Error('x'); return { ok: true } })
    const reasons = []
    for (let i = 0; i < 4; i++) reasons.push((await run()).reason ?? 'ok')
    expect(reasons).toEqual(['rung-error', 'rung-error', 'ok', 'rung-error'])
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('rung 2 has its own counter: three rung-2 errors escalate while rung 1 plainly fails', async () => {
    const events = []
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const coord = createReconnectCoordinator({
      listPeers: () => [PEER], isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false, attemptRung1: async () => ({ ok: false }),
      attemptRung2: async () => ({ ok: false, reason: 'error' }),
      emit: (n, f) => events.push([n, f]),
      setTimer: (fn, ms) => { if (ms === RUNG3_WAIT_MS) queueMicrotask(fn); return { unref() {} } }, clearTimer: () => {},
    })
    const reasons = []
    for (let i = 0; i < 3; i++) reasons.push((await coord.reconnect(PEER)).reason)
    expect(reasons).toEqual(['rung-error', 'rung-error', 'same-network-required'])
    expect(events.filter((e) => e[0] === EVENTS.PUNCH_RUNG_ERROR)).toEqual(Array(3).fill([EVENTS.PUNCH_RUNG_ERROR, { peerId: 'peer-b', rung: 2 }]))
  })

  function membershipSetup(rung1) {
    let peers = [PEER]
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const coord = createReconnectCoordinator({
      listPeers: () => peers, isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false, attemptRung1: async () => rung1(), attemptRung2: async () => ({ ok: false }),
      setTimer: (fn, ms) => { if (ms === RUNG3_WAIT_MS) queueMicrotask(fn); return { unref() {} } }, clearTimer: () => {},
    })
    return { coord, rendezvous, setPeers: (p) => { peers = p } }
  }

  it('a peer dropped from listPeers loses its error count', async () => {
    const { coord, rendezvous, setPeers } = membershipSetup(() => { throw new Error('x') })
    await coord.reconnect(PEER)
    await coord.reconnect(PEER)
    setPeers([])
    coord.notifyPeersChanged()
    setPeers([PEER])
    expect(await coord.reconnect(PEER)).toEqual({ ok: false, reason: 'rung-error' })
    expect(rendezvous.request).not.toHaveBeenCalled()
  })

  it('a rung error landing after the peer was dropped does not revive its count', async () => {
    let fail
    const { coord, rendezvous, setPeers } = membershipSetup(() => new Promise((_, rej) => { fail = rej }))
    const p = coord.reconnect(PEER)
    await vi.waitFor(() => expect(fail).toBeDefined())
    setPeers([])
    coord.notifyPeersChanged()
    fail(new Error('late'))
    await p
    setPeers([PEER])
    for (let i = 0; i < 2; i++) {
      fail = undefined
      const q = coord.reconnect(PEER)
      await vi.waitFor(() => expect(fail).toBeDefined())
      fail(new Error('x'))
      expect(await q).toEqual({ ok: false, reason: 'rung-error' })
    }
    expect(rendezvous.request).not.toHaveBeenCalled()
  })
})

describe('membership re-check failure is not a revocation', () => {
  function gateSetup(listPeers) {
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const timers = []
    const coord = createReconnectCoordinator({
      listPeers, isConnected: () => false, lanGraceMs: 0, rendezvous,
      attemptLan: async () => false, attemptRung1: async () => false, attemptRung2: async () => false,
      setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t }, clearTimer: () => {},
    })
    return { coord, rendezvous, timers }
  }

  it('listPeers throwing at the rung-3 gate is an ordinary failure that is backed off, not cancelled', async () => {
    let calls = 0
    const { coord, rendezvous, timers } = gateSetup(() => { calls++; if (calls > 1) throw new Error('db busy'); return [PEER] })
    // Call 1 is the sweep's own listPeers; call 2 is the rung-3 membership gate.
    await coord.sweep()
    expect(rendezvous.request).not.toHaveBeenCalled()
    expect(timers.length).toBeGreaterThan(0)
  })

  it('listPeers succeeding without the peer is cancelled, with no backoff', async () => {
    let calls = 0
    const { coord, rendezvous, timers } = gateSetup(() => { calls++; return calls > 1 ? [] : [PEER] })
    await coord.sweep()
    expect(rendezvous.request).not.toHaveBeenCalled()
    expect(timers).toEqual([])
  })
})
