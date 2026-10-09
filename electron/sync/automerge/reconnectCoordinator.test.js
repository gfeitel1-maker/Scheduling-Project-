// @vitest-environment node
//
// S4c: the ladder order and the rung-3 invariants. Rung 3 is observed through a network spy
// (rendezvous.request is the only way the coordinator can reach it).
import { describe, it, expect, vi } from 'vitest'
import { createReconnectCoordinator } from './reconnectCoordinator.js'
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
})
