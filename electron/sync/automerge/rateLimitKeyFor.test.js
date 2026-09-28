// T288 forward-finding (b), GOVERNOR OVERRIDE of ADR 2026-09-27 addendum §4/§6 item 7 (wired now,
// not deferred to Slice E): a pure key-derivation function closing the identity-churn bypass on
// authGate.js's pairing_request/login throttles. The correct key is the network source host
// (`connection.remoteAddr`), never `connection.remotePeer` or client-supplied `device_id` — both
// of the latter are free for an attacker to mint fresh per attempt.
//
// org-source-verification (per addendum §7's flagged uncertainty): the installed
// @multiformats/multiaddr@13.0.3 has neither `.nodeAddress()` nor `.toOptions()` (both throw
// "is not a function") — the stable extraction API for this version is `.getComponents()`,
// returning `[{code, name, value}, ...]`. Confirmed directly against the installed package before
// writing rateLimitKeyFor below; see its own comment.
import { describe, it, expect } from 'vitest'
import { multiaddr } from '@multiformats/multiaddr'
import { rateLimitKeyFor } from './authGate.js'

function connectionWith(addr, remotePeer = 'peer-a') {
  return { remoteAddr: multiaddr(addr), remotePeer: { toString: () => remotePeer } }
}

describe('rateLimitKeyFor — resists identity churn', () => {
  it('two connections with different remotePeer but the same remoteAddr host produce the SAME key', () => {
    const a = connectionWith('/ip4/203.0.113.9/tcp/4001', 'peer-a')
    const b = connectionWith('/ip4/203.0.113.9/tcp/58211', 'peer-b') // different port AND peer
    expect(rateLimitKeyFor(a)).toBe(rateLimitKeyFor(b))
  })

  it('two genuinely different source IPs are NOT throttled together', () => {
    const a = connectionWith('/ip4/203.0.113.9/tcp/4001')
    const b = connectionWith('/ip4/198.51.100.7/tcp/4001')
    expect(rateLimitKeyFor(a)).not.toBe(rateLimitKeyFor(b))
  })

  it('handles ip6', () => {
    const a = connectionWith('/ip6/2001:db8::1/tcp/4001')
    const b = connectionWith('/ip6/2001:db8::1/tcp/9999')
    const c = connectionWith('/ip6/2001:db8::2/tcp/4001')
    expect(rateLimitKeyFor(a)).toBe(rateLimitKeyFor(b))
    expect(rateLimitKeyFor(a)).not.toBe(rateLimitKeyFor(c))
  })

  it('falls back to the full remoteAddr string, rather than throwing, when there is no IP tuple', () => {
    const a = connectionWith('/dns4/example.com/tcp/443')
    expect(() => rateLimitKeyFor(a)).not.toThrow()
    expect(typeof rateLimitKeyFor(a)).toBe('string')
    expect(rateLimitKeyFor(a).length).toBeGreaterThan(0)
  })

  it('is keyed by host only, not by the connection object identity', () => {
    const a = connectionWith('/ip4/203.0.113.9/tcp/4001', 'peer-a')
    const aAgain = connectionWith('/ip4/203.0.113.9/tcp/4001', 'peer-a')
    expect(rateLimitKeyFor(a)).toBe(rateLimitKeyFor(aAgain))
  })
})
