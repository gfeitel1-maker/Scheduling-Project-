// T369: libdatachannel reports ICE 'disconnected' when consent checks miss under load, and it can recover.
// Before the data channel opens, a 'disconnected' now gets a bounded grace (disconnectGraceMs) to recover
// to 'connected' instead of failing the attempt at once. 'failed' and 'closed' stay immediate, the open
// timeout (connectTimeoutMs) still bounds the whole attempt, and nothing crosses the connection before open.
import { describe, it, expect } from 'vitest'
import { punchTransport } from './punchTransport.js'
import { makeSignalingPair } from './punchTestSupport.js'

function fakeNdc() {
  class FakeDc {
    onOpen(cb) { this.open = cb }
    onClosed(cb) { this.closedCb = cb }
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
    constructor() { this.dc = new FakeDc() }
    onLocalDescription() {}
    onLocalCandidate() {}
    onStateChange(cb) { this.state = cb }
    onDataChannel() {}
    createDataChannel() { return this.dc }
    setLocalDescription() {}
    getSelectedCandidatePair() { return null }
    close() { queueMicrotask(() => this.state('closed')) }
  }
  const ndc = { PeerConnection: class extends FakePc { constructor(...a) { super(...a); ndc.last = this } }, cleanup() {} }
  return ndc
}
const lines = []
const stubComponents = () => {
  const noop = Object.assign((...a) => { lines.push(a.join(' ')) }, { error() {}, trace() {}, newScope: () => noop })
  return { logger: { forComponent: () => noop } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function dialing(opts = {}) {
  const ndc = fakeNdc()
  const [sig] = makeSignalingPair()
  const t = punchTransport({ signaling: sig, role: 'offerer', ndc, ...opts })(stubComponents())
  await t.start()
  const started = Date.now()
  const dial = t.dial({ toString: () => '/ip4/127.0.0.1/udp/9' }, { signal: new AbortController().signal, upgrader: { upgradeOutbound: async (m) => m } })
  const outcome = dial.then(() => ({ ok: true, ms: Date.now() - started, at: Date.now() }), (e) => ({ ok: false, error: e, ms: Date.now() - started, at: Date.now() }))
  await sleep(10)
  return { t, pc: ndc.last, outcome }
}

describe('T369: a transient ICE disconnected before open', () => {
  it('recovers: disconnected, then connected inside the grace, then the channel opens', async () => {
    const { t, pc, outcome } = await dialing({ disconnectGraceMs: 300 })
    pc.state('disconnected')
    await sleep(50)
    pc.state('connected')
    pc.dc.open()
    const r = await outcome
    expect(r.ok).toBe(true)
    await t.stop()
  })

  it('fails the attempt once the grace runs out without a recovery', async () => {
    const { t, pc, outcome } = await dialing({ disconnectGraceMs: 100 })
    const disconnectedAt = Date.now()
    pc.state('disconnected')
    const r = await outcome
    expect(r.ok).toBe(false)
    expect(r.error.name).toBe('PunchConnectionFailedError')
    expect(r.error.message).toMatch(/disconnected/)
    expect(r.at - disconnectedAt).toBeGreaterThanOrEqual(90)
    await t.stop()
  })

  it('a failed state still fails the attempt at once', async () => {
    const { t, pc, outcome } = await dialing({ disconnectGraceMs: 5000 })
    pc.state('failed')
    const r = await outcome
    expect(r.ok).toBe(false)
    expect(r.ms).toBeLessThan(1000)
    await t.stop()
  })

  it('the open timeout still bounds the attempt when the grace is longer', async () => {
    const { t, pc, outcome } = await dialing({ disconnectGraceMs: 5000, connectTimeoutMs: 200 })
    pc.state('disconnected')
    const r = await outcome
    expect(r.ok).toBe(false)
    expect(r.ms).toBeLessThan(1500)
    await t.stop()
  })

  it('refuses a grace that is not a non-negative integer', () => {
    const [sig] = makeSignalingPair()
    expect(() => punchTransport({ signaling: sig, ndc: fakeNdc(), disconnectGraceMs: -1 })).toThrow(/disconnectGraceMs/)
  })
})
