// @vitest-environment node
//
// S4c: the ladder order and the rung-3 invariants. Rung 3 is observed through a network spy
// (rendezvous.request is the only way the coordinator can reach it).
import { describe, it, expect, vi } from 'vitest'
import { createReconnectCoordinator } from './reconnectCoordinator.js'
import { EVENTS } from './connectivityEvents.js'

const PEER = { peerId: 'peer-b', deviceId: 'dev-b' }

function setup({ lan = false, r1 = false, r2 = false, withRendezvous = true, rung3Connects = false } = {}) {
  const calls = []
  let connected = false
  const rendezvous = withRendezvous ? { request: vi.fn(() => calls.push('rung3-request')), release: vi.fn() } : null
  const events = []
  const timers = []
  const coord = createReconnectCoordinator({
    listPeers: () => [PEER],
    isConnected: () => connected,
    attemptLan: async () => { calls.push('lan'); return lan },
    attemptRung1: async () => { calls.push('rung1'); return { ok: r1 } },
    attemptRung2: async () => { calls.push('rung2'); return { ok: r2 } },
    rendezvous,
    emit: (name, fields) => events.push([name, fields]),
    rung3WaitMs: 90_000,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
    random: () => 1,
  })
  if (rung3Connects) rendezvous.request.mockImplementation(() => { calls.push('rung3-request'); queueMicrotask(() => coord.peerConnected(PEER.peerId)) })
  return { coord, calls, rendezvous, events, timers, setConnected: (v) => { connected = v } }
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

  it('an attempt that throws counts as a failed rung and the ladder continues', async () => {
    const coord = createReconnectCoordinator({
      listPeers: () => [PEER], isConnected: () => false,
      attemptLan: async () => { throw new Error('boom') },
      attemptRung1: async () => ({ ok: true }),
      attemptRung2: async () => ({ ok: false }),
    })
    expect(await coord.reconnect(PEER)).toEqual({ ok: true, rung: 'rung1' })
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
    const { coord, timers, setConnected } = setup({ withRendezvous: false })
    await coord.sweep()
    expect(timers.map((t) => t.ms)).toEqual([60_000])
    await coord.sweep()
    expect(timers.map((t) => t.ms)).toEqual([60_000, 120_000])
    setConnected(true)
    await coord.sweep()
    expect(timers).toHaveLength(2)
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

  it('stop() ends a pending rung-3 wait as a failure, not a success', async () => {
    const { coord, rendezvous } = setup()
    const p = coord.reconnect(PEER)
    await vi.waitFor(() => expect(rendezvous.request).toHaveBeenCalled())
    coord.stop()
    expect(await p).toEqual({ ok: false, reason: 'same-network-required' })
  })
})
