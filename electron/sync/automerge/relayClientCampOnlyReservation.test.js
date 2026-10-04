// @vitest-environment node
//
// T336 build design (docs/work/specs/2026-10-03-t336-holepunch-build-design.md §4, Precondition
// 2): T337's relayRoleCampOnly.test.js/relayRevokeWhileRunning.test.js prove the SERVER side (R)
// declines to broker for a non-admitted peer. This file is about the CLIENT side — does A's own
// circuitRelayTransport/RelayDiscovery ever even ATTEMPT a reservation against a relay A has not
// itself camp-admitted, independent of whether that relay would have granted it?
//
// Three real libp2p nodes, no mocks, the actually-installed @libp2p/circuit-relay-v2@4.2.13:
//   A — the client under test, circuitRelayTransport enabled (via transport.js's startTransport).
//   B — a camp-admitted peer (authenticates TO A, so A's own authenticatedPeers includes it),
//       also running circuitRelayServer.
//   X — a reachable peer running circuitRelayServer but NEVER admitted by A (simulates a stray
//       non-camp relay) — and X itself ADMITS A, so if A's RelayDiscovery ever tries, it SUCCEEDS;
//       a clean "A tried" signal, not confounded by X's own refusal.
//
// RED baseline (library default, no camp-side restriction): a PLAIN libp2p node built directly
// with circuitRelayTransport() — the same raw-library-default pattern relayRoleCampOnly.test.js's
// own RED case uses — happily reserves through X. GREEN: transport.js's real wiring restricts A's
// reservation-candidate selection to camp-admitted peers (the same authenticatedPeers/
// isPeerAdmittedForRelay closure the server-side gating already uses), so A never reserves
// through X, but still reserves through admitted B (non-vacuity).
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'
import { startTransport } from './transport.js'

let handles = []
let rawNodes = []
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  await Promise.all(rawNodes.map((n) => n.stop()))
  handles = []
  rawNodes = []
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

describe('T336 Precondition 2 — client-side camp-only reservation candidate selection', () => {
  it('RED: a plain (unrestricted) circuitRelayTransport client reserves through ANY reachable relay, camp or not', async () => {
    const x = await startTransport({ deviceId: 'device-x', relayServerFactory: circuitRelayServer() })
    handles.push(x)

    const rawA = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'] },
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
      // Deliberately NO camp-side restriction — the library default this design must not ship.
    })
    rawNodes.push(rawA)

    await rawA.dial(multiaddr(x.getMultiaddrs()[0].toString()))
    x.admitPeer(rawA.peerId.toString())

    await waitFor(() => hasCircuitVia(rawA, x.peerId))
    expect(hasCircuitVia(rawA, x.peerId)).toBe(true)
  }, 15000)

  it('GREEN: transport.js\'s real wiring never reserves through a non-admitted relay X, even though X would grant it', async () => {
    const x = await startTransport({ deviceId: 'device-x', relayServerFactory: circuitRelayServer() })
    const a = await startTransport({
      deviceId: 'device-a',
      listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
      relayTransportFactory: circuitRelayTransport(),
    })
    handles.push(x, a)

    await a.dial(x.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    // X admits A — if A's RelayDiscovery ever attempted a RESERVE, it would succeed. A never
    // authenticates to X, and X never authenticates to A, so X is NOT in A's camp-admitted set.
    x.admitPeer(a.peerId)

    await neverHappens(() => hasCircuitVia(a, x.peerId))
    expect(hasCircuitVia(a, x.peerId)).toBe(false)
  }, 15000)

  it('non-vacuity: the SAME restricted client still reserves through a relay A HAS camp-admitted', async () => {
    const b = await startTransport({ deviceId: 'device-b', relayServerFactory: circuitRelayServer() })
    const a = await startTransport({
      deviceId: 'device-a',
      listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
      relayTransportFactory: circuitRelayTransport(),
    })
    handles.push(b, a)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    // Direct test-support admission (same `admitPeer` every other relay test uses to simulate a
    // peer that completed the real auth handshake) — this is what makes B camp-admitted from A's
    // own perspective: the same authenticatedPeers set every other admission check reads.
    a.admitPeer(b.peerId)
    b.admitPeer(a.peerId)

    await waitFor(() => hasCircuitVia(a, b.peerId))
    expect(hasCircuitVia(a, b.peerId)).toBe(true)
  }, 15000)
})
