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
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 3, windowMs: 10_000, maxConcurrentPerSource: 100, now: () => t })
    expect(rl.allow('8.8.8.8')).toBe(true)
    expect(rl.allow('8.8.8.8')).toBe(true)
    expect(rl.allow('8.8.8.8')).toBe(true)
    expect(rl.allow('8.8.8.8')).toBe(false) // 4th within window → denied
    t += 10_001 // window elapses
    expect(rl.allow('8.8.8.8')).toBe(true)
  })

  it('caps concurrent connections per source and frees a slot on release', () => {
    const rl = makeConnectionRateLimiter({ maxNewConnectionsPerWindow: 1000, maxConcurrentPerSource: 2 })
    expect(rl.allow('1.2.3.4')).toBe(true)
    expect(rl.allow('1.2.3.4')).toBe(true)
    expect(rl.allow('1.2.3.4')).toBe(false) // 2 already open
    rl.release('1.2.3.4')
    expect(rl.allow('1.2.3.4')).toBe(true) // a slot freed
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
    for (let i = 0; i < 5; i++) { expect(rl.allow('203.0.113.9')).toBe(true); rl.release('203.0.113.9') }
    expect(MAX_NEW_CONNECTIONS_PER_WINDOW).toBeGreaterThanOrEqual(10)
    expect(MAX_CONCURRENT_PER_SOURCE).toBeGreaterThanOrEqual(5)
  })
})
