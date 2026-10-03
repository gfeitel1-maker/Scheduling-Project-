// @vitest-environment node
//
// T337 (docs/work/specs/2026-10-03-t337-coordination-layer-design.md §D Proof 2): revoke-while-
// running cut-off, at the B↔R coordination hop specifically — "the revocation-enforcement hook
// must run on every multiplexed stream open... because a hole-punch upgrade changes the transport
// under an existing connection without necessarily re-running the full handshake," carried one
// layer earlier into the relay-broker handoff. Real multi-node libp2p, the actually-installed
// @libp2p/circuit-relay-v2 package, no mocks.
//
// SCOPE NOTE for the reader: this file proves revocation severs R's willingness to BROKER
// (denyOutboundRelayedConnection, checked live on every CONNECT request) for a requester revoked
// mid-session. It deliberately does not drive a full relayed data connection through to a STOP
// handshake on the destination (that requires the destination's own circuitRelayTransport
// listener, which is T336/dcutr-adjacent integration, not this capability's RESERVE/CONNECT
// broker gate) — so assertions below distinguish "gating refused it" (PERMISSION_DENIED) from
// "gating allowed it but the unrelated STOP plumbing isn't wired in this test"
// (CONNECTION_FAILED), rather than asserting a full end-to-end relayed connection succeeded.
// The pre-existing, UNCHANGED per-stream authenticatedPeers check in transport.js's
// node.handle(PROTO,...)/SYNC_PROTO handlers — already transport-agnostic, already covers a
// connection arriving via any transport including circuit-relay — is what proves the FINAL B↔C
// hop; it is not re-tested here because it is not new code (see transport.js, unchanged by T337).
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

async function hop(node, relayPeerId, request) {
  const stream = await node.dialProtocol(relayPeerId, RELAY_V2_HOP_CODEC)
  const pbstr = pbStream(stream).pb(HopMessage)
  await pbstr.write(request)
  const response = await pbstr.read()
  await stream.close().catch(() => {})
  return response
}

async function reserve(node, relayPeerId) {
  return hop(node, relayPeerId, { type: HopMessage.Type.RESERVE })
}

async function requestConnect(node, relayPeerId, dstPeerId) {
  return hop(node, relayPeerId, {
    type: HopMessage.Type.CONNECT,
    peer: { id: dstPeerId.toMultihash().bytes, addrs: [] },
  })
}

describe('T337 revoke-while-running — R declines to broker a CONNECT for a peer revoked mid-session', () => {
  it('B admitted + C reserved: R does NOT refuse the CONNECT for gating reasons', async () => {
    const r = await startTransport({ deviceId: 'device-r', relayServerFactory: circuitRelayServer() })
    handles.push(r)
    const relayPeerId = peerIdFromString(r.peerId)
    const b = await startRawNode()
    const c = await startRawNode()

    await b.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    await c.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    r.admitPeer(b.peerId.toString())
    r.admitPeer(c.peerId.toString())

    const cReserve = await reserve(c, relayPeerId)
    expect(cReserve.status).toBe(Status.OK)

    const connectResponse = await requestConnect(b, relayPeerId, c.peerId)
    // Gating passed (both admitted) — whatever happens next (CONNECTION_FAILED, because this
    // test never gives C a STOP-protocol listener) is NOT the thing under test here.
    expect(connectResponse.status).not.toBe(Status.PERMISSION_DENIED)
  })

  it('B revoked AFTER C reserved, mid-session: R refuses to broker the CONNECT for B — PERMISSION_DENIED', async () => {
    const r = await startTransport({ deviceId: 'device-r', relayServerFactory: circuitRelayServer() })
    handles.push(r)
    const relayPeerId = peerIdFromString(r.peerId)
    const b = await startRawNode()
    const c = await startRawNode()

    await b.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    await c.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    r.admitPeer(b.peerId.toString())
    r.admitPeer(c.peerId.toString())

    const cReserve = await reserve(c, relayPeerId)
    expect(cReserve.status).toBe(Status.OK)

    // Revocation lands WHILE the coordination session is live — B already dialed R, R already
    // admitted it, C already holds a reservation. This is the exact "mid-handoff" window §D
    // Proof 2 is concerned with.
    r.revokePeer(b.peerId.toString())

    const connectResponse = await requestConnect(b, relayPeerId, c.peerId)
    expect(connectResponse.status).toBe(Status.PERMISSION_DENIED)
  })

  it('REVOKED DESTINATION: C revoked after reserving — R refuses to broker a CONNECT to C even for an admitted B', async () => {
    const r = await startTransport({ deviceId: 'device-r', relayServerFactory: circuitRelayServer() })
    handles.push(r)
    const relayPeerId = peerIdFromString(r.peerId)
    const b = await startRawNode()
    const c = await startRawNode()

    await b.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    await c.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    r.admitPeer(b.peerId.toString())
    r.admitPeer(c.peerId.toString())
    const cReserve = await reserve(c, relayPeerId)
    expect(cReserve.status).toBe(Status.OK)

    r.revokePeer(c.peerId.toString())

    const connectResponse = await requestConnect(b, relayPeerId, c.peerId)
    // Gate-fix round 2 (FIX 1c): revokePeer now EVICTS the revoked peer's reservation outright
    // (reservationStore.removeReservation), not only relying on denyOutboundRelayedConnection —
    // so handleConnect's own `reservation == null` check fires first and returns NO_RESERVATION,
    // never reaching the gater at all. This is a STRONGER closure than PERMISSION_DENIED would
    // have been (the slot is actually reclaimed, not just refused-but-still-held) — assert the
    // outcome that is now actually produced, and assert it is never OK, which is the property
    // that actually matters here.
    expect(connectResponse.status).toBe(Status.NO_RESERVATION)
    expect(connectResponse.status).not.toBe(Status.OK)
  })
})
