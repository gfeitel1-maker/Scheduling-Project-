// @vitest-environment node
//
// T337 pre-signoff hardening (Red Hat — refresh-bypass DoS vector): pins, as a real-multi-node
// repo PROOF rather than a library-source inference, that a single admitted peer refreshing its
// RESERVE repeatedly does NOT grow R's reservation count. This is load-bearing because
// server/reservation-store.js's reserve() explicitly bypasses `maxReservations` when
// `reservation != null` (an existing reservation being refreshed) — if a future
// @libp2p/circuit-relay-v2 version changed that bypass to also apply to distinct peers, or
// stopped recognizing same-peer refresh at all, this test (not just reading the source) would
// catch it. Real libp2p nodes, the actually-installed package, no mocks — mirrors
// relayRoleCampOnly.test.js's raw-HOP-protocol harness, and uses the SAME reservationTtl/
// maxReservations values syncStarter.js actually ships (COORDINATION_WINDOW_MS=120000,
// MAX_SIMULTANEOUS_RESERVATIONS=8).
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { pbStream } from '@libp2p/utils'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { startTransport } from './transport.js'
import { HopMessage, Status } from '../../../node_modules/@libp2p/circuit-relay-v2/dist/src/pb/index.js'
import { RELAY_V2_HOP_CODEC } from '@libp2p/circuit-relay-v2'

// Same values syncStarter.js actually ships (COORDINATION_WINDOW_MS, MAX_SIMULTANEOUS_RESERVATIONS).
const COORDINATION_WINDOW_MS = 120000
const MAX_SIMULTANEOUS_RESERVATIONS = 8

let handles = []
let rawNodes = []
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  await Promise.all(rawNodes.map((n) => n.stop()))
  handles = []
  rawNodes = []
})

async function startRawNode() {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  })
  rawNodes.push(node)
  return node
}

async function reserve(node, relayPeerId) {
  const stream = await node.dialProtocol(relayPeerId, RELAY_V2_HOP_CODEC)
  const pbstr = pbStream(stream).pb(HopMessage)
  await pbstr.write({ type: HopMessage.Type.RESERVE })
  const response = await pbstr.read()
  await stream.close().catch(() => {})
  return response
}

function startRelay() {
  return startTransport({
    deviceId: 'device-r',
    relayServerFactory: circuitRelayServer({
      reservations: { reservationTtl: COORDINATION_WINDOW_MS, maxReservations: MAX_SIMULTANEOUS_RESERVATIONS },
    }),
    // Test-only: libp2p's default inboundConnectionThreshold (5 per remote HOST) refuses the
    // 6th+ real node dialing in from the single loopback host this test uses — a real camp of 8
    // distinct devices would never share one host/IP, so this override is purely an artifact of
    // testing "8 distinct peers" from one process on one machine, not a property under test.
    inboundConnectionThreshold: MAX_SIMULTANEOUS_RESERVATIONS + 2,
  })
}

describe('T337 pre-signoff — refresh does not grow the reservation count, distinct peers do', () => {
  it('a SINGLE admitted peer calling RESERVE repeatedly (refresh) leaves R at exactly 1 reservation', async () => {
    const r = await startRelay()
    handles.push(r)
    const relayPeerId = peerIdFromString(r.peerId)
    const b = await startRawNode()
    await b.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    r.admitPeer(b.peerId.toString())

    const REFRESH_COUNT = 5
    for (let i = 0; i < REFRESH_COUNT; i++) {
      const response = await reserve(b, relayPeerId)
      expect(response.status).toBe(Status.OK)
    }

    expect(r.getRelayReservationCount()).toBe(1)
  })

  // Non-vacuity, by contrast in the SAME test suite: distinct peers DO grow the count, and the
  // cap DOES refuse the (N+1)th — proving the flat result above isn't an artifact of a broken
  // harness (e.g. a connection that silently never reaches R at all).
  it('CONTRAST: distinct admitted peers each add a reservation, up to maxReservations, then get RESERVATION_REFUSED', async () => {
    const r = await startRelay()
    handles.push(r)
    const relayPeerId = peerIdFromString(r.peerId)

    const peers = []
    for (let i = 0; i < MAX_SIMULTANEOUS_RESERVATIONS; i++) {
      const p = await startRawNode()
      await p.dial(multiaddr(r.getMultiaddrs()[0].toString()))
      r.admitPeer(p.peerId.toString())
      const response = await reserve(p, relayPeerId)
      expect(response.status).toBe(Status.OK)
      peers.push(p)
    }

    // Count grew to exactly maxReservations — the thing that stayed flat above for ONE peer
    // refreshing genuinely grows for DISTINCT peers reserving.
    expect(r.getRelayReservationCount()).toBe(MAX_SIMULTANEOUS_RESERVATIONS)

    const overCap = await startRawNode()
    await overCap.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    r.admitPeer(overCap.peerId.toString())
    const overCapResponse = await reserve(overCap, relayPeerId)
    expect(overCapResponse.status).toBe(Status.RESERVATION_REFUSED)

    // The cap refusing a NEW peer does not evict or disturb any existing reservation.
    expect(r.getRelayReservationCount()).toBe(MAX_SIMULTANEOUS_RESERVATIONS)

    // And an EXISTING peer (already reserved, part of the "up to the cap" set) can still refresh
    // even though the store is at capacity — refresh is the same no-growth path proven above,
    // now demonstrated to also hold AT the cap, not only below it.
    const refreshAtCap = await reserve(peers[0], relayPeerId)
    expect(refreshAtCap.status).toBe(Status.OK)
    expect(r.getRelayReservationCount()).toBe(MAX_SIMULTANEOUS_RESERVATIONS)
  })
})
