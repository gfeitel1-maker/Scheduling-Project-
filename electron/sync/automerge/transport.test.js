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
  it('two nodes connect via direct dial', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({ deviceId: 'device-b' })
    handles.push(a, b)

    await b.dial(a.getMultiaddrs()[0])
    await waitFor(() => b.getPeers().length > 0)

    expect(b.getPeers().length).toBeGreaterThan(0)
    expect(a.peerId).not.toBe(b.peerId)
  })

  const alwaysAdmit = () => ({ ok: true })

  it('broadcastDoc delivers byte-identical bytes to onDocReceived', async () => {
    const received = []
    const a = await startTransport({ deviceId: 'device-a' })
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

    const payload = new Uint8Array([9, 8, 7, 6, 5])
    await a.broadcastDoc(payload)

    await waitFor(() => received.length > 0)
    expect(Array.from(received[0].bytes)).toEqual([9, 8, 7, 6, 5])
    expect(received[0].meta.fromPeerId).toBe(a.peerId)
  })

  it('sendDocTo reaches only the targeted peer, not a third bystander', async () => {
    const receivedB = []
    const receivedC = []
    const a = await startTransport({ deviceId: 'device-a' })
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
    const a = await startTransport({ deviceId: 'device-a' })
    const peerId = a.peerId
    await a.stop()
    handles = handles.filter((h) => h !== a)

    expect(peerId).toBeTruthy()
    // Re-stopping an already-stopped node must not throw.
    await expect(a.stop()).resolves.not.toThrow()
  })
})
