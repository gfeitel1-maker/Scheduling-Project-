// @vitest-environment node
//
// Inbound-offer handling on the listener (T347 round 2): the pending-session cap must free its slot
// once a connection has opened, and an offer must never reuse a sid a live session already holds.
import { describe, it, expect } from 'vitest'
import { punchTransport } from './punchTransport.js'
import { makeSignalingPair } from './punchTestSupport.js'

const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:abcd\r\na=ice-pwd:' + 'x'.repeat(24) + '\r\na=fingerprint:sha-256 AA:BB\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=setup:actpass\r\n'
const sid = (n) => String(n).padStart(32, '0')

function fakeAnswererNdc({ autoOpen = false } = {}) {
  const pcs = []
  class FakeDc {
    onOpen(cb) { this.open = cb }
    onClosed() {}
    onMessage() {}
    onError() {}
    onBufferedAmountLow() {}
    setBufferedAmountLowThreshold() {}
    close() {}
    isOpen() { return true }
    bufferedAmount() { return 0 }
    sendMessageBinary() { return true }
  }
  class FakePc {
    constructor() { this.autoOpen = autoOpen; this.closes = 0; pcs.push(this) }
    onLocalDescription() {}
    onLocalCandidate() {}
    onStateChange(cb) { this.state = cb }
    onDataChannel(cb) { this.dcCb = cb }
    setRemoteDescription() {}
    addRemoteCandidate() {}
    setLocalDescription() {
      queueMicrotask(() => {
        const dc = new FakeDc()
        this.dcCb?.(dc)
        if (this.autoOpen) dc.open()
      })
    }
    getSelectedCandidatePair() { return null }
    close() { this.closes++; queueMicrotask(() => this.state('closed')) }
  }
  return { ndc: { PeerConnection: FakePc, cleanup() {} }, pcs }
}

const stubComponents = () => {
  const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
  return { logger: { forComponent: () => noop } }
}
const tick = () => new Promise((r) => setTimeout(r, 20))

async function listening({ maxPendingInbound = 4, autoOpen = false } = {}) {
  const { ndc, pcs } = fakeAnswererNdc({ autoOpen })
  const [sig] = makeSignalingPair()
  const t = punchTransport({ signaling: sig, role: 'answerer', maxPendingInbound, ndc })(stubComponents())
  await t.start()
  const upgraded = []
  const listener = t.createListener({ upgrader: { upgradeInbound: async (m) => { upgraded.push(m); return m } } })
  await listener.listen({ toString: () => '/ip4/127.0.0.1/udp/9' })
  return { t, listener, pcs, upgraded }
}

describe('punch listener inbound handling', () => {
  it('an established inbound connection no longer counts against the pending cap', async () => {
    const { t, listener, pcs, upgraded } = await listening({ maxPendingInbound: 2, autoOpen: true })
    for (let i = 1; i <= 5; i++) {
      listener.onOffer(sid(i), OFFER)
      await tick()
    }
    expect(pcs.length).toBe(5)
    expect(upgraded.length).toBe(5)
    await t.stop()
  })

  it('an offer reusing the sid of a live session is rejected and the live session is untouched', async () => {
    const { t, listener, pcs } = await listening()
    listener.onOffer(sid(1), OFFER)
    await tick()
    listener.onOffer(sid(1), OFFER)
    await tick()
    expect(pcs.length).toBe(1)
    expect(pcs[0].closes).toBe(0)
    expect(t.sessions.size).toBe(1)
    await t.stop()
  })

  it('an offer reusing the sid of a pending outbound dial is rejected', async () => {
    const { ndc, pcs } = fakeAnswererNdc()
    ndc.PeerConnection.prototype.createDataChannel = function () { return { onOpen() {}, onClosed() {}, onMessage() {}, onError() {}, onBufferedAmountLow() {}, setBufferedAmountLowThreshold() {}, close() {} } }
    const [sig] = makeSignalingPair()
    const t = punchTransport({ signaling: sig, ndc })(stubComponents())
    await t.start()
    const listener = t.createListener({ upgrader: { upgradeInbound: async (m) => m } })
    await listener.listen({ toString: () => '/ip4/127.0.0.1/udp/9' })
    const dial = t.dial({ toString: () => '/ip4/127.0.0.1/udp/9' }, { signal: AbortSignal.timeout(2000), upgrader: {} }).catch(() => {})
    await tick()
    const [dialSid] = [...t.sessions.keys()]
    listener.onOffer(dialSid, OFFER)
    await tick()
    expect(pcs.length).toBe(1)
    expect(t.sessions.size).toBe(1)
    await t.stop()
    await dial
  })
})
