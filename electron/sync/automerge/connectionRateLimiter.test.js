// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  makeConnectionRateLimiter,
  isPrivateOrLoopback,
  ipFromMultiaddr,
  MAX_NEW_CONNECTIONS_PER_WINDOW,
  MAX_CONCURRENT_PER_SOURCE,
} from './connectionRateLimiter.js'

describe('isPrivateOrLoopback — the LAN/loopback exemption that keeps this inert on a LAN', () => {
  it('treats loopback, RFC1918, link-local and IPv6 ULA/link-local as private', () => {
    for (const ip of ['127.0.0.1', '::1', '10.0.0.5', '192.168.1.20', '169.254.3.3',
      '172.16.0.1', '172.31.255.254', 'fe80::1', 'fd12:3456::1']) {
      expect(isPrivateOrLoopback(ip), ip).toBe(true)
    }
  })
  it('treats real public addresses as public', () => {
    for (const ip of ['8.8.8.8', '1.2.3.4', '203.0.113.9', '172.32.0.1', '172.15.0.1', '2001:db8::1']) {
      expect(isPrivateOrLoopback(ip), ip).toBe(false)
    }
  })
  it('fails OPEN for an unknown/missing source (never breaks a peer we cannot classify)', () => {
    expect(isPrivateOrLoopback(null)).toBe(true)
    expect(isPrivateOrLoopback('')).toBe(true)
  })
})

describe('ipFromMultiaddr', () => {
  it('pulls the host out of ip4/ip6 multiaddrs', () => {
    expect(ipFromMultiaddr('/ip4/1.2.3.4/tcp/5')).toBe('1.2.3.4')
    expect(ipFromMultiaddr('/ip6/2001:db8::1/tcp/5')).toBe('2001:db8::1')
  })
  it('returns null for a relayed/circuit addr with no ip (→ treated as exempt)', () => {
    expect(ipFromMultiaddr('/p2p-circuit/p2p/12D3Koo')).toBeNull()
    expect(ipFromMultiaddr(null)).toBeNull()
  })
})

describe('makeConnectionRateLimiter — inert on the LAN', () => {
  it('never denies a private/loopback source, no matter how many connections', () => {
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 2, maxConcurrentPerSource: 2 })
    for (let i = 0; i < 100; i++) expect(rl.allow('192.168.1.10')).toBe(true)
    for (let i = 0; i < 100; i++) expect(rl.allow('127.0.0.1')).toBe(true)
  })
})

describe('makeConnectionRateLimiter — caps a public flood', () => {
  it('denies a public source past the new-connections-per-window ceiling, then recovers after the window', () => {
    let t = 1_000_000
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 3, windowMs: 10_000, maxConcurrentPerSource: 100, maxPendingPerSource: 100, now: () => t })
    expect(rl.allow('8.8.8.8')).toBe(true)
    expect(rl.allow('8.8.8.8')).toBe(true)
    expect(rl.allow('8.8.8.8')).toBe(true)
    expect(rl.allow('8.8.8.8')).toBe(false) // 4th within window → denied
    t += 10_001 // window elapses
    expect(rl.allow('8.8.8.8')).toBe(true)
  })

  it('caps concurrent connections per source and frees a slot on release', () => {
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 1000, maxConcurrentPerSource: 2 })
    // Only an UPGRADED connection counts as concurrent (connection:close fires only for those).
    expect(rl.allow('1.2.3.4', 'a')).toBe(true); rl.upgraded('1.2.3.4', 'a')
    expect(rl.allow('1.2.3.4', 'b')).toBe(true); rl.upgraded('1.2.3.4', 'b')
    expect(rl.allow('1.2.3.4', 'c')).toBe(false) // 2 already open
    rl.release('1.2.3.4')
    expect(rl.allow('1.2.3.4', 'c')).toBe(true) // a slot freed
  })

  it('limits each public source independently', () => {
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 1, maxConcurrentPerSource: 100 })
    expect(rl.allow('8.8.8.8')).toBe(true)
    expect(rl.allow('8.8.8.8')).toBe(false)
    expect(rl.allow('9.9.9.9')).toBe(true) // a different source is unaffected
  })

  it('the default ceilings are generous enough for a real reconnecting device', () => {
    const rl = makeConnectionRateLimiter()
    // A legit public peer reconnecting a few times stays well under the ceiling.
    for (let i = 0; i < 5; i++) { expect(rl.allow('203.0.113.9', `k${i}`)).toBe(true); rl.upgraded('203.0.113.9', `k${i}`); rl.release('203.0.113.9') }
    expect(MAX_NEW_CONNECTIONS_PER_WINDOW).toBeGreaterThanOrEqual(10)
    expect(MAX_CONCURRENT_PER_SOURCE).toBeGreaterThanOrEqual(5)
  })
})

// T340 precondition 5 (docs/work/security/2026-10-09-t340-p5-pending-slot-sizing.md §2 F1, §7).
describe('makeConnectionRateLimiter — pending (pre-upgrade) accounting', () => {
  it('F1: accepted connections that never finish upgrading do not lock the source out once they expire', () => {
    let t = 1_000_000
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 1000, maxConcurrentPerSource: 20, maxPendingPerSource: 1000, pendingTtlMs: 5_000, now: () => t })
    // 20 handshakes that fail: libp2p never fires connection:close for them, so release() never runs.
    for (let i = 0; i < 20; i++) expect(rl.allow('8.8.8.8', `8.8.8.8/${1000 + i}`)).toBe(true)
    t += 5_001
    expect(rl.allow('8.8.8.8', '8.8.8.8/2000')).toBe(true)
  })

  it('refuses a third pending connection from one source while another source is still admitted', () => {
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 1000 })
    expect(rl.allow('8.8.8.8', '8.8.8.8/1')).toBe(true)
    expect(rl.allow('8.8.8.8', '8.8.8.8/2')).toBe(true)
    expect(rl.allow('8.8.8.8', '8.8.8.8/3')).toBe(false)
    expect(rl.allow('9.9.9.9', '9.9.9.9/1')).toBe(true)
  })

  it('an upgraded connection gives its pending slot back and counts as concurrent until release', () => {
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 1000, maxPendingPerSource: 1, maxConcurrentPerSource: 1 })
    expect(rl.allow('8.8.8.8', 'a')).toBe(true)
    expect(rl.allow('8.8.8.8', 'b')).toBe(false) // pending full
    rl.upgraded('8.8.8.8', 'a')
    expect(rl.allow('8.8.8.8', 'c')).toBe(false) // concurrent full
    rl.release('8.8.8.8')
    expect(rl.allow('8.8.8.8', 'c')).toBe(true)
  })

  it('IPv6 addresses in the same /64 share one budget; a different /64 does not', () => {
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 1000 })
    expect(rl.allow('2001:db8:1:2::1', 'x1')).toBe(true)
    expect(rl.allow('2001:db8:1:2:ffff::9', 'x2')).toBe(true)
    expect(rl.allow('2001:0db8:0001:0002::77', 'x3')).toBe(false)
    expect(rl.allow('2001:db8:1:3::1', 'y1')).toBe(true)
  })

  it('prunes per-source state so a scan of many one-shot sources does not grow memory forever', () => {
    let t = 1_000_000
    const rl = makeConnectionRateLimiter({ windowMs: 10_000, pendingTtlMs: 5_000, now: () => t })
    for (let i = 0; i < 500; i++) rl.allow(`8.8.${i >> 8}.${i & 255}`, `k${i}`)
    t += 20_000
    rl.allow('9.9.9.9', 'last')
    expect(rl._sizes().ips).toBeLessThanOrEqual(1)
    expect(rl._sizes().pending).toBeLessThanOrEqual(1)
  })
})
