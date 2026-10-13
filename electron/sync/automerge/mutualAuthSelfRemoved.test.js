// A device whose own state says it was removed retries slowly, and a lost admission gets ONE
// re-authenticate (the path by which a removed device hears the refusal). See selfRemoval.js.
import { describe, it, expect, vi } from 'vitest'
import { wireMutualAuth } from './mutualAuth.js'

function fakeHandle(reply = { type: 'auth_ok' }) {
  const listeners = []
  return {
    dial: vi.fn().mockResolvedValue(undefined),
    authenticateWith: vi.fn().mockResolvedValue(reply),
    onPeerDiscovery: (cb) => listeners.push(cb),
    fireDiscovery: (id) => listeners.forEach((cb) => cb({ id })),
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('mutualAuth once this device was removed from the camp', () => {
  it('keeps trying while removed, but at most once per peer per interval', async () => {
    let t = 0
    const handle = fakeHandle({ type: 'auth_failed', reason: 'device_revoked' })
    wireMutualAuth(handle, { deviceId: 'device-b', getToken: () => 'tok', isPeerTrusted: () => true, isSelfRemoved: () => true, now: () => t, removedRetryMs: 1000 })
    handle.fireDiscovery('peer-a')
    await tick()
    expect(handle.authenticateWith).toHaveBeenCalledTimes(1)
    handle.fireDiscovery('peer-a')
    await tick()
    expect(handle.authenticateWith).toHaveBeenCalledTimes(1)
    t = 1500
    handle.fireDiscovery('peer-a')
    await tick()
    expect(handle.authenticateWith).toHaveBeenCalledTimes(2)
  })

  it('re-authenticates exactly once after a peer that had admitted this device disconnects', async () => {
    const handle = fakeHandle()
    const ma = wireMutualAuth(handle, { deviceId: 'device-b', getToken: () => 'tok', isPeerTrusted: () => true, reauthAfterDisconnectMs: 5 })
    handle.fireDiscovery('peer-a')
    await tick()
    expect(handle.authenticateWith).toHaveBeenCalledTimes(1)

    handle.authenticateWith.mockResolvedValue({ type: 'auth_failed', reason: 'device_revoked' })
    ma.forget('peer-a')
    await tick(40)
    expect(handle.authenticateWith).toHaveBeenCalledTimes(2)

    // The refused retry did not re-arm: another disconnect brings no further attempt.
    ma.forget('peer-a')
    await tick(40)
    expect(handle.authenticateWith).toHaveBeenCalledTimes(2)
  })

  it('never re-authenticates after a disconnect from a peer that had not admitted this device', async () => {
    const handle = fakeHandle({ type: 'auth_failed', reason: 'invalid_token' })
    const ma = wireMutualAuth(handle, { deviceId: 'device-b', getToken: () => 'tok', isPeerTrusted: () => true, reauthAfterDisconnectMs: 5 })
    handle.fireDiscovery('peer-a')
    await tick()
    ma.forget('peer-a')
    await tick(40)
    expect(handle.authenticateWith).toHaveBeenCalledTimes(1)
  })

  it('retries a revocation refusal that did not leave this device removed, on a bounded schedule', async () => {
    const handle = fakeHandle({ type: 'auth_failed', reason: 'device_revoked_by_authority' })
    wireMutualAuth(handle, { deviceId: 'device-b', isPeerTrusted: () => true, removedRetryMs: 10 })
    handle.fireDiscovery('peer-a')
    await tick(300)
    expect(handle.authenticateWith).toHaveBeenCalledTimes(6)
  })

  it('does not schedule a retry once the refusal left this device removed, nor for other refusal reasons', async () => {
    const removed = fakeHandle({ type: 'auth_failed', reason: 'device_revoked_by_authority' })
    wireMutualAuth(removed, { deviceId: 'device-b', isPeerTrusted: () => true, isSelfRemoved: () => true, removedRetryMs: 10 })
    removed.fireDiscovery('peer-a')
    await tick(100)
    expect(removed.authenticateWith).toHaveBeenCalledTimes(1)
    const other = fakeHandle({ type: 'auth_failed', reason: 'device_not_authorized' })
    wireMutualAuth(other, { deviceId: 'device-b', isPeerTrusted: () => true, removedRetryMs: 10 })
    other.fireDiscovery('peer-a')
    await tick(100)
    expect(other.authenticateWith).toHaveBeenCalledTimes(1)
  })
})
