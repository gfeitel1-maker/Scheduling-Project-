// @vitest-environment node
//
// T337 gate-fix round 2 (Code Reviewer LOW, FIX 3 — design §D Proof 1/2): drives the final B↔C
// hop END-TO-END over a REAL relayed connection (not only the broker-refusal half at B↔R/R↔C
// already covered by relayRoleCampOnly.test.js/relayRevokeWhileRunning.test.js), and proves a
// device revoked mid-session is cut off on that relayed connection — real multi-node, the
// actually-installed @libp2p/circuit-relay-v2@4.2.13, no mocks.
//
// All three nodes are started via transport.js's own startTransport (the real wiring under
// test): R runs the relay server; B and C both run the relay TRANSPORT (circuitRelayTransport),
// which is what lets C actually listen for, and B actually dial, a /p2p-circuit address — this is
// the part relayRevokeWhileRunning.test.js deliberately did NOT drive (it used raw HOP messages
// only, to isolate the broker gate). Here the full RESERVE (C, via the transport's own automatic
// reservation-on-discovery) → CONNECT (B→R→C) → STOP (R→C) chain runs for real, producing an
// actual Connection object on C whose remotePeer is B — and then this app's own PROTO admission
// check (node.handle(PROTO,...) in transport.js, UNCHANGED by T337 — already transport-agnostic)
// is exercised directly against that relayed connection.
import { describe, it, expect, afterEach } from 'vitest'
import { multiaddr } from '@multiformats/multiaddr'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { startTransport } from './transport.js'

let handles = []
let receivedOnC = []
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  handles = []
  receivedOnC = []
})

async function waitFor(predicate, { timeout = 15000, interval = 50 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

describe('T337 end-to-end relayed connection — revoke-while-running cuts off the final B↔C hop', () => {
  it('B dials C THROUGH R over a real circuit-relay-v2 connection, and admission on C gates it exactly like a direct connection', async () => {
    const r = await startTransport({
      deviceId: 'device-r',
      relayServerFactory: circuitRelayServer({ reservations: { reservationTtl: 120000, maxReservations: 8 } }),
    })
    const b = await startTransport({ deviceId: 'device-b', relayTransportFactory: circuitRelayTransport() })
    const c = await startTransport({
      deviceId: 'device-c',
      // '/p2p-circuit' in the listen set is what makes circuitRelayTransport's own listener
      // actually call reservationStore.reserveRelay() (transport/listener.js) — without it, the
      // transport never asks to reserve a slot on anything, no matter how long a test waits.
      listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
      relayTransportFactory: circuitRelayTransport(),
      onDocReceived: (bytes) => { receivedOnC.push(bytes) },
    })
    handles.push(r, b, c)

    await b.dial(r.getMultiaddrs()[0])
    await c.dial(r.getMultiaddrs()[0])
    r.admitPeer(b.peerId)
    r.admitPeer(c.peerId)
    // T336 Precondition 2 (transport.js): a circuitRelayTransport client only ever attempts a
    // reservation against a relay it has itself admitted — C must admit R directly, the same way
    // B admits C below for the final hop.
    c.admitPeer(r.peerId)

    // C's circuitRelayTransport auto-reserves on R once identify surfaces R's HOP support
    // (RelayDiscovery's topology listener — see @libp2p/circuit-relay-v2's transport/discovery.js,
    // no explicit call needed). Wait for C to actually be listening on a /p2p-circuit address —
    // the real signal that the RESERVE round-trip completed, not a fixed sleep.
    await waitFor(() => c.getMultiaddrs().some((ma) => ma.toString().includes('/p2p-circuit')))

    const circuitAddr = c.getMultiaddrs().find((ma) => ma.toString().includes('/p2p-circuit'))
    await b.dial(multiaddr(circuitAddr.toString()))
    await waitFor(() => b.getPeers().includes(c.peerId))

    // This app's own admission (authenticatedPeers), on C, for the connection that just arrived
    // — which, from C's perspective, is just "a connection from B", regardless that it tunneled
    // through R. Admit B on C the same way syncNode.js's onAuthenticate/admitPeer would.
    c.admitPeer(b.peerId)

    const bytes = new TextEncoder().encode('hello-over-relay')
    await b.sendDocTo(c.peerId, bytes)
    await waitFor(() => receivedOnC.length > 0)
    expect(new TextDecoder().decode(receivedOnC[0])).toBe('hello-over-relay')

    // ── Revoke-while-running: C revokes B. The relayed CONNECTION is untouched (libp2p itself
    // doesn't know about this app's admission state) — proving the cut-off happens at THIS app's
    // own gate, on every subsequent stream open, exactly as transport.js's module comment claims
    // for "a hole-punch/relay upgrade changes the transport under an existing connection without
    // re-running the full handshake."
    c.revokePeer(b.peerId)

    // Observe the cut-off on the RECEIVER (C), not the sender. Whether B's own
    // sendDocTo observes the abort is timing-dependent — C aborts the stream on
    // its side, and B may finish writing before that abort propagates back — so
    // the sender-side rejection is NOT the signal (it raced the 3000ms wall at
    // ~13%). What is deterministic is that C's admission gate (transport.js's
    // PROTO handler, authenticatedPeers.has) stops B's post-revoke doc from ever
    // reaching onDocReceived.
    //
    // Gate-state proof (synchronous, no wait): C no longer admits B.
    expect(c.isPeerAuthenticated(b.peerId)).toBe(false)

    // Behaviour proof: attempt B's post-revoke send and confirm C never received
    // it. Tolerate the send resolving OR rejecting — it must not be the signal.
    const receivedBefore = receivedOnC.length
    await b.sendDocTo(c.peerId, bytes).then(() => {}, () => {})
    // Bounded settle: poll the ACTUAL observable, not a fixed sleep. If the gate
    // were broken and C accepted B's doc, onDocReceived would push and this exits
    // immediately (RED); with the gate intact receivedOnC never grows and the
    // loop bounds its wait well under testTimeout before asserting.
    const settleBy = Date.now() + 1000
    while (receivedOnC.length === receivedBefore && Date.now() < settleBy) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(receivedOnC.length).toBe(receivedBefore)
  }, 20000)
})
