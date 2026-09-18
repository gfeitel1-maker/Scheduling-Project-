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

    expect(handle.dial).toHaveBeenCalledWith('peer-b')
    expect(handle.authenticateWith).toHaveBeenCalledWith('peer-b', { type: 'authenticate', token: 'tok-1', device_id: 'device-a' })
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

    expect(handle.authenticateWith).toHaveBeenCalledWith('peer-trusted', {
      type: 'authenticate', token: 'tok-1', device_id: 'device-a',
    })
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
// decision — not an accident of a missing argument. If someone changes what
// the production node trusts, this test is where they must say so.
describe('syncNode default trust policy (T208)', () => {
  it('is the named LAN-topology policy, which trusts every mDNS-discovered peer', async () => {
    const { lanTopologyTrust } = await import('./syncNode.js')
    expect(typeof lanTopologyTrust).toBe('function')
    // Deliberately permissive: peer ids are not stable across restarts on this
    // tree (transport.js persists no private key), so a peer-id-based check
    // would break all sync. The control here is mDNS topology, not this
    // predicate. Closing it for real is T162 (persistent identity + token
    // binding). See syncNode.js's comment above lanTopologyTrust.
    expect(lanTopologyTrust('any-peer-id')).toBe(true)
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

    expect(handle.dial).toHaveBeenCalledWith('peer-b')   // it redialled
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
