// @vitest-environment node
//
// S1 NATIVE SAFETY (docs/adr/2026-10-08-relayless-cross-network-reconnect.md "Hazards", ticket T347).
// libdatachannel aborts the whole process on some misuse ("No DataChannel or Track to negotiate"),
// which no JS try/catch can intercept, so these scenarios run in CHILD processes and assert the
// child exits 0 — a SIGABRT/SIGSEGV in-process would take the vitest worker down with it and prove
// nothing. The abort control below proves the harness can actually see an abort, so a green run on
// the guarded paths is not vacuous.
import { describe, it, expect } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { punchTransport } from './punchTransport.js'
import { makeSignalingPair } from './punchTestSupport.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const punchUrl = pathToFileURL(path.join(here, 'punchTransport.js')).href
const supportUrl = pathToFileURL(path.join(here, 'punchTestSupport.js')).href

function runChild(script, { timeoutMs = 30000 } = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: timeoutMs })
}

const VALID_CANDIDATE = 'candidate:1 1 UDP 2114977791 192.168.1.5 50000 typ host'
const SID = 'a'.repeat(32)

const misuseScript = `
import { createPunchSessionForTest, loadNodeDataChannel, shutdownPunchNative } from ${JSON.stringify(punchUrl)}
const ndc = loadNodeDataChannel()
const results = {}
const make = (role) => createPunchSessionForTest({ ndc, role, sid: ${JSON.stringify(SID)}, sendSignal: () => {} })
const attempt = (name, fn) => {
  try { fn(); results[name] = 'no-throw' } catch (e) { results[name] = 'threw:' + (e && e.name) }
}
const NO_CHANNEL_SDP = 'v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\na=ice-ufrag:abcd\\r\\na=ice-pwd:' + 'x'.repeat(24) + '\\r\\na=fingerprint:sha-256 AA:BB\\r\\n'
const MEDIA_SDP = NO_CHANNEL_SDP + 'm=video 9 UDP/TLS/RTP/SAVPF 96\\r\\n'

attempt('offer-without-datachannel-section', () => make('answerer').acceptOffer(NO_CHANNEL_SDP))
attempt('offer-with-media', () => make('answerer').acceptOffer(MEDIA_SDP))
attempt('offer-empty-string', () => make('answerer').acceptOffer(''))
attempt('offer-not-a-string', () => make('answerer').acceptOffer({ sdp: 1 }))
attempt('offer-garbage', () => make('answerer').acceptOffer('not sdp at all'))
attempt('answer-before-any-offer', () => make('offerer').acceptAnswer(NO_CHANNEL_SDP))
attempt('answer-bad-sdp', () => { const s = make('offerer'); s.startOffer(); s.acceptAnswer('garbage') })
attempt('offer-twice', () => { const s = make('offerer'); s.startOffer(); s.startOffer() })
attempt('candidate-garbage', () => make('answerer').addCandidate('garbage', '0'))
attempt('candidate-relay-type', () => make('answerer').addCandidate('candidate:1 1 UDP 1 1.2.3.4 5000 typ relay', '0'))
attempt('candidate-oversized', () => make('answerer').addCandidate('candidate:' + 'x'.repeat(600), '0'))
attempt('candidate-bad-mid', () => make('answerer').addCandidate(${JSON.stringify(VALID_CANDIDATE)}, '../..'))
attempt('candidate-valid-before-description-is-queued', () => make('answerer').addCandidate(${JSON.stringify(VALID_CANDIDATE)}, '0'))
attempt('double-close', () => { const s = make('offerer'); s.close(); s.close() })
attempt('use-after-close', () => { const s = make('offerer'); s.close(); s.startOffer() })
attempt('candidate-after-close', () => { const s = make('answerer'); s.close(); s.addCandidate(${JSON.stringify(VALID_CANDIDATE)}, '0') })

const early = make('offerer')
early.startOffer()
early.close()
results['close-before-open'] = await early.waitOpen({ timeoutMs: 2000 }).then(() => 'opened', (e) => 'rejected:' + e.message)

await shutdownPunchNative()
await shutdownPunchNative()
console.log(JSON.stringify(results))
`

describe('punch native misuse — every bad input becomes a JS error, never an abort', () => {
  it('control: raw node-datachannel misuse really does abort the process (harness can see it)', () => {
    const r = runChild(`
      import { createRequire } from 'node:module'
      const ndc = createRequire(${JSON.stringify(punchUrl)})('node-datachannel')
      const pc = new ndc.PeerConnection('misuse', { iceServers: [], disableAutoNegotiation: true })
      pc.setLocalDescription('offer')
      setTimeout(() => {}, 2000)
    `)
    expect(r.status === 0 && r.signal == null, 'the unguarded native call was expected to kill the child').toBe(false)
  })

  it('no channel, bad SDP, bad candidate, double close, close-before-open all throw or reject JS errors and the process exits 0', () => {
    const r = runChild(misuseScript)
    expect(r.signal, r.stderr).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    const results = JSON.parse(r.stdout.trim().split('\n').pop())
    expect(results).toEqual({
      'offer-without-datachannel-section': 'threw:InvalidParametersError',
      'offer-with-media': 'threw:InvalidParametersError',
      'offer-empty-string': 'threw:InvalidParametersError',
      'offer-not-a-string': 'threw:InvalidParametersError',
      'offer-garbage': 'threw:InvalidParametersError',
      'answer-before-any-offer': 'threw:InvalidParametersError',
      'answer-bad-sdp': 'threw:InvalidParametersError',
      'offer-twice': 'threw:InvalidParametersError',
      'candidate-garbage': 'threw:InvalidParametersError',
      'candidate-relay-type': 'threw:InvalidParametersError',
      'candidate-oversized': 'threw:InvalidParametersError',
      'candidate-bad-mid': 'threw:InvalidParametersError',
      'candidate-valid-before-description-is-queued': 'no-throw',
      'double-close': 'no-throw',
      'use-after-close': 'threw:InvalidParametersError',
      'candidate-after-close': 'threw:InvalidParametersError',
      'close-before-open': 'rejected:punch: session closed',
    })
  }, 40000)
})

describe('punch option validation — rejected at configuration time, before any native call', () => {
  const [signaling] = makeSignalingPair()
  const bad = {
    'no options': undefined,
    'no signaling': {},
    'signaling without onSignal': { signaling: { sendSignal() {} } },
    'unknown role': { signaling, role: 'both' },
    'TURN server': { signaling, iceServers: ['turn:turn.example.com:3478'] },
    'turns server': { signaling, iceServers: ['turns:turn.example.com:5349'] },
    'non-string ice server': { signaling, iceServers: [{ urls: 'stun:x' }] },
    // Owner ruling 2026-10-09: no STUN server of any kind, so no third party learns a device's IP.
    'any STUN server': { signaling, iceServers: ['stun:stun.cloudflare.com:3478'] },
    'port range below 1024': { signaling, portRange: { begin: 80, end: 90 } },
    'inverted port range': { signaling, portRange: { begin: 5000, end: 4000 } },
    'cert without key': { signaling, certificatePemFile: '/etc/hosts' },
    'cert file missing': { signaling, certificatePemFile: '/nonexistent.pem', keyPemFile: '/nonexistent.key' },
    'ufrag without pwd': { signaling, ice: { iceUfrag: 'abcd' } },
    'short pwd': { signaling, ice: { iceUfrag: 'abcd', icePwd: 'short' } },
  }
  for (const [name, options] of Object.entries(bad)) {
    it(`rejects: ${name}`, () => {
      expect(() => punchTransport(options)).toThrow(/punch:/)
    })
  }

  it('accepts a pinned port range, fixed ICE credentials and a cert/key pair', () => {
    expect(() => punchTransport({
      signaling,
      role: 'offerer',
      portRange: { begin: 50000, end: 50000 },
      certificatePemFile: '/etc/hosts',
      keyPemFile: '/etc/hosts',
      ice: { iceUfrag: 'abcd', icePwd: 'p'.repeat(24) },
    })).not.toThrow()
  })
})

// A fake node-datachannel that opens on demand and records close/cleanup — proves the teardown
// CONTRACT (pc.close() + cleanup()) independent of the native timing the child-process tests cover.
function fakeNdc() {
  const log = { pcClosed: 0, cleanups: 0 }
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
    onLocalDescription(cb) { this.ld = cb }
    onLocalCandidate() {}
    onStateChange(cb) { this.state = cb }
    onDataChannel() {}
    createDataChannel() { return this.dc }
    setLocalDescription() { queueMicrotask(() => this.autoOpen && this.dc.open()) }
    getSelectedCandidatePair() { return null }
    close() { log.pcClosed++; queueMicrotask(() => this.state('closed')) }
  }
  const ndc = { PeerConnection: class extends FakePc { constructor(...a) { super(...a); ndc.last = this; this.autoOpen = ndc.autoOpen } }, cleanup() { log.cleanups++ } }
  return { ndc, log }
}

const stubComponents = () => {
  const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
  return { logger: { forComponent: () => noop } }
}

describe('punch teardown contract', () => {
  it('stop() closes an OPEN pc and runs the module cleanup()', async () => {
    const { ndc, log } = fakeNdc()
    ndc.autoOpen = true
    const [sig] = makeSignalingPair()
    const t = punchTransport({ signaling: sig, role: 'offerer', ndc })(stubComponents())
    await t.start()
    const conn = await t.dial({ toString: () => '/ip4/127.0.0.1/udp/9' }, { signal: new AbortController().signal, upgrader: { upgradeOutbound: async (m) => m } })
    expect(conn.status).toBe('open')
    await t.stop()
    expect(log.pcClosed).toBe(1)
    expect(log.cleanups).toBe(1)
  })

  it('stop() closes a pc that never opened (dial still in flight) and rejects the dial', async () => {
    const { ndc, log } = fakeNdc()
    const [sig] = makeSignalingPair()
    const t = punchTransport({ signaling: sig, role: 'offerer', ndc })(stubComponents())
    await t.start()
    const dial = t.dial({ toString: () => '/ip4/127.0.0.1/udp/9' }, { signal: new AbortController().signal, upgrader: {} })
    const outcome = dial.then(() => 'opened', (e) => e.message)
    await new Promise((r) => setTimeout(r, 20))
    await t.stop()
    expect(await outcome).toMatch(/punch: session closed|closed before/)
    expect(log.pcClosed).toBe(1)
    expect(log.cleanups).toBe(1)
  })

  it('cleanup() runs only when the LAST transport stops', async () => {
    const { ndc, log } = fakeNdc()
    const [s1, s2] = makeSignalingPair()
    const t1 = punchTransport({ signaling: s1, ndc })(stubComponents())
    const t2 = punchTransport({ signaling: s2, ndc })(stubComponents())
    await t1.start()
    await t2.start()
    await t1.stop()
    expect(log.cleanups).toBe(0)
    await t2.stop()
    expect(log.cleanups).toBe(1)
  })

  it('a dial before start, and a dial from an answerer-role transport, are refused', async () => {
    const { ndc } = fakeNdc()
    const [sig] = makeSignalingPair()
    const ma = { toString: () => '/ip4/127.0.0.1/udp/9' }
    const offerer = punchTransport({ signaling: sig, role: 'offerer', ndc })(stubComponents())
    await expect(offerer.dial(ma, { upgrader: {} })).rejects.toThrow(/not started/)
    const answerer = punchTransport({ signaling: sig, role: 'answerer', ndc })(stubComponents())
    await answerer.start()
    await expect(answerer.dial(ma, { upgrader: {} })).rejects.toThrow(/cannot dial/)
    await answerer.stop()
  })
})

const quitScript = (tail) => `
import { punchTransport, shutdownPunchNative } from ${JSON.stringify(punchUrl)}
import { makeSignalingPair } from ${JSON.stringify(supportUrl)}
const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
const components = { logger: { forComponent: () => noop } }
const [sa, sb] = makeSignalingPair()
const ta = punchTransport({ signaling: sa, role: 'offerer' })(components)
const tb = punchTransport({ signaling: sb, role: 'answerer' })(components)
await ta.start(); await tb.start()
const listener = tb.createListener({ upgrader: { upgradeInbound: async (m) => m } })
await listener.listen({ toString: () => '/ip4/127.0.0.1/udp/9' })
const conn = await ta.dial({ toString: () => '/ip4/127.0.0.1/udp/9' }, { signal: AbortSignal.timeout(10000), upgrader: { upgradeOutbound: async (m) => m } })
await new Promise((r) => setTimeout(r, 300))
console.log('OPEN', conn.status)
${tail}
`

function runUntil(script, bound) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, bound)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, out, ms: Date.now() - started })
    })
  })
}

// The exit bound is an upper limit on a loaded machine (child import + ICE setup took >15s at load
// ~80), not an expectation: a healthy run exits in well under a second. The hang this guards is
// proven separately by the control test, which never exits regardless of load.
const EXIT_BOUND_MS = 45000

describe('punch quit with an open pc', () => {
  it('transport stop() on both sides lets the process exit on its own within the bound', async () => {
    const r = await runUntil(quitScript('await tb.stop(); await ta.stop()'), EXIT_BOUND_MS)
    expect(r.out).toContain('OPEN open')
    expect(r.signal).toBeNull()
    expect(r.code).toBe(0)
    expect(r.ms).toBeLessThan(EXIT_BOUND_MS)
  }, EXIT_BOUND_MS + 30000)

  it("main's quit hook (shutdownPunchNative alone) lets the process exit on its own", async () => {
    const r = await runUntil(quitScript('await shutdownPunchNative()'), EXIT_BOUND_MS)
    expect(r.out).toContain('OPEN open')
    expect(r.signal).toBeNull()
    expect(r.code).toBe(0)
  }, EXIT_BOUND_MS + 30000)

  it('control: the same scenario WITHOUT a teardown does not exit (the hang this prevents)', async () => {
    const r = await runUntil(quitScript(''), 6000)
    expect(r.out).toContain('OPEN open')
    expect(r.signal).toBe('SIGKILL')
  }, 30000)
})
