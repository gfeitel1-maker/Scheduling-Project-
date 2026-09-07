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
import { PAIRING_RATE_MS, LOGIN_MIN_INTERVAL_MS } from '../rateLimit.js'

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

    // Stage 5d-2b implements pairing_request/login too now — use a message
    // type that is genuinely unsupported by any flow.
    await expect(
      a.authenticateWith(b.peerId, { type: 'bogus_message_type', device_id: 'device-a' })
    ).rejects.toThrow()
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
  })
})

describe('authGate — pairing_request/login mechanics (fake decision functions, Stage 5d-2b)', () => {
  it('an already-approved device gets pairing_approved immediately, on the SAME stream', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onPairingRequest: () => ({ ok: true, alreadyApproved: true, device_secret_identifier: 'secret-xyz' }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const reply = await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    expect(reply).toEqual({ type: 'pairing_approved', device_secret_identifier: 'secret-xyz' })
  })

  it('a fresh device gets pairing_pending, then the director decision arrives later on a NEW stream', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    let sendPairingApproved
    const b = await startTransport({
      deviceId: 'device-b',
      onPairingRequest: () => ({ ok: true, alreadyApproved: false }),
    })
    sendPairingApproved = b.sendPairingApproved
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const pending = await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    expect(pending).toEqual({ type: 'pairing_pending' })

    // The director's decision, delivered well after the original pairing_request
    // stream has already closed — proves it travels over a freshly-dialed stream.
    const delivered = await sendPairingApproved('device-a', 'secret-abc')
    expect(delivered).toBe(true)
  })

  it('a denied device gets pairing_denied', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onPairingRequest: () => ({ ok: false }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const reply = await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    expect(reply).toEqual({ type: 'pairing_denied' })
  })

  it('login success returns login_ok with the decision function\'s token/userId/role', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onLogin: () => ({ ok: true, token: 'tok-1', userId: 'u1', role: 'director' }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const reply = await a.authenticateWith(b.peerId, { type: 'login', device_id: 'device-a', name: 'Bob', pin: '1234' })
    expect(reply).toEqual({ type: 'login_ok', token: 'tok-1', userId: 'u1', role: 'director' })
  })

  it('login failure (including lockout) returns login_failed, opaque reason not leaked', async () => {
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onLogin: () => ({ ok: false, reason: 'locked', locked: true, retryAfterMs: 5000 }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const reply = await a.authenticateWith(b.peerId, { type: 'login', device_id: 'device-a', name: 'Bob', pin: 'wrong' })
    expect(reply).toEqual({ type: 'login_failed', locked: true, retryAfterMs: 5000 })
    expect(reply.reason).toBeUndefined()
  })
})

// HIGH finding, Stage 5d-2b re-review (ADR §6, docs/adr/2026-09-06-libp2p-membership-mapping.md):
// syncServer.js's WS handling of pairing_request/login is rate-limited and
// pending-capped; the libp2p path through authGate.js had NONE of that. These
// tests use an injectable `now` (mirroring syncServer.js's own `now` option)
// so the throttle boundary is proven by arithmetic, not by racing a real
// clock — same rationale as rateLimit.test.js.
describe('authGate — rate limiting (HIGH finding fix, Stage 5d-2b re-review)', () => {
  it('a flood of pairing_request frames from one peer is throttled', async () => {
    let calls = 0
    let t = 1000
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onPairingRequest: () => {
        calls++
        return { ok: true, alreadyApproved: false }
      },
      now: () => t,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const first = await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    expect(first).toEqual({ type: 'pairing_pending' })
    expect(calls).toBe(1)

    // Same instant (t unchanged), same connection — well inside PAIRING_RATE_MS.
    // The decision function must never even be called for the throttled frame.
    await expect(
      a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('rotating device_id on the SAME connection does not evade the throttle', async () => {
    let calls = 0
    let t = 1000
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onPairingRequest: () => {
        calls++
        return { ok: true, alreadyApproved: false }
      },
      now: () => t,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-x1', device_name: 'A' })
    expect(calls).toBe(1)

    // A DIFFERENT claimed device_id, same peer/connection, same instant — the
    // per-peer half of the throttle must still catch it even though the
    // per-device map has never seen 'device-x2' before.
    await expect(
      a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-x2', device_name: 'A' })
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('MAX_PENDING_PAIRING caps concurrently pending requests, independent of throttling', async () => {
    let calls = 0
    let t = 1000
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onPairingRequest: () => {
        calls++
        return { ok: true, alreadyApproved: false }
      },
      now: () => t,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    // 50 distinct device_ids, each well clear of PAIRING_RATE_MS from the
    // last — none of these are throttled, so the cap being hit below is
    // proven to be the pending-count cap, not the rate limit.
    for (let i = 0; i < 50; i++) {
      t += PAIRING_RATE_MS + 1
      const reply = await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: `device-${i}`, device_name: 'A' })
      expect(reply).toEqual({ type: 'pairing_pending' })
    }
    expect(calls).toBe(50)

    t += PAIRING_RATE_MS + 1
    await expect(
      a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-overflow', device_name: 'A' })
    ).rejects.toThrow()
    expect(calls).toBe(50)
  })

  it('login attempts are rate-limited on the same connection', async () => {
    let calls = 0
    let t = 1000
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onLogin: () => {
        calls++
        return { ok: false }
      },
      now: () => t,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    await a.authenticateWith(b.peerId, { type: 'login', device_id: 'device-a', name: 'Bob', pin: '1234' })
    expect(calls).toBe(1)

    await expect(
      a.authenticateWith(b.peerId, { type: 'login', device_id: 'device-a', name: 'Bob', pin: '1234' })
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('a legitimate single pairing_request still succeeds unimpeded, and spaced-out requests both go through', async () => {
    let calls = 0
    let t = 1000
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onPairingRequest: () => {
        calls++
        return { ok: true, alreadyApproved: false }
      },
      now: () => t,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const first = await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    expect(first).toEqual({ type: 'pairing_pending' })

    t += PAIRING_RATE_MS + 1
    const second = await a.authenticateWith(b.peerId, { type: 'pairing_request', device_id: 'device-a', device_name: 'A' })
    expect(second).toEqual({ type: 'pairing_pending' })
    expect(calls).toBe(2)
  })

  it('a legitimate single login still succeeds unimpeded, and spaced-out attempts both go through', async () => {
    let calls = 0
    let t = 1000
    const a = await startTransport({ deviceId: 'device-a' })
    const b = await startTransport({
      deviceId: 'device-b',
      onLogin: () => {
        calls++
        return { ok: true, token: 'tok', userId: 'u1', role: 'staff' }
      },
      now: () => t,
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const first = await a.authenticateWith(b.peerId, { type: 'login', device_id: 'device-a', name: 'Bob', pin: '1234' })
    expect(first.type).toBe('login_ok')

    t += LOGIN_MIN_INTERVAL_MS + 1
    const second = await a.authenticateWith(b.peerId, { type: 'login', device_id: 'device-a', name: 'Bob', pin: '1234' })
    expect(second.type).toBe('login_ok')
    expect(calls).toBe(2)
  })
})

// Security review, Stage 5d-1 (CRITICAL): the gate was originally INBOUND ONLY.
// broadcastDoc iterated node.getPeers() — every libp2p-connected peer — filtered
// only by exceptPeerId, so a stranger who merely completed a noise handshake and
// never dialed AUTH_PROTO still received the full serialized camp document on
// every local write. These assert the gate is symmetric: an unauthenticated peer
// receives NOTHING outbound, and an authenticated one still does.
describe('authGate — broadcast is gated outbound, not just inbound', () => {
  it('does NOT broadcast the document to a connected but unauthenticated peer', async () => {
    const eavesdropped = []
    // `a` is a plain connected peer that never authenticates to `b`, but happily
    // accepts doc frames — i.e. exactly what a stranger's node on the camp LAN is.
    const a = await startTransport({
      deviceId: 'device-a',
      onDocReceived: (bytes) => eavesdropped.push(bytes),
    })
    const b = await startTransport({
      deviceId: 'device-b',
      onAuthenticate: () => ({ ok: true }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => b.getPeers().length > 0)
    expect(b.isPeerAuthenticated(a.peerId.toString())).toBe(false)

    await b.broadcastDoc(new Uint8Array([1, 2, 3, 4]))

    // Give any in-flight frame a chance to land before asserting absence.
    await new Promise((r) => setTimeout(r, 300))
    expect(eavesdropped).toEqual([])
  })

  // NOTE (design fact, learned the hard way here): admission is ONE-DIRECTIONAL.
  // `a` authenticating to `b` only populates B's set, so B will now send to A —
  // but A's own INBOUND gate still rejects B's frames until B has authenticated
  // to A as well. Ongoing two-way sync therefore requires MUTUAL authentication,
  // which is a real constraint on 5d-2's production wiring: a Client that
  // authenticates to the Host and stops there will send successfully and receive
  // nothing, silently. Asserted explicitly below so the requirement is pinned.
  it('DOES broadcast to a peer that completed the auth handshake (mutual)', async () => {
    const received = []
    const a = await startTransport({
      deviceId: 'device-a',
      onDocReceived: (bytes) => received.push(bytes),
      onAuthenticate: () => ({ ok: true }),
    })
    const b = await startTransport({
      deviceId: 'device-b',
      onAuthenticate: () => ({ ok: true }),
    })
    handles.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => b.getPeers().length > 0)
    await a.authenticateWith(b.peerId.toString(), { type: 'authenticate', token: 't', device_id: 'device-a' })
    await b.authenticateWith(a.peerId.toString(), { type: 'authenticate', token: 't', device_id: 'device-b' })
    await waitFor(() => b.isPeerAuthenticated(a.peerId.toString()) && a.isPeerAuthenticated(b.peerId.toString()))

    await b.broadcastDoc(new Uint8Array([1, 2, 3, 4]))
    await waitFor(() => received.length > 0)
    expect(received.length).toBe(1)
  })
})
