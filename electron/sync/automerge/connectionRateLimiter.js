// Per-source inbound-connection rate limiting — the internet-scale DoS backstop (blocker #2 of the
// WAN-transport hardening; ADR docs/adr/2026-09-14-internet-transport-security-gate.md).
//
// THE GAP THIS CLOSES. authGate.js throttles pairing/login per-peer and per-device, but documents
// its own hole: a peer that opens a BRAND NEW connection (fresh noise handshake, fresh peer id) per
// frame evades the per-peer throttle and is bounded only by transport.js's global MAX_CONNECTIONS.
// On a LAN that is fine — a handful of physically-present devices. On the public internet any host
// can churn connections to exhaust the global budget or flood the handshake path. This limits NEW
// inbound connections and CONCURRENT connections per SOURCE IP, which is the identity a connection
// churn cannot cheaply rotate (unlike the peer id).
//
// PROVABLY INERT ON THE LAN. It exempts loopback and every private/link-local range, so on the LAN
// (all private IPs) and in tests (loopback) it never denies anything — it can only ever limit a
// PUBLIC source, which only appears once internet transport is actually enabled. No flag needed:
// the address space itself gates it.
//
// Pure and clock-injectable so it is unit-testable without a network (mirrors rateLimit.js).

// Generous ceilings — a legitimate device reconnecting, even aggressively, stays well under these;
// only a flood from one public source trips them.
export const MAX_NEW_CONNECTIONS_PER_WINDOW = 30
export const RATE_WINDOW_MS = 10_000
export const MAX_CONCURRENT_PER_SOURCE = 20

// Loopback + RFC1918 private + link-local + IPv6 ULA/link-local. A LAN camp lives entirely in these
// ranges, so an exempt source is never limited. Everything else is treated as public.
export function isPrivateOrLoopback(ip) {
  if (!ip || typeof ip !== 'string') return true // unknown source: fail OPEN (never break a real peer we can't classify)
  const addr = ip.trim().toLowerCase()
  if (addr === '::1' || addr === '::') return true
  if (addr.startsWith('127.')) return true
  if (addr.startsWith('10.')) return true
  if (addr.startsWith('192.168.')) return true
  if (addr.startsWith('169.254.')) return true // IPv4 link-local
  // 172.16.0.0 – 172.31.255.255
  const m = addr.match(/^172\.(\d+)\./)
  if (m) { const o = Number(m[1]); if (o >= 16 && o <= 31) return true }
  // IPv6 (possibly zone-suffixed): link-local fe80::/10 and unique-local fc00::/7 (fc/fd).
  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) return true
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true
  return false
}

// Extract the host from a multiaddr string like "/ip4/1.2.3.4/tcp/5" or "/ip6/2001:db8::1/tcp/5".
// Returns null when no ip4/ip6 component is present (e.g. a relayed /p2p-circuit addr), which the
// limiter treats as unknown → exempt (fail open).
export function ipFromMultiaddr(maStr) {
  if (!maStr || typeof maStr !== 'string') return null
  const parts = maStr.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'ip4' || parts[i] === 'ip6') return parts[i + 1]
  }
  return null
}

// makeConnectionRateLimiter(opts) -> { allow(ip) -> boolean, release(ip), _sizes() }
// allow(ip): call on an inbound connection attempt. Returns false to DENY (rate/concurrency exceeded
//   for a public source). Private/loopback/unknown always allowed. On allow, counts one concurrent.
// release(ip): call when that connection closes, to free its concurrent slot.
export function makeConnectionRateLimiter({
  maxNewConnectionsPerWindow = MAX_NEW_CONNECTIONS_PER_WINDOW,
  windowMs = RATE_WINDOW_MS,
  maxConcurrentPerSource = MAX_CONCURRENT_PER_SOURCE,
  now = Date.now,
} = {}) {
  const recentByIp = new Map() // ip -> number[] accept timestamps within the window
  const concurrentByIp = new Map() // ip -> count of currently-open connections

  function allow(ip) {
    if (isPrivateOrLoopback(ip)) return true // LAN / loopback / unknown: never limited
    const t = now()
    const recent = (recentByIp.get(ip) ?? []).filter((ts) => t - ts < windowMs)
    if (recent.length >= maxNewConnectionsPerWindow) {
      recentByIp.set(ip, recent) // persist the pruned window even on denial
      return false
    }
    if ((concurrentByIp.get(ip) ?? 0) >= maxConcurrentPerSource) {
      recentByIp.set(ip, recent)
      return false
    }
    recent.push(t)
    recentByIp.set(ip, recent)
    concurrentByIp.set(ip, (concurrentByIp.get(ip) ?? 0) + 1)
    return true
  }

  function release(ip) {
    if (isPrivateOrLoopback(ip)) return
    const c = (concurrentByIp.get(ip) ?? 0) - 1
    if (c <= 0) concurrentByIp.delete(ip)
    else concurrentByIp.set(ip, c)
  }

  return {
    allow,
    release,
    _sizes: () => ({ ips: recentByIp.size, concurrent: concurrentByIp.size }),
  }
}
