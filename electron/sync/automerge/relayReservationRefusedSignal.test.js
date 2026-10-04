// @vitest-environment node
//
// T336 build design (docs/work/specs/2026-10-03-t336-holepunch-build-design.md §4, Precondition
// 3): relayRefreshNoGrowth.test.js already proves the SERVER side (R) refuses an over-capacity
// RESERVE once `maxReservations` is hit. This file is about whether that refusal reaches
// something a director can act on, not whether it merely fires an event — the "inversion-frame"
// gap the design calls out. This test pins the FIRST half: transport.js's real wiring observes a
// genuine RESERVATION_REFUSED and invokes `onRelayReservationRefused` with a distinguishable,
// documented shape. (The second half — that shape reaching Sidebar's director-visible "relay
// full" label — is pinned by sidebarState.test.js and Sidebar.test.jsx, which do not need a real
// libp2p node to exercise.)
//
// Real libp2p nodes, the actually-installed @libp2p/circuit-relay-v2@4.2.13, no mocks: R runs the
// real circuitRelayServer with maxReservations:1 (so a second camp-admitted peer is genuinely
// refused, not simulated), B is a real peer that fills the one slot, and A is the client under
// test — transport.js's own startTransport with a real relayTransportFactory — whose own
// reservation attempt against R is the one that gets refused.
import { describe, it, expect, afterEach } from 'vitest'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { startTransport } from './transport.js'

let handles = []
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  handles = []
})

async function waitFor(predicate, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function neverHappens(predicate, { grace = 2500, interval = 50 } = {}) {
  const start = Date.now()
  while (Date.now() - start < grace) {
    if (predicate()) throw new Error('neverHappens: predicate became true during the grace window')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function hasCircuitVia(node, relayPeerIdString) {
  return node.getMultiaddrs().some((ma) => {
    const s = ma.toString()
    return s.includes('/p2p-circuit') && s.includes(relayPeerIdString)
  })
}

describe('T336 Precondition 3 — a refused relay reservation reaches onRelayReservationRefused', () => {
  it('RED/GREEN: a genuine RESERVATION_REFUSED (relay at capacity) invokes the callback with a distinguishable shape, and never grants a circuit', async () => {
    const r = await startTransport({
      deviceId: 'device-r',
      relayServerFactory: circuitRelayServer({ reservations: { maxReservations: 1 } }),
    })
    const b = await startTransport({
      deviceId: 'device-b',
      listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
      relayTransportFactory: circuitRelayTransport(),
    })
    const refusals = []
    const a = await startTransport({
      deviceId: 'device-a',
      listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
      relayTransportFactory: circuitRelayTransport(),
      onRelayReservationRefused: (detail) => refusals.push(detail),
    })
    handles.push(r, b, a)

    // B fills the relay's one available slot.
    await b.dial(r.getMultiaddrs()[0])
    await waitFor(() => b.getPeers().length > 0)
    r.admitPeer(b.peerId)
    b.admitPeer(r.peerId)
    await waitFor(() => hasCircuitVia(b, r.peerId))

    // A is an equally legitimate camp peer (R admits it too) but the slot is already taken.
    await a.dial(r.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    r.admitPeer(a.peerId)
    a.admitPeer(r.peerId)

    await waitFor(() => refusals.length > 0)
    expect(refusals[0]).toMatchObject({
      type: 'relay-reservation-refused',
      peerId: r.peerId,
      reason: 'RESERVATION_REFUSED',
    })
    expect(typeof refusals[0].at).toBe('number')

    // Non-vacuity on the real outcome, not just the signal: A never actually gets a circuit via R.
    await neverHappens(() => hasCircuitVia(a, r.peerId))
    expect(hasCircuitVia(a, r.peerId)).toBe(false)
  }, 20000)

  it('non-vacuity: a successful reservation (slot available) never fires the callback', async () => {
    const r = await startTransport({
      deviceId: 'device-r2',
      relayServerFactory: circuitRelayServer({ reservations: { maxReservations: 1 } }),
    })
    const refusals = []
    const a = await startTransport({
      deviceId: 'device-a2',
      listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
      relayTransportFactory: circuitRelayTransport(),
      onRelayReservationRefused: (detail) => refusals.push(detail),
    })
    handles.push(r, a)

    await a.dial(r.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    r.admitPeer(a.peerId)
    a.admitPeer(r.peerId)

    await waitFor(() => hasCircuitVia(a, r.peerId))
    expect(refusals.length).toBe(0)
  }, 20000)
})
