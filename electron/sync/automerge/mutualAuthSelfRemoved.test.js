// A device the camp removed stops contacting camp peers, and a lost admission gets ONE
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
  it('makes no attempt at all while removed; control: attempts when not removed', async () => {
    for (const removed of [true, false]) {
      const handle = fakeHandle()
      wireMutualAuth(handle, { deviceId: 'device-b', getToken: () => 'tok', isPeerTrusted: () => true, isSelfRemoved: () => removed })
      for (let i = 0; i < 5; i++) handle.fireDiscovery(`peer-${i}`)
      await tick()
      expect(handle.authenticateWith).toHaveBeenCalledTimes(removed ? 0 : 5)
    }
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
})
