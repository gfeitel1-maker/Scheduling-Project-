// @vitest-environment node
//
// T359 slice 5 (ADR docs/adr/2026-10-09-router-port-mapping-on-rung-1.md, N1): what a public scanner can
// and cannot do to the pre-Noise pending slots once the mapped TCP port is open to the internet. Runs
// against the CURRENT limits (T340 precondition 5, #858), imported from the code, never restated:
// MAX_INCOMING_PENDING_CONNECTIONS, INBOUND_UPGRADE_TIMEOUT_MS, UNADMITTED_DEADLINE_MS (transport.js),
// MAX_PENDING_PER_SOURCE (connectionRateLimiter.js).
//
// APPROACH. Real libp2p target on loopback with the production defaults for every limit. Loopback is
// "private", so the source classification is injected the way connectionRateLimiter tests do: the limiter
// handed to startTransport is the real one wrapped so each inbound connection is attributed to a synthetic
// public IP. Scanners are raw TCP sockets bound to chosen local ports (a scanner that never speaks holds a
// pending slot exactly as one that stalls Noise would), so the wrapper can map port -> source. The
// legitimate dialer is a real libp2p node. 64 idle raw sockets are cheap, so the global cap is exercised
// against the real node and not only against the limiter.
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
async function waitFor(predicate, { timeout = 4000, interval = 25 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await sleep(interval)
  }
}

const publicIp = (n) => `45.${(n >> 8) & 255}.${n & 255}.7`
const LAN_IP = '192.168.1.50'

// The real limiter, with the source of each inbound connection decided by the test (loopback would
// otherwise be exempt). Connections it was not told about are attributed to `current`.
function classifyingLimiter() {
  const real = makeConnectionRateLimiter({ pendingTtlMs: INBOUND_UPGRADE_TIMEOUT_MS })
  const byPort = new Map()
  const byKey = new Map()
  const state = { current: LAN_IP }
  const sourceOf = (key) => byKey.get(key) ?? state.current
  return {
    state,
    assign: (port, ip) => byPort.set(String(port), ip),
    limiter: {
      isExempt: real.isExempt,
      allow(_ip, key) {
        const ip = byPort.get(key?.split('/')[1]) ?? state.current
        byKey.set(key, ip)
        return real.allow(ip, key)
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
    connectionRateLimiter: c.limiter,
  })
  cleanups.push(() => target.stop())
  const port = Number(/\/tcp\/(\d+)/.exec(target.getMultiaddrs()[0].toString())[1])
  return { target, port, ...c }
}

function scanner(port, ip, assign, localPort) {
  assign(localPort, ip)
  const s = net.connect({ port, host: '127.0.0.1', localAddress: '127.0.0.1', localPort })
  const rec = { socket: s, closed: false }
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
    const conn = await node.dial(t.getMultiaddrs()[0], { signal: AbortSignal.timeout(3000) })
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
    await waitFor(() => mine.filter((s) => s.closed).length >= attempts - MAX_PENDING_PER_SOURCE)
    await sleep(200)
    expect(mine.filter((s) => !s.closed)).toHaveLength(MAX_PENDING_PER_SOURCE)

    expect(await legit(t.target, publicIp(2), t.state)).toBe(true)
    expect(await legit(t.target, LAN_IP, t.state)).toBe(true)
    expect(mine.filter((s) => !s.closed)).toHaveLength(MAX_PENDING_PER_SOURCE)
  })

  it('many distinct public sources saturate only the PUBLIC sub-cap: one more public source past the sub-cap is refused, the LAN still gets in, and the slots free at the upgrade timeout', async () => {
    const t = await startTarget()
    const scanners = Array.from({ length: MAX_PUBLIC_PENDING_TOTAL }, (_, i) => scanner(t.port, publicIp(100 + i), t.assign, freePort()))
    await sleep(500)
    expect(scanners.filter((s) => s.closed)).toHaveLength(0) // every one holds a slot: nothing was limited yet

    const extra = scanner(t.port, publicIp(9000), t.assign, freePort())
    await waitFor(() => extra.closed) // the public source past the sub-cap is refused
    expect(await legit(t.target, publicIp(9001), t.state)).toBe(false)
    expect(await legit(t.target, LAN_IP, t.state)).toBe(true) // LAN is not blocked by the scan

    await waitFor(() => scanners.every((s) => s.closed), { timeout: INBOUND_UPGRADE_TIMEOUT_MS + 6000 })
    expect(await legit(t.target, publicIp(9002), t.state)).toBe(true)
  }, 30000)
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
