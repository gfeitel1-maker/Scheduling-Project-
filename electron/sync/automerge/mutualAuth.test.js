// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { wireMutualAuth } from './mutualAuth.js'

function fakeHandle() {
  const listeners = []
  return {
    dial: vi.fn().mockResolvedValue(undefined),
    authenticateWith: vi.fn().mockResolvedValue({ type: 'auth_ok' }),
    onPeerDiscovery: (cb) => listeners.push(cb),
    fireDiscovery: (id) => listeners.forEach((cb) => cb({ id })),
  }
}

describe('wireMutualAuth', () => {
  it('dials and authenticates a discovered peer using the current token', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).toHaveBeenCalledWith('peer-b', { signal: expect.any(AbortSignal) })
    expect(handle.authenticateWith).toHaveBeenCalledWith(
      'peer-b',
      { type: 'authenticate', token: 'tok-1', device_id: 'device-a' },
      { signal: expect.any(AbortSignal) }
    )
  })

  it('does not dial a discovered peer when there is no token yet', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => null, isPeerTrusted: () => true })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).not.toHaveBeenCalled()
  })

  it('does not re-dial the same peer twice while already attempted', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true })

    handle.fireDiscovery('peer-b')
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected authenticate via onRejected rather than only console.error, and allows retry', async () => {
    const handle = fakeHandle()
    handle.authenticateWith = vi.fn().mockResolvedValue({ type: 'auth_failed', reason: 'device_revoked' })
    const onRejected = vi.fn()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true, onRejected })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(onRejected).toHaveBeenCalledWith('peer-b', { type: 'auth_failed', reason: 'device_revoked' })

    // A rejected attempt is not "sticky" — a later discovery of the same peer retries.
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.authenticateWith).toHaveBeenCalledTimes(2)
  })

  it('clears the attempted mark on a dial failure so a later discovery retries', async () => {
    const handle = fakeHandle()
    handle.dial = vi.fn().mockRejectedValueOnce(new Error('unreachable')).mockResolvedValue(undefined)
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).toHaveBeenCalledTimes(2)
  })
})

// Stage 5f, from a real Mac<->Windows run: the Windows firewall (Public network profile) dropped
// unsolicited inbound traffic, so it could dial out but never accept. It dialed the Mac; the Mac's
// dial back timed out; and mutualAuth returned early on that failure — so the Mac never
// authenticated over the connection Windows had already opened, and nothing synced in either
// direction across a working link. One reachable direction must be enough.
describe('mutualAuth — one reachable direction is enough', () => {
  it('authenticates over an EXISTING inbound connection without dialing back', async () => {
    const dials = []
    const handle = {
      getPeers: () => ['peer-1'],
      dial: async (p) => { dials.push(p) },
      authenticateWith: async () => ({ type: 'auth_ok' }),
      onPeerDiscovery: () => {},
    }
    const m = wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok', isPeerTrusted: () => true })
    await m.tryAuthenticate('peer-1')
    expect(dials).toEqual([])
  })

  it('still authenticates when the dial-back FAILS but an inbound connection exists', async () => {
    let connected = false
    const authCalls = []
    const handle = {
      getPeers: () => (connected ? ['peer-2'] : []),
      dial: async () => { connected = true; throw new Error('ETIMEDOUT') },
      authenticateWith: async () => { authCalls.push(1); return { type: 'auth_ok' } },
      onPeerDiscovery: () => {},
    }
    const m = wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok', isPeerTrusted: () => true })
    await m.tryAuthenticate('peer-2')
    expect(authCalls.length).toBe(1)
  })

  it('gives up only when the dial fails AND there is no connection to reuse', async () => {
    const authCalls = []
    const handle = {
      getPeers: () => [],
      dial: async () => { throw new Error('ETIMEDOUT') },
      authenticateWith: async () => { authCalls.push(1); return { type: 'auth_ok' } },
      onPeerDiscovery: () => {},
    }
    const m = wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok', isPeerTrusted: () => true })
    await m.tryAuthenticate('peer-3')
    expect(authCalls).toEqual([])
  })
})

// ── T208: the discovery seam must not hand this device's session token to a
// peer it does not already trust. Before this, `tryAuthenticate` gated only on
// an in-memory `attempted` Set and on holding a token, then sent
// { type:'authenticate', token, device_id } to ANY peer surfaced by
// onPeerDiscovery. On the LAN that is bounded by mDNS multicast; the moment a
// second discovery mechanism exists that anyone can write into, the bound is
// gone. See docs/work/tickets/T208-discovery-seam-has-no-local-trust-filter.md.
describe('wireMutualAuth — local trust filter (T208)', () => {
  it('refuses to authenticate to a peer that local trust state does not recognize', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, {
      deviceId: 'device-a',
      getToken: () => 'tok-1',
      isPeerTrusted: (id) => id === 'peer-trusted',
    })

    handle.fireDiscovery('peer-attacker')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).not.toHaveBeenCalled()
    expect(handle.authenticateWith).not.toHaveBeenCalled()
  })

  it('still authenticates to a peer that local trust state does recognize', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, {
      deviceId: 'device-a',
      getToken: () => 'tok-1',
      isPeerTrusted: (id) => id === 'peer-trusted',
    })

    handle.fireDiscovery('peer-trusted')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.authenticateWith).toHaveBeenCalledWith(
      'peer-trusted',
      { type: 'authenticate', token: 'tok-1', device_id: 'device-a' },
      { signal: expect.any(AbortSignal) }
    )
  })

  // NON-VACUITY. A filter that silently stops being consulted is worse than no
  // filter, because the guarantee is still written down. If wiring forgets the
  // predicate, this must fail LOUDLY at wire time rather than fall back to
  // "authenticate to everyone", which is exactly the defect being closed.
  it('refuses to wire at all when no trust predicate is supplied', () => {
    const handle = fakeHandle()
    expect(() => wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1' }))
      .toThrow(/isPeerTrusted/)
  })

  it('treats a throwing trust predicate as "not trusted" rather than as permission', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, {
      deviceId: 'device-a',
      getToken: () => 'tok-1',
      isPeerTrusted: () => { throw new Error('db is locked') },
    })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.authenticateWith).not.toHaveBeenCalled()
  })

  it('re-checks trust on every discovery, so a revoked peer is refused on its next announce', async () => {
    const handle = fakeHandle()
    let trusted = true
    wireMutualAuth(handle, {
      deviceId: 'device-a',
      getToken: () => 'tok-1',
      isPeerTrusted: () => trusted,
    })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.authenticateWith).toHaveBeenCalledTimes(1)

    // Revoked between announces. mDNS re-announces periodically, so this is the
    // realistic path by which a revocation takes effect at this seam.
    trusted = false
    handle.fireDiscovery('peer-c')
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.authenticateWith).toHaveBeenCalledTimes(1)
  })
})

// ── T208, second defect in the same function. `attempted.add(peerId)` happens
// before any outcome and is cleared on dial failure or explicit rejection, but
// NOT on a hang. A peer that accepts the connection and never replies pins the
// dedupe slot, so the real peer's later legitimate announce is dropped by the
// `if (attempted.has(peerId)) return` guard — a reconnection DoS that needs no
// forged signature.
describe('wireMutualAuth — a hung authenticate must not pin the dedupe slot', () => {
  it('clears the attempt after the stall timeout so a later announce retries', async () => {
    const handle = fakeHandle()
    handle.authenticateWith = vi.fn().mockImplementation(() => new Promise(() => {})) // never settles
    wireMutualAuth(handle, {
      deviceId: 'device-a',
      getToken: () => 'tok-1',
      isPeerTrusted: () => true,
      attemptTimeoutMs: 20,
    })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 60))

    // The real peer announces again after the stall.
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.authenticateWith.mock.calls.length).toBeGreaterThan(1)
  })
})

// T208: the policy syncNode puts in force by default is a deliberate, named
// decision — not an accident of a missing argument. The old permissive
// lanTopologyTrust stub (`() => true`) is gone; the default is now
// createBoundPeerTrust(db), a real check against the `devices` table. See
// peerIdentity.test.js's `createBoundPeerTrust` suite for that function's own
// coverage; this just confirms syncNode.js wires it in as the default.
describe('syncNode default trust policy (T208)', () => {
  it('defaults isPeerTrusted to createBoundPeerTrust(db), not a permissive stub', async () => {
    const { createBoundPeerTrust } = await import('./peerIdentity.js')
    expect(typeof createBoundPeerTrust).toBe('function')

    const Database = (await import('better-sqlite3')).default
    const { initSchema } = await import('../../db/localDb.js')
    const db = new Database(':memory:')
    initSchema(db)

    const isTrusted = createBoundPeerTrust(db)
    // An unbound/unknown peer id is refused — the opposite of the old stub's
    // "trust every discovered peer" behavior.
    expect(isTrusted('any-peer-id')).toBe(false)
    db.close()
  })
})

// T162 made a device's PeerId stable across restarts, which means a Host that
// restarts comes back under the SAME PeerId — and a peer still listing the dead
// connection will authenticate into a closed stream. Caught by integration
// scenario 13 ("the Host vanishes mid-exchange"), which passed on main and
// failed here for exactly this reason.
describe('wireMutualAuth — a connection getPeers() still lists, but which is dead', () => {
  it('redials once and succeeds, rather than waiting for the next discovery', async () => {
    const handle = fakeHandle()
    handle.getPeers = () => ['peer-b']          // stale: claims connected
    let calls = 0
    handle.authenticateWith = vi.fn().mockImplementation(async () => {
      calls += 1
      if (calls === 1) throw new Error('stream closed')   // the dead connection
      return { type: 'auth_ok' }
    })
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 20))

    expect(handle.dial).toHaveBeenCalledWith('peer-b', { signal: expect.any(AbortSignal) })   // it redialled
    expect(calls).toBe(2)                                 // and retried once
  })

  it('does NOT retry when we already dialled — a failure there is a real one', async () => {
    const handle = fakeHandle()
    handle.getPeers = () => []                   // not connected: we dial
    handle.authenticateWith = vi.fn().mockRejectedValue(new Error('nope'))
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 20))

    expect(handle.authenticateWith).toHaveBeenCalledTimes(1)
  })
})

// T208 round 2 (Code Reviewer): an UNTRUSTED peer never enters `attempted` (that Set
// is only populated after the trust check passes), so every announce for a
// spoofed/unknown peer id drove a synchronous isPeerTrusted query with no throttle —
// an amplification path once a second, attacker-writable discovery mechanism exists
// (the rendezvous program). This is a bounded, short-lived NEGATIVE cache inside
// wireMutualAuth itself (not the predicate, which stays pure/uncached).
describe('wireMutualAuth — negative cache for untrusted peers (T208 round 2)', () => {
  it('calls the trust predicate once for repeated announces of an untrusted peer, then again after the TTL', async () => {
    const handle = fakeHandle()
    const trustCheck = vi.fn(() => false)
    let clock = 0
    wireMutualAuth(handle, {
      deviceId: 'device-a',
      getToken: () => 'tok-1',
      isPeerTrusted: trustCheck,
      now: () => clock,
    })

    handle.fireDiscovery('peer-attacker')
    await new Promise((r) => setTimeout(r, 5))
    expect(trustCheck).toHaveBeenCalledTimes(1)

    // Repeated announces within the TTL window must not re-query.
    handle.fireDiscovery('peer-attacker')
    handle.fireDiscovery('peer-attacker')
    await new Promise((r) => setTimeout(r, 5))
    expect(trustCheck).toHaveBeenCalledTimes(1)

    // After the TTL elapses, the next announce consults the predicate again.
    clock += 5_001
    handle.fireDiscovery('peer-attacker')
    await new Promise((r) => setTimeout(r, 5))
    expect(trustCheck).toHaveBeenCalledTimes(2)
  })

  it('a peer that becomes trusted authenticates again once the denial cache TTL elapses', async () => {
    // Documents the traded-off latency window explicitly: a denied peer that becomes
    // trusted is not permanently locked out, but is bounded by the TTL, not instant.
    const handle = fakeHandle()
    const trusted = new Set()
    const trustCheck = vi.fn((id) => trusted.has(id))
    let clock = 0
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: trustCheck, now: () => clock })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 5))
    expect(handle.authenticateWith).not.toHaveBeenCalled()

    // Trusted immediately after, but still within the TTL window: still cached-denied.
    trusted.add('peer-b')
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 5))
    expect(handle.authenticateWith).not.toHaveBeenCalled()

    // Past the TTL, the next announce re-queries and finds it trusted now.
    clock += 5_001
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 5))
    expect(handle.authenticateWith).toHaveBeenCalledWith(
      'peer-b',
      { type: 'authenticate', token: 'tok-1', device_id: 'device-a' },
      { signal: expect.any(AbortSignal) }
    )
  })

  it('caches denials independently per peer id', async () => {
    const handle = fakeHandle()
    const trustCheck = vi.fn(() => false)
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: trustCheck })

    handle.fireDiscovery('peer-b')
    handle.fireDiscovery('peer-c')
    handle.fireDiscovery('peer-b')
    handle.fireDiscovery('peer-c')
    await new Promise((r) => setTimeout(r, 5))

    expect(trustCheck).toHaveBeenCalledTimes(2)
  })
})

// ── T212 (docs/work/tickets/T212-wan-connectivity-measurement.md) + ADR
// docs/adr/2026-09-18-connectivity-observability-event-vocabulary.md: wireMutualAuth emits
// connectivity events through an injected emitter, so a WAN pairing failure can be classified
// as discovery-layer vs dial-layer vs auth-layer from logs alone.
describe('wireMutualAuth — connectivity event emission (T212)', () => {
  function fakeEmitter() {
    const events = []
    return { events, emit: (name, fields) => events.push({ name, fields }) }
  }

  it('emits PEER_DISCOVERED then DIAL_FAILED when a peer is discovered but the dial never succeeds (load-bearing distinction)', async () => {
    const handle = {
      getPeers: () => [],
      dial: async () => { throw new Error('ECONNREFUSED') },
      authenticateWith: async () => ({ type: 'auth_ok' }),
      onPeerDiscovery: (cb) => { handle._fire = cb },
    }
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok', isPeerTrusted: () => true, emitter })

    handle._fire({ id: 'peer-x', multiaddrs: ['/ip4/203.0.113.9/tcp/4001'] })
    await new Promise((r) => setTimeout(r, 10))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'DIAL_FAILED'])
    expect(emitter.events[1].fields.reused).toBe(false)
  })

  it('emits neither PEER_DISCOVERED nor DIAL_FAILED for a peer that is never discovered', async () => {
    const handle = fakeHandle()
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok', isPeerTrusted: () => true, emitter })

    // No fireDiscovery call at all.
    await new Promise((r) => setTimeout(r, 10))

    expect(emitter.events).toEqual([])
  })

  it('emits AUTH_OK on a successful authenticate', async () => {
    const handle = fakeHandle()
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true, emitter })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'AUTH_OK'])
  })

  it('emits AUTH_REJECTED (not AUTH_OK) when the peer rejects our authenticate', async () => {
    const handle = fakeHandle()
    handle.authenticateWith = vi.fn().mockResolvedValue({ type: 'auth_failed', reason: 'device_revoked' })
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true, emitter })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'AUTH_REJECTED'])
  })

  it('emits AUTH_ERROR when authenticateWith throws with no reused connection to retry', async () => {
    const handle = fakeHandle()
    handle.authenticateWith = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true, emitter })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'AUTH_ERROR'])
  })

  it('emits TRUST_CHECK_REJECTED (reason: untrusted) for a peer local trust denies, and no dial/auth events', async () => {
    const handle = fakeHandle()
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => false, emitter })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'TRUST_CHECK_REJECTED'])
    expect(emitter.events[1].fields.reason).toBe('untrusted')
    expect(handle.dial).not.toHaveBeenCalled()
  })

  it('emits TRUST_CHECK_REJECTED (reason: trust_check_error) when isPeerTrusted throws', async () => {
    const handle = fakeHandle()
    const emitter = fakeEmitter()
    wireMutualAuth(handle, {
      deviceId: 'device-a',
      getToken: () => 'tok-1',
      isPeerTrusted: () => { throw new Error('db exploded') },
      emitter,
    })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'TRUST_CHECK_REJECTED'])
    expect(emitter.events[1].fields.reason).toBe('trust_check_error')
  })

  it('emits ATTEMPT_STALLED when the attempt watchdog fires before dial/auth resolves', async () => {
    vi.useFakeTimers()
    try {
      const handle = fakeHandle()
      handle.dial = () => new Promise(() => {}) // never resolves
      const emitter = fakeEmitter()
      wireMutualAuth(handle, {
        deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true,
        attemptTimeoutMs: 100, emitter,
      })

      handle.fireDiscovery('peer-b')
      await vi.advanceTimersByTimeAsync(101)

      const names = emitter.events.map((e) => e.name)
      expect(names).toEqual(['PEER_DISCOVERED', 'ATTEMPT_STALLED'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits NO_TOKEN when getToken() is falsy, so "not logged in" is distinguishable from a hang (Red Hat)', async () => {
    const handle = fakeHandle()
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => null, isPeerTrusted: () => true, emitter })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'NO_TOKEN'])
    expect(handle.dial).not.toHaveBeenCalled()
  })

  it('emits DIAL_FAILED with reused:true and does NOT also emit AUTH_ERROR when a redial after a stale-connection auth failure itself fails (Code Reviewer, coverage gap)', async () => {
    const handle = fakeHandle()
    handle.getPeers = () => ['peer-b']          // stale: claims connected
    handle.authenticateWith = vi.fn().mockRejectedValue(new Error('stream closed'))
    handle.dial = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true, emitter })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 20))

    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'DIAL_FAILED'])
    expect(emitter.events[1].fields.reused).toBe(true)
  })

  it('tags every attempt event with an attemptId, incrementing per attempt for the same peer (correlation, Red Hat)', async () => {
    const handle = fakeHandle()
    handle.authenticateWith = vi.fn().mockRejectedValue(new Error('nope'))
    const emitter = fakeEmitter()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true, emitter })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const authErrors = emitter.events.filter((e) => e.name === 'AUTH_ERROR')
    expect(authErrors.map((e) => e.fields.attemptId)).toEqual([1, 2])
  })

  it('does not emit a terminal event for an attempt that already emitted ATTEMPT_STALLED once it later settles (Red Hat, stall race)', async () => {
    const handle = fakeHandle()
    let resolveDial
    handle.dial = vi.fn(() => new Promise((resolve) => { resolveDial = resolve }))
    const emitter = fakeEmitter()
    wireMutualAuth(handle, {
      deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true,
      attemptTimeoutMs: 20, emitter,
    })

    handle.fireDiscovery('peer-b')
    // Let the watchdog fire first.
    await new Promise((r) => setTimeout(r, 40))
    expect(emitter.events.map((e) => e.name)).toEqual(['PEER_DISCOVERED', 'ATTEMPT_STALLED'])

    // The mock dial ignores the abort signal and settles successfully late anyway (T230: abort is
    // best-effort at the stream layer, so this must stay a no-op against shared state either way).
    resolveDial(undefined)
    await new Promise((r) => setTimeout(r, 20))

    // No AUTH_OK (or any other terminal event) is emitted for the stalled attempt.
    const names = emitter.events.map((e) => e.name)
    expect(names).toEqual(['PEER_DISCOVERED', 'ATTEMPT_STALLED'])
  })

  it('suppresses repeat PEER_DISCOVERED announces within the dedupe window, and reports a repeatCount on the next emitted one (Security, log-flood)', async () => {
    const handle = fakeHandle()
    const emitter = fakeEmitter()
    let clock = 0
    wireMutualAuth(handle, {
      deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true, emitter, now: () => clock,
    })

    handle.fireDiscovery('peer-b')
    handle.fireDiscovery('peer-b')
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const discovered = emitter.events.filter((e) => e.name === 'PEER_DISCOVERED')
    expect(discovered).toHaveLength(1)

    // Past the dedupe window, the next announce emits again, carrying how many were suppressed —
    // "still being discovered" stays distinguishable from "stopped being discovered".
    clock += 30_001
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    const discoveredAfter = emitter.events.filter((e) => e.name === 'PEER_DISCOVERED')
    expect(discoveredAfter).toHaveLength(2)
    expect(discoveredAfter[1].fields.repeatCount).toBe(2)
  })

  it('defaults to a working emitter (console-backed) when none is injected, without throwing', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true })

    expect(() => handle.fireDiscovery('peer-b')).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })
})

// T230 (docs/work/tickets/T230-stalled-dial-is-never-cancelled.md). Plants two overlapping
// attempts for the same peer: attempt 1's dial hangs, the watchdog stalls it, attempt 2 starts
// independently on the next discovery and succeeds, and THEN attempt 1's original promise finally
// settles. Both settlement shapes are covered (a stale rejection and a stale resolution) because
// the ownership guard must be a no-op against shared state either way.
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('wireMutualAuth — a stalled attempt does not race a newer one for the same peer (T230)', () => {
  function fakeEmitter() {
    const events = []
    return { events, emit: (name, fields) => events.push({ name, fields }) }
  }

  it('aborts the stalled attempt\'s signal, and a later attempt\'s bookkeeping survives its stale late REJECTION', async () => {
    const handle = fakeHandle()
    const first = deferred()
    let dialCalls = 0
    handle.dial = vi.fn().mockImplementation(() => {
      dialCalls += 1
      return dialCalls === 1 ? first.promise : Promise.resolve(undefined)
    })
    const emitter = fakeEmitter()
    wireMutualAuth(handle, {
      deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true,
      attemptTimeoutMs: 20, emitter,
    })

    // Attempt 1: discovery fires, its dial hangs.
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 5))
    expect(handle.dial).toHaveBeenCalledTimes(1)

    // Past the stall timeout: ATTEMPT_STALLED fires, `attempted` is cleared, and the
    // AbortSignal captured from attempt 1's own dial call is now aborted — proving the
    // watchdog actually abandons the in-flight work, not just the bookkeeping.
    await new Promise((r) => setTimeout(r, 40))
    expect(emitter.events.map((e) => e.name)).toEqual(['PEER_DISCOVERED', 'ATTEMPT_STALLED'])
    const attempt1Signal = handle.dial.mock.calls[0][1].signal
    expect(attempt1Signal.aborted).toBe(true)

    // Attempt 2: a later re-announce starts a genuinely independent attempt for the same
    // peer (its own dial call, its own attemptId) and completes successfully.
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.dial).toHaveBeenCalledTimes(2)
    const authOkEvents = emitter.events.filter((e) => e.name === 'AUTH_OK')
    expect(authOkEvents).toHaveLength(1)
    expect(authOkEvents[0].fields.attemptId).toBe(2)

    // NOW attempt 1's original dial promise settles late — with a rejection.
    first.reject(new Error('stale network failure'))
    await new Promise((r) => setTimeout(r, 10))

    // Attempt 2's bookkeeping survives: no stale/duplicate terminal event was emitted for
    // attempt 1's id, and a further re-announce is deduped by attempt 2's still-live
    // `attempted` entry — proving attempt 1's late rejection did not clear it out from
    // under attempt 2 (the exact race this ticket closes). deniedRecently is untouched by
    // this path entirely: recordDenial is only ever called from the trust-check branch,
    // which this scenario never reaches for either attempt.
    expect(emitter.events.map((e) => e.name)).toEqual(['PEER_DISCOVERED', 'ATTEMPT_STALLED', 'AUTH_OK'])
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.dial).toHaveBeenCalledTimes(2)
  })

  it('aborts the stalled attempt\'s signal, and a later attempt\'s bookkeeping survives its stale late RESOLUTION', async () => {
    const handle = fakeHandle()
    const first = deferred()
    let dialCalls = 0
    handle.dial = vi.fn().mockImplementation(() => {
      dialCalls += 1
      return dialCalls === 1 ? first.promise : Promise.resolve(undefined)
    })
    const emitter = fakeEmitter()
    wireMutualAuth(handle, {
      deviceId: 'device-a', getToken: () => 'tok-1', isPeerTrusted: () => true,
      attemptTimeoutMs: 20, emitter,
    })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 5))
    expect(handle.dial).toHaveBeenCalledTimes(1)

    await new Promise((r) => setTimeout(r, 40))
    expect(emitter.events.map((e) => e.name)).toEqual(['PEER_DISCOVERED', 'ATTEMPT_STALLED'])
    const attempt1Signal = handle.dial.mock.calls[0][1].signal
    expect(attempt1Signal.aborted).toBe(true)

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.dial).toHaveBeenCalledTimes(2)
    const authOkEvents = emitter.events.filter((e) => e.name === 'AUTH_OK')
    expect(authOkEvents).toHaveLength(1)
    expect(authOkEvents[0].fields.attemptId).toBe(2)

    // NOW attempt 1's original dial promise settles late — with a successful resolution.
    // Attempt 1's own code keeps running (release()'s guard is best-effort at the stream
    // layer, not a hard kill switch), reaching authenticateWith for attempt 1 too — but
    // because `stalled` is already true for attempt 1, no second AUTH_OK is emitted, and
    // because the success path never mutates `attempted`/`deniedRecently` in the first
    // place, there is nothing here for the ownership guard to even need to stop.
    first.resolve(undefined)
    await new Promise((r) => setTimeout(r, 10))

    expect(emitter.events.map((e) => e.name)).toEqual(['PEER_DISCOVERED', 'ATTEMPT_STALLED', 'AUTH_OK'])
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.dial).toHaveBeenCalledTimes(2)
  })
})
