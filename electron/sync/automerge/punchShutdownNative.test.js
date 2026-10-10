// @vitest-environment node
//
// shutdownPunchNative: native cleanup runs once, a hung session cannot stall it past the bound,
// and no PeerConnection opens after cleanup.
import { describe, it, expect, vi } from 'vitest'
import { punchTransport, shutdownPunchNative, createPunchSessionForTest } from './punchTransport.js'

const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
const components = { logger: { forComponent: () => noop } }
const signaling = { onSignal: () => () => {}, sendSignal: async () => {} }
const ice = { iceUfrag: 'abcd', icePwd: 'x'.repeat(24) }

function fakeNdc({ neverCloses = false } = {}) {
  class PeerConnection {
    constructor() { PeerConnection.count++ }
    onLocalDescription() {}
    onLocalCandidate() {}
    onStateChange(cb) { this.cb = cb }
    onGatheringStateChange() {}
    onDataChannel() {}
    createDataChannel() { return {} }
    setLocalDescription() {}
    close() { if (!neverCloses) this.cb?.('closed') }
    state() { return 'new' }
  }
  PeerConnection.count = 0
  return { PeerConnection, cleanup: vi.fn() }
}

describe('shutdownPunchNative', () => {
  it('a second call does not run ndc.cleanup again', async () => {
    const ndc = fakeNdc()
    await punchTransport({ signaling, ndc })(components).start()
    await shutdownPunchNative()
    await shutdownPunchNative()
    expect(ndc.cleanup).toHaveBeenCalledTimes(1)
  })

  it('opens no PeerConnection after native cleanup', async () => {
    const ndc = fakeNdc()
    await punchTransport({ signaling, ndc })(components).start()
    await shutdownPunchNative()
    expect(() => createPunchSessionForTest({ ndc, role: 'offerer', sid: 'a'.repeat(32), sendSignal() {}, ice })).toThrow(/shut down/)
    expect(ndc.PeerConnection.count).toBe(0)
  })

  it('does not wait forever on a session that never reports closed', async () => {
    const ndc = fakeNdc({ neverCloses: true })
    await punchTransport({ signaling, ndc })(components).start()
    createPunchSessionForTest({ ndc, role: 'offerer', sid: 'b'.repeat(32), sendSignal() {}, ice })
    const outcome = await Promise.race([shutdownPunchNative().then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 3000))])
    expect(outcome).toBe('done')
  })
})
