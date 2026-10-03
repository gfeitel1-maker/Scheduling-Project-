// @vitest-environment node
//
// T337 (docs/work/specs/2026-10-03-t337-coordination-layer-design.md §A "Restricting the relay
// to camp-admitted peers only", §D Proof 1/2, ticket's MUST-PROVE A): the organizer's explicit
// non-negotiable — demonstrate DIRECTLY that a camp peer acting as the circuit-relay-v2
// coordination relay (R) DECLINES to broker for a non-admitted/revoked requester, not merely
// that admission later refuses the punched/relayed connection. Real multi-node libp2p (the
// actually-installed @libp2p/circuit-relay-v2 package), no mocks: R is started via transport.js's
// own startTransport (the real wiring under test — connectionGater.denyInboundRelayReservation/
// denyOutboundRelayedConnection, closed over the same authenticatedPeers set broadcastDoc already
// gates every send on), and the requesters (B, X) are plain libp2p nodes speaking the real
// RELAY_V2_HOP_CODEC protocol directly — this is the lowest-level, most direct way to exercise
// circuitRelayServer's handleReserve/handleConnect gating without depending on the transport
// side's own (unrelated, auto-discovery-driven) reservation machinery.
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { pbStream } from '@libp2p/utils'
import { startTransport } from './transport.js'

// Deep-import of the package's protobuf codec. Not part of @libp2p/circuit-relay-v2's public
// `exports` map (only the top-level entry point is) — resolved by relative filesystem path into
// node_modules, which bypasses the package's own exports restriction because it is plain path
// resolution, not package-specifier resolution. Needed to speak RELAY_V2_HOP_CODEC directly
// (org-source-verification: resolved against @libp2p/circuit-relay-v2@4.2.13, the version actually
// installed in this worktree — read from node_modules, not assumed from training knowledge).
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

async function requestReserve(requesterNode, relayPeerId) {
  const stream = await requesterNode.dialProtocol(relayPeerId, RELAY_V2_HOP_CODEC)
  const pbstr = pbStream(stream).pb(HopMessage)
  await pbstr.write({ type: HopMessage.Type.RESERVE })
  const response = await pbstr.read()
  await stream.close().catch(() => {})
  return response
}

describe('T337 relay-role camp-only — RESERVE gating (circuitRelayServer + transport.js wiring)', () => {
  // ── RED baseline — demonstrates the hazard is real, not assumed ──────────────────────────
  // A circuitRelayServer with NO connectionGater restriction (library default) brokers for ANY
  // connected peer, camp or not. This is the "red" state §C/§D warn against: absence of a
  // restriction reads as compliant until proven otherwise.
  it('RED: a circuitRelayServer with no camp-scoping gater grants a reservation to ANY connected peer', async () => {
    const relayNode = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), circuitRelay: circuitRelayServer() },
      // Deliberately NO connectionGater — the baseline this design must not ship.
    })
    rawNodes.push(relayNode)
    const stranger = await startRawNode()

    await stranger.dial(relayNode.getMultiaddrs()[0])
    const response = await requestReserve(stranger, relayNode.peerId)

    expect(response.status).toBe(Status.OK)
  })

  // ── GREEN — transport.js's real wiring refuses a non-admitted requester ───────────────────
  it('GREEN: R (transport.js + relayServerFactory) grants a reservation to an admitted camp peer', async () => {
    const r = await startTransport({
      deviceId: 'device-r',
      relayServerFactory: circuitRelayServer(),
    })
    handles.push(r)
    const b = await startRawNode()

    await b.dial((await import('@multiformats/multiaddr')).multiaddr(r.getMultiaddrs()[0].toString()))
    // Admit B the same way syncNode.js does post-handshake — this is the real admission
    // mechanism (authenticatedPeers), not a stand-in.
    r.admitPeer(b.peerId.toString())

    const response = await requestReserve(b, (await import('@libp2p/peer-id')).peerIdFromString(r.peerId))
    expect(response.status).toBe(Status.OK)
  })

  it('GREEN: R declines to broker — a non-admitted/revoked peer is refused a reservation outright', async () => {
    const r = await startTransport({
      deviceId: 'device-r',
      relayServerFactory: circuitRelayServer(),
    })
    handles.push(r)
    const x = await startRawNode()
    const { multiaddr } = await import('@multiformats/multiaddr')
    const { peerIdFromString } = await import('@libp2p/peer-id')

    await x.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    // X deliberately never admitted (simulates both a stray non-camp peer AND a revoked peer:
    // revokePeer is the same authenticatedPeers.delete call either way, so "never admitted" and
    // "admitted then revoked" are indistinguishable to this gate by construction — exercised
    // explicitly below).

    const response = await requestReserve(x, peerIdFromString(r.peerId))
    expect(response.status).toBe(Status.PERMISSION_DENIED)
  })

  it('GREEN: a peer admitted and then REVOKED is refused a reservation (not just a never-admitted stranger)', async () => {
    const r = await startTransport({
      deviceId: 'device-r',
      relayServerFactory: circuitRelayServer(),
    })
    handles.push(r)
    const b = await startRawNode()
    const { multiaddr } = await import('@multiformats/multiaddr')
    const { peerIdFromString } = await import('@libp2p/peer-id')

    await b.dial(multiaddr(r.getMultiaddrs()[0].toString()))
    r.admitPeer(b.peerId.toString())
    r.revokePeer(b.peerId.toString())

    const response = await requestReserve(b, peerIdFromString(r.peerId))
    expect(response.status).toBe(Status.PERMISSION_DENIED)
  })

  // Non-vacuity: prove the real connectionGater hooks are actually consulted, not a config field
  // that happens to never be read. Flip isPeerAdmittedForRelay's source by admitting then
  // immediately revoking WITHIN a single reservation attempt window, mirroring T337 §D Proof 2's
  // "revoke while a relay stream is open" shape at the RESERVE boundary.
  it('non-vacuity: admitting X mid-test flips the SAME request from denied to granted (proves the gate reads live state, not a cached snapshot)', async () => {
    const r = await startTransport({
      deviceId: 'device-r',
      relayServerFactory: circuitRelayServer(),
    })
    handles.push(r)
    const x = await startRawNode()
    const { multiaddr } = await import('@multiformats/multiaddr')
    const { peerIdFromString } = await import('@libp2p/peer-id')

    await x.dial(multiaddr(r.getMultiaddrs()[0].toString()))

    const before = await requestReserve(x, peerIdFromString(r.peerId))
    expect(before.status).toBe(Status.PERMISSION_DENIED)

    r.admitPeer(x.peerId.toString())
    const after = await requestReserve(x, peerIdFromString(r.peerId))
    expect(after.status).toBe(Status.OK)
  })
})
