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
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1' })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).toHaveBeenCalledWith('peer-b')
    expect(handle.authenticateWith).toHaveBeenCalledWith('peer-b', { type: 'authenticate', token: 'tok-1', device_id: 'device-a' })
  })

  it('does not dial a discovered peer when there is no token yet', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => null })

    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).not.toHaveBeenCalled()
  })

  it('does not re-dial the same peer twice while already attempted', async () => {
    const handle = fakeHandle()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1' })

    handle.fireDiscovery('peer-b')
    handle.fireDiscovery('peer-b')
    await new Promise((r) => setTimeout(r, 10))

    expect(handle.dial).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected authenticate via onRejected rather than only console.error, and allows retry', async () => {
    const handle = fakeHandle()
    handle.authenticateWith = vi.fn().mockResolvedValue({ type: 'auth_failed', reason: 'device_revoked' })
    const onRejected = vi.fn()
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1', onRejected })

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
    wireMutualAuth(handle, { deviceId: 'device-a', getToken: () => 'tok-1' })

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
    const m = wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok' })
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
    const m = wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok' })
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
    const m = wireMutualAuth(handle, { deviceId: 'me', getToken: () => 'tok' })
    await m.tryAuthenticate('peer-3')
    expect(authCalls).toEqual([])
  })
})
