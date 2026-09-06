// @vitest-environment node
//
// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §1/§3): protocol-
// level tests for the auth handshake and the admission gate it feeds, using a
// FAKE onAuthenticate (no localAuth/SQLite involved) so this file proves
// transport.js's/authGate.js's own mechanics in isolation: message framing,
// admission-set population, gating order, and disconnect cleanup. The real
// security-relevant decision (token verify/reject-local/trust-check) is
// covered by connectionAuth.test.js and syncNodeAuthGate.test.js, which wire
// the real evaluateAuthenticate through this same mechanism.
import { describe, it, expect, afterEach } from 'vitest'
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

describe('authGate — admission gate mechanics (fake authenticator)', () => {
  it('an unauthenticated peer dialing doc-sync directly never reaches onDocReceived', async () => {
    const received = []
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onDocReceived: (bytes) => received.push(bytes),
      onAuthenticate: () => ({ ok: false, reason: 'invalid_token' }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    // a never authenticates — dials doc-sync directly, exactly the attack
    // this gate exists to close. The send may itself throw (stream aborted
    // before/while written) or resolve (abort races a buffered write) —
    // either way, what matters is checked below: onDocReceived never fires.
    await a.sendDocTo(b.peerId, new Uint8Array([1, 2, 3])).catch(() => {})

    await new Promise((r) => setTimeout(r, 150))
    expect(received).toHaveLength(0)
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
  })

  it('a peer that completes authenticate successfully is admitted and its doc bytes are delivered', async () => {
    const received = []
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onDocReceived: (bytes) => received.push(bytes),
      onAuthenticate: (msg) => (msg.token === 'good-token' ? { ok: true } : { ok: false, reason: 'invalid_token' }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const resp = await a.authenticateWith(b.peerId, { type: 'authenticate', token: 'good-token', device_id: 'device-a' })
    expect(resp).toEqual({ type: 'auth_ok' })
    expect(b.isPeerAuthenticated(a.peerId)).toBe(true)

    await a.sendDocTo(b.peerId, new Uint8Array([1, 2, 3]))
    await waitFor(() => received.length > 0)
    expect(Array.from(received[0])).toEqual([1, 2, 3])
  })

  it('a failed authenticate reports auth_failed and does NOT admit the peer', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onAuthenticate: () => ({ ok: false, reason: 'device_revoked' }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const resp = await a.authenticateWith(b.peerId, { type: 'authenticate', token: 'x', device_id: 'device-a' })
    expect(resp).toEqual({ type: 'auth_failed', reason: 'device_revoked' })
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
  })

  it('after disconnect, a previously-authenticated peer is no longer admitted (stale-entry hole)', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onAuthenticate: () => ({ ok: true }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    await a.authenticateWith(b.peerId, { type: 'authenticate', token: 'x', device_id: 'device-a' })
    expect(b.isPeerAuthenticated(a.peerId)).toBe(true)

    await a.stop()
    handles = handles.filter((h) => h !== a)

    await waitFor(() => b.isPeerAuthenticated(a.peerId) === false)
  })

  it('an unsupported auth message type is rejected, not silently ignored', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onAuthenticate: () => ({ ok: true }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    // 5d-1 implements `authenticate` only — pairing_request/login are 5d-2.
    await expect(
      a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    ).rejects.toThrow()
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
  })
})
