// @vitest-environment node
//
// T359 slice 5 (ADR docs/adr/2026-10-09-router-port-mapping-on-rung-1.md, N1): what a public scanner can
// and cannot do to the pre-Noise pending slots once the mapped TCP port is open to the internet. Runs
// against the CURRENT limits (T340 precondition 5, #858), imported from the code, never restated:
// MAX_INCOMING_PENDING_CONNECTIONS, INBOUND_UPGRADE_TIMEOUT_MS, UNADMITTED_DEADLINE_MS (transport.js),
// MAX_PENDING_PER_SOURCE (connectionRateLimiter.js).
//
// APPROACH. Real libp2p target on loopback with the production limits. Loopback is
// "private", so the source classification is injected the way connectionRateLimiter tests do: the limiter
// handed to startTransport is the real one wrapped so each inbound connection is attributed to a synthetic
// public IP. Scanners are raw TCP sockets bound to chosen local ports (a scanner that never speaks holds a
// pending slot exactly as one that stalls Noise would), so the wrapper can map port -> source. The
// legitimate dialer is a real libp2p node. 64 idle raw sockets are cheap, so the global cap is exercised
// against the real node and not only against the limiter.
//
// DETERMINISM (T362 follow-up). Nothing here races the wall clock:
//   * The limiter's clock is injected. "The slots free at the upgrade timeout" is proven by advancing it past
//     PENDING_TTL_MS (= INBOUND_UPGRADE_TIMEOUT_MS, the production value), not by waiting ~5 real seconds.
//   * Assertions read the limiter's own verdict per connection and the outcome of real end-to-end dials, never
//     when a raw socket happens to close.
//   * The target's libp2p upgrade timeout is set long, so a stalled test process cannot time out a legitimate
//     dial mid-handshake; the production 5s value is still the limiter's TTL, driven through the clock.
//   * waitFor charges its budget only for time the process was running, so a stall (GC, a starved CI worker)
//     cannot turn an event that is on its way into a timeout. The old form failed exactly that way: one
//     injected 4.1s stall after a refusal made it time out 2 runs in 2.
//
// WHAT THE CODE REALLY DOES, recorded by the assertions below:
//   * One public source holds at most MAX_PENDING_PER_SOURCE slots; its further connections are closed by
//     the gater, and a second public source's legitimate dial is admitted meanwhile.
//   * MAX_PUBLIC_PENDING_TOTAL distinct public sources, one slot each, fill the public sub-cap. Further
//     public connections are refused, but LAN dials still succeed because the global cap
//     (MAX_INCOMING_PENDING_CONNECTIONS) leaves 192+ slots no public source can take. Public dials are
//     admitted again once the upgrade timeout frees the slots.
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { startTransport, MAX_INCOMING_PENDING_CONNECTIONS, INBOUND_UPGRADE_TIMEOUT_MS, UNADMITTED_DEADLINE_MS } from './transport.js'
import { makeConnectionRateLimiter, MAX_PENDING_PER_SOURCE, MAX_PUBLIC_PENDING_TOTAL, PENDING_TTL_MS } from './connectionRateLimiter.js'

let cleanups = []
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c().catch(() => {})))
  cleanups = []
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Polls an event that will happen. The budget counts only time the process was running: an iteration is charged
// at most a few polling intervals however long it actually took, so a stall (GC, a starved CI worker) is not
// charged against the wait and cannot turn an event that is still on its way into a timeout.
async function waitFor(predicate, { timeout = 15000, interval = 25 } = {}) {
  let spent = 0
  let last = Date.now()
  while (!predicate()) {
    if (spent > timeout) throw new Error('waitFor: timed out')
    await sleep(interval)
    const now = Date.now()
    spent += Math.min(now - last, interval * 4)
    last = now
  }
}
// Long enough that a stalled test process never times out a legitimate dial mid-handshake.
const TEST_UPGRADE_TIMEOUT_MS = 120_000

const publicIp = (n) => `45.${(n >> 8) & 255}.${n & 255}.7`
const LAN_IP = '192.168.1.50'

// The real limiter, with the source of each inbound connection decided by the test (loopback would
// otherwise be exempt). Connections it was not told about are attributed to `current`.
function classifyingLimiter() {
  // The production TTL, on a clock the test advances.
  const clock = { t: 0 }
  const real = makeConnectionRateLimiter({ pendingTtlMs: INBOUND_UPGRADE_TIMEOUT_MS, now: () => clock.t })
  const byPort = new Map()
  const byKey = new Map()
  // The limiter's own verdict per scanner local port: what the test asserts, rather than whether a
  // socket happened to close (under CI load a socket can close for reasons unrelated to the limit).
  const decisions = new Map()
  const state = { current: LAN_IP }
  const sourceOf = (key) => byKey.get(key) ?? state.current
  return {
    state,
    clock,
    decisions,
    assign: (port, ip) => byPort.set(String(port), ip),
    limiter: {
      isExempt: real.isExempt,
      allow(_ip, key) {
        const ip = byPort.get(key?.split('/')[1]) ?? state.current
        byKey.set(key, ip)
        const allowed = real.allow(ip, key)
        const port = key?.split('/')[1]
        if (byPort.has(port)) decisions.set(port, allowed)
        return allowed
      },
      upgraded: (_ip, key) => real.upgraded(sourceOf(key), key),
      release: () => {},
    },
  }
}

async function startTarget() {
  const c = classifyingLimiter()
  const target = await startTransport({
    deviceId: 'target',
    onAuthenticate: () => ({ ok: true }),
    inboundConnectionThreshold: 100000, // libp2p's own per-HOST cap would otherwise fire on loopback
    inboundUpgradeTimeoutMs: TEST_UPGRADE_TIMEOUT_MS,
    connectionRateLimiter: c.limiter,
  })
  cleanups.push(() => target.stop())
  const port = Number(/\/tcp\/(\d+)/.exec(target.getMultiaddrs()[0].toString())[1])
  return { target, port, ...c }
}

function scanner(port, ip, assign, localPort) {
  assign(localPort, ip)
  const s = net.connect({ port, host: '127.0.0.1', localAddress: '127.0.0.1', localPort })
  const rec = { socket: s, closed: false, port: String(localPort) }
  s.on('error', () => {})
  s.on('close', () => { rec.closed = true })
  cleanups.push(async () => s.destroy())
  return rec
}

let nextLocalPort = 41000 + Math.floor(Math.random() * 10000)
const freePort = () => nextLocalPort++

async function legit(t, ip, state) {
  state.current = ip
  const node = await createLibp2p({ addresses: { listen: [] }, transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()] })
  cleanups.push(() => node.stop())
  try {
    const conn = await node.dial(t.getMultiaddrs()[0], { signal: AbortSignal.timeout(30000) })
    return conn?.status === 'open'
  } catch {
    return false
  }
}

describe('limits under test are the current ones', () => {
  it('imports the T340 p5 numbers rather than restating them', () => {
    expect(MAX_PENDING_PER_SOURCE).toBeGreaterThan(0)
    expect(MAX_PENDING_PER_SOURCE).toBeLessThan(MAX_PUBLIC_PENDING_TOTAL)
    // Fixed sizes (owner simplification 2026-10-10): LAN keeps at least 96 slots, and the global cap
    // alone stays inside a 256 open-file soft limit (the macOS Finder-launch default); the combined
    // worst case with established connections is recorded in SECURITY.md, not claimed here.
    expect(MAX_INCOMING_PENDING_CONNECTIONS - MAX_PUBLIC_PENDING_TOTAL).toBeGreaterThanOrEqual(96)
    expect(MAX_INCOMING_PENDING_CONNECTIONS).toBeLessThanOrEqual(128)
    expect(PENDING_TTL_MS).toBe(INBOUND_UPGRADE_TIMEOUT_MS)
    expect(INBOUND_UPGRADE_TIMEOUT_MS).toBeLessThan(UNADMITTED_DEADLINE_MS)
  })
})

describe('scanner vs the pre-Noise pending slots (real libp2p target, production limits)', () => {
  it('one public source cannot hold more than MAX_PENDING_PER_SOURCE slots, so a second public source still gets in, and so does the LAN', async () => {
    const t = await startTarget()
    const attempts = MAX_PENDING_PER_SOURCE + 4
    const mine = Array.from({ length: attempts }, () => scanner(t.port, publicIp(1), t.assign, freePort()))
    // The limiter's verdict on every one: exactly MAX_PENDING_PER_SOURCE admitted, the rest refused.
    await waitFor(() => mine.every((s) => t.decisions.has(s.port)))
    expect(mine.filter((s) => t.decisions.get(s.port) === true)).toHaveLength(MAX_PENDING_PER_SOURCE)

    // End to end: the same source is refused by the real node, while another public source and the LAN get in.
    expect(await legit(t.target, publicIp(1), t.state)).toBe(false)
    expect(await legit(t.target, publicIp(2), t.state)).toBe(true)
    expect(await legit(t.target, LAN_IP, t.state)).toBe(true)
  }, 120000)

  it('many distinct public sources saturate only the PUBLIC sub-cap: one more public source past the sub-cap is refused, the LAN still gets in, and the slots free at the upgrade timeout', async () => {
    const t = await startTarget()
    const scanners = Array.from({ length: MAX_PUBLIC_PENDING_TOTAL }, (_, i) => scanner(t.port, publicIp(100 + i), t.assign, freePort()))
    // Wait for the limiter to have decided every one (not a fixed sleep), then assert its verdicts:
    // every one was admitted to a slot, nothing was limited yet.
    await waitFor(() => scanners.every((s) => t.decisions.has(s.port)))
    expect(scanners.filter((s) => t.decisions.get(s.port) !== true).map((s) => s.port)).toEqual([])

    const extra = scanner(t.port, publicIp(9000), t.assign, freePort())
    await waitFor(() => t.decisions.has(extra.port))
    expect(t.decisions.get(extra.port)).toBe(false) // the public source past the sub-cap is refused by the limiter
    // End to end: the real node refuses a further public source and still admits the LAN.
    expect(await legit(t.target, publicIp(9001), t.state)).toBe(false)
    expect(await legit(t.target, LAN_IP, t.state)).toBe(true) // LAN is not blocked by the scan

    // The slots free at the upgrade timeout: the production TTL, reached on the injected clock. The scanners'
    // sockets are still open; the limiter, not their closing, is what frees the public sub-cap.
    t.clock.t += PENDING_TTL_MS + 1
    expect(await legit(t.target, publicIp(9002), t.state)).toBe(true)
  }, 120000)
})

describe('connectionRateLimiter in isolation (deterministic, clock injected)', () => {
  it('caps one public source at MAX_PENDING_PER_SOURCE, leaves another source and the LAN alone, and frees the slots at the TTL', () => {
    let t = 0
    const limiter = makeConnectionRateLimiter({ now: () => t })
    const A = publicIp(1)
    for (let i = 0; i < MAX_PENDING_PER_SOURCE; i++) expect(limiter.allow(A, `${A}/${i}`)).toBe(true)
    expect(limiter.allow(A, `${A}/x`)).toBe(false)
    expect(limiter.allow(publicIp(2), 'b/1')).toBe(true)
    for (let i = 0; i < 50; i++) expect(limiter.allow(LAN_IP, `lan/${i}`)).toBe(true)
    t += PENDING_TTL_MS + 1
    expect(limiter.allow(A, `${A}/y`)).toBe(true)
  })

  it('caps the TOTAL of public pending at MAX_PUBLIC_PENDING_TOTAL regardless of source, never limits the LAN, and frees at the TTL', () => {
    let t = 0
    const limiter = makeConnectionRateLimiter({ now: () => t })
    for (let i = 0; i < MAX_PUBLIC_PENDING_TOTAL; i++) expect(limiter.allow(publicIp(i), `k${i}`)).toBe(true)
    expect(limiter.allow(publicIp(5000), 'over')).toBe(false)
    for (let i = 0; i < 300; i++) expect(limiter.allow(LAN_IP, `lan/${i}`)).toBe(true)
    t += PENDING_TTL_MS + 1
    expect(limiter.allow(publicIp(5000), 'after')).toBe(true)
  })
})
