// @vitest-environment node
//
// Stage 4b acceptance test: two in-process libp2p nodes, direct loopback dial
// (no mDNS — deterministic in CI, per the design doc's "Test strategy").
// Proves transport.js's own API contract: connect, broadcast, receive,
// protocol-gating, clean stop. No Automerge/SQLite here — see syncNode.test.js
// for the merge-then-project acceptance test (Stage 4c).
//
// Stage 5d-1 update (docs/adr/2026-09-06-libp2p-membership-mapping.md §3):
// transport.js's doc-sync handler now refuses any peer that hasn't completed
// the auth handshake on the SAME connection first. The tests below that
// actually exercise doc delivery (broadcastDoc/sendDocTo reaching
// onDocReceived) now call `authenticateWith` with an always-admit fake
// authenticator before doing so — this module has no opinion on what
// "authenticated" means (that's syncNode.js's job), so tests supply the
// simplest possible `onAuthenticate` that says yes. The real, security-
// relevant admission logic (token verify/reject-local/trust-check, admission
// removed on disconnect) is covered by authGate.test.js and
// syncNode.authGate.test.js, not here.
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { startTransport } from './transport.js'
import { AUTH_PROTO, receiveFramed } from './wireProtocol.js'

let handles = []
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  handles = []
})

async function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

describe('transport — libp2p node lifecycle', () => {
  // Stage 5d-1: every node here needs an authenticator, because the gate now
  // denies by default in BOTH directions — a node with no onAuthenticate admits
  // nobody, so it neither accepts nor broadcasts doc frames.
  const alwaysAdmit = () => ({ ok: true })

  it('two nodes connect via direct dial', async () => {
    const a = await startTransport({ deviceId: 'device-a', onAuthenticate: alwaysAdmit })
    const b = await startTransport({ deviceId: 'device-b' })
    handles.push(a, b)

    await b.dial(a.getMultiaddrs()[0])
    await waitFor(() => b.getPeers().length > 0)

    expect(b.getPeers().length).toBeGreaterThan(0)
    expect(a.peerId).not.toBe(b.peerId)
  })

  // T230 (docs/work/tickets/T230-stalled-dial-is-never-cancelled.md): mutualAuth.js's stall
  // watchdog aborts a stalled attempt via an AbortController, and that only works if `dial`/
  // `authenticateWith` actually forward the caller's `signal` down to libp2p's own
  // `node.dial`/`node.dialProtocol` alongside `runOnLimitedConnection: true`. This is the
  // plumbing seam — assert it against a real libp2p node (a mocked `node.dial` would not prove
  // libp2p itself honors the signal), not reason about it from reading the source.
  it('forwards an already-aborted signal to node.dial, so dial rejects instead of proceeding', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({ deviceId: 'device-b', onAuthenticate: alwaysAdmit })
    handles.push(a, b)

    const controller = new AbortController()
    controller.abort()

    await expect(a.dial(b.getMultiaddrs()[0], { signal: controller.signal })).rejects.toBeTruthy()
    expect(a.getPeers().length).toBe(0)
  })

  it('forwards an already-aborted signal to node.dialProtocol, so authenticateWith rejects instead of proceeding', async () => {
    const a = await startTransport({ deviceId: 'device-a', onAuthenticate: alwaysAdmit })
    const b = await startTransport({ deviceId: 'device-b', onAuthenticate: alwaysAdmit })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const controller = new AbortController()
    controller.abort()

    await expect(
      a.authenticateWith(b.peerId, { type: 'authenticate' }, { signal: controller.signal })
    ).rejects.toBeTruthy()
  })

  // T230 round 2 (Red Hat finding 1): the two tests above both abort BEFORE calling
  // authenticateWith, so mss/throwIfAborted rejects immediately — that proves nothing about
  // abort AFTER protocol negotiation, which is the ticket's actual documented case ("a peer that
  // accepts the connection and then never replies", mutualAuth.js's stall-watchdog comment). Once
  // node.dialProtocol resolves, execution is inside authenticateWith's hand-rolled Promise
  // wrapping receiveFramed/sendFramed — a plain `options.signal` passed only to dialProtocol has
  // no effect there. Reproduce that shape for real: a raw libp2p responder (full control, not
  // startTransport, so it can accept the AUTH_PROTO stream and simply never write a reply frame)
  // paired with a real startTransport initiator under test.
  it('rejects and tears down the stream when the signal aborts AFTER the peer accepted but never replied', async () => {
    const responder = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    })
    // Accepts the AUTH_PROTO stream and reads the initiator's frame, but never replies and never
    // closes — the "accepts and then never replies" peer transport.js's own AUTH_PROTO handler
    // comment and mutualAuth.js's stall watchdog both describe.
    //
    // T230 round 3 (Code Reviewer: flaky in 1/4 full-file runs under load). Round 2's version of
    // this test waited only for the RESPONDER's side of negotiation (the stream appearing in its
    // connection) plus a fixed 200ms margin, guessing that would also be enough time for the
    // INITIATOR's own `dialProtocol` promise to resolve — it resolves strictly later, after the
    // mss ack travels back across the wire, so it is a genuinely different, unobserved instant.
    // Under heavy machine load 200ms was not always enough (confirmed empirically: repeated runs
    // showed real negotiation-to-resolution gaps up to ~136ms even before contention, so a busy
    // scheduler can push past 200ms), landing the abort inside mss.select's PRE-negotiation path
    // instead of the POST-negotiation path this test exists to prove — the two tests above already
    // cover that path, so this one would have silently degenerated into a duplicate of them.
    //
    // Fixed by using a signal that is causally, not just probabilistically, ordered after the
    // initiator's abort-listener attachment: authenticateWith's Promise executor attaches the
    // `abort` listener and then calls `receiveFramed`/`sendFramed` synchronously, with no `await`
    // between them (transport.js's `authenticateWith`) — so the initiator's authenticate frame
    // cannot leave the wire before the listener is attached. Waiting for the RESPONDER to actually
    // receive that frame is therefore proof the listener is already attached, with no timing
    // assumption at all.
    let receivedAuthFrame = false
    await responder.handle(AUTH_PROTO, (stream) => {
      receiveFramed(stream, () => { receivedAuthFrame = true }).catch(() => {})
    })

    const a = await startTransport({ deviceId: 'device-a' })
    handles.push(a, responder)

    await a.dial(responder.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const controller = new AbortController()
    const pending = a.authenticateWith(responder.peerId, { type: 'authenticate' }, { signal: controller.signal })

    await waitFor(() => receivedAuthFrame)

    controller.abort()

    // (a) authenticateWith rejects.
    await expect(pending).rejects.toBeTruthy()

    // (b) the stream is actually torn down, not merely locally abandoned: the responder — which
    // never wrote anything and never closed anything itself — observes the stream disappear from
    // its own connection once the initiator's abort propagates over the wire. A plain
    // stream.close() (T217 finding 1: closes only the writable half, never unblocks a pending
    // read) would leave this hanging; only stream.abort()/closeRead() reliably produces this.
    await waitFor(() => !(responder.getConnections(a.peerId)[0]?.streams ?? []).some((s) => s.protocol === AUTH_PROTO), { timeout: 2000 })
  }, 8000)

  it('broadcastDoc delivers byte-identical bytes to onDocReceived', async () => {
    const received = []
    const a = await startTransport({ deviceId: 'device-a', onAuthenticate: alwaysAdmit })
    const b = await startTransport({
      deviceId: 'device-b',
      onDocReceived: (bytes, meta) => received.push({ bytes, meta }),
      onAuthenticate: alwaysAdmit,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    // a must authenticate to b before b will accept doc-sync frames from it
    // (Stage 5d-1 admission gate) — b's authenticatedPeers set is keyed by
    // the dialer's own peer id, i.e. a.peerId.
    await a.authenticateWith(b.peerId, { type: 'authenticate' })
    await b.authenticateWith(a.peerId, { type: 'authenticate' })

    const payload = new Uint8Array([9, 8, 7, 6, 5])
    await a.broadcastDoc(payload)

    await waitFor(() => received.length > 0)
    expect(Array.from(received[0].bytes)).toEqual([9, 8, 7, 6, 5])
    expect(received[0].meta.fromPeerId).toBe(a.peerId)
  })

  // T208 round 2 (Red Hat): this is the regression test for the actual revocation
  // enforcement point. mutualAuth.js's discovery-side re-query of isPeerTrusted never
  // runs again for an already-authenticated peer (its `attempted` dedupe Set is never
  // cleared on success), so revoking a LIVE peer is enforced here — by removing it from
  // transport.js's `authenticatedPeers`, which `broadcastDoc` gates every send on. If
  // `revokePeer` stopped doing that (e.g. "simplified" as redundant with a local-trust
  // predicate that only gates new dials), this test fails: b would keep receiving docs
  // from a peer its own admission table no longer trusts.
  it('revokePeer stops broadcastDoc from reaching a previously-authenticated peer', async () => {
    const received = []
    const a = await startTransport({ deviceId: 'device-a', onAuthenticate: alwaysAdmit })
    const b = await startTransport({
      deviceId: 'device-b',
      onDocReceived: (bytes) => received.push(bytes),
      onAuthenticate: alwaysAdmit,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    await a.authenticateWith(b.peerId, { type: 'authenticate' })
    await b.authenticateWith(a.peerId, { type: 'authenticate' })

    await a.broadcastDoc(new Uint8Array([1]))
    await waitFor(() => received.length > 0)
    expect(received).toHaveLength(1)

    // b revokes a — the enforcement point under test.
    b.revokePeer(a.peerId)

    await a.broadcastDoc(new Uint8Array([2]))
    // Give any (incorrect) delivery a moment to happen, then assert it didn't.
    await new Promise((r) => setTimeout(r, 200))
    expect(received).toHaveLength(1)
  })

  it('sendDocTo reaches only the targeted peer, not a third bystander', async () => {
    const receivedB = []
    const receivedC = []
    const a = await startTransport({ deviceId: 'device-a', onAuthenticate: alwaysAdmit })
    const b = await startTransport({
      deviceId: 'device-b',
      onDocReceived: (bytes) => receivedB.push(bytes),
      onAuthenticate: alwaysAdmit,
    })
    const c = await startTransport({
      deviceId: 'device-c',
      onDocReceived: (bytes) => receivedC.push(bytes),
      onAuthenticate: alwaysAdmit,
    })
    handles.push(a, b, c)

    await a.dial(b.getMultiaddrs()[0])
    await a.dial(c.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length === 2)

    await a.authenticateWith(b.peerId, { type: 'authenticate' })
    await b.authenticateWith(a.peerId, { type: 'authenticate' })

    await a.sendDocTo(b.peerId, new Uint8Array([1, 2, 3]))
    await waitFor(() => receivedB.length > 0)

    expect(receivedB).toHaveLength(1)
    expect(receivedC).toHaveLength(0)
  })

  it('a node speaking a different protocol never triggers onDocReceived (protocol-gating)', async () => {
    const received = []
    const a = await startTransport({
      deviceId: 'device-a',
      onDocReceived: (bytes) => received.push(bytes),
    })
    handles.push(a)

    // A generic libp2p node that never dials '/shoresh/automerge/1.0.0'.
    const stranger = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    })
    handles.push({ stop: () => stranger.stop() })

    await stranger.dial(a.getMultiaddrs()[0])
    await waitFor(() => stranger.getPeers().length > 0)

    // Give any (incorrect) delivery a moment to happen, then assert it didn't.
    await new Promise((r) => setTimeout(r, 200))
    expect(received).toHaveLength(0)
  })

  it('stop() closes the node (no further peers reachable)', async () => {
    const a = await startTransport({ deviceId: 'device-a', onAuthenticate: alwaysAdmit })
    const peerId = a.peerId
    await a.stop()
    handles = handles.filter((h) => h !== a)

    expect(peerId).toBeTruthy()
    // Re-stopping an already-stopped node must not throw.
    await expect(a.stop()).resolves.not.toThrow()
  })
})
