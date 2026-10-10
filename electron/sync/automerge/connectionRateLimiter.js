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
// T340 precondition 5 (docs/work/security/2026-10-09-t340-p5-pending-slot-sizing.md): at most this many
// connections per source may sit in libp2p's shared pre-Noise pending slots at once, so one source
// cannot hold them all. An entry expires after PENDING_TTL_MS (transport.js passes its
// inboundUpgradeTimeout), because libp2p reports no event for a handshake that fails.
export const MAX_PENDING_PER_SOURCE = 2
export const PENDING_TTL_MS = 5_000
// LAN-reserved pending capacity: at most this many connections from ALL public sources together may
// sit in the shared pending slots, so private/LAN sources always keep (global cap - this) of them.
export const MAX_PUBLIC_PENDING_TOTAL = 32

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

// The budget key for a source: the IPv4 address itself, or the /64 network of an IPv6 address (one
// subscriber typically holds a whole /64, so keying on the full address would hand an attacker
// unlimited sources).
export function sourceKey(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return ip
  const addr = ip.split('%')[0].toLowerCase()
  const [head, tail = ''] = addr.split('::')
  const h = head ? head.split(':') : []
  const t = addr.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

// makeConnectionRateLimiter(opts) -> { allow(ip, connKey), upgraded(ip, connKey), release(ip), _sizes() }
// allow(ip, connKey): call on an inbound connection attempt (the gater, before Noise). Returns false
//   to DENY for a public source over its new-connection rate, its concurrent cap, or its pending cap.
//   On allow, records connKey as PENDING until upgraded() or until pendingTtlMs passes.
// upgraded(ip, connKey): call when that inbound connection finished upgrading (connection:open). It
//   leaves pending and counts as concurrent. Only upgraded connections ever get a connection:close,
//   so counting concurrent here (not in allow) is what keeps release() balanced (F1).
// release(ip): call when an upgraded connection closes, to free its concurrent slot.
// Private/loopback/unknown sources are never limited (isExempt; injectable for tests only).
export function makeConnectionRateLimiter({
  maxNewConnectionsPerWindow = MAX_NEW_CONNECTIONS_PER_WINDOW,
  windowMs = RATE_WINDOW_MS,
  maxConcurrentPerSource = MAX_CONCURRENT_PER_SOURCE,
  maxPendingPerSource = MAX_PENDING_PER_SOURCE,
  maxPublicPendingTotal = MAX_PUBLIC_PENDING_TOTAL,
  pendingTtlMs = PENDING_TTL_MS,
  isExempt = isPrivateOrLoopback,
  now = Date.now,
} = {}) {
  const recentByIp = new Map() // source -> number[] accept timestamps within the window
  const concurrentByIp = new Map() // source -> count of currently-open upgraded connections
  const pendingByIp = new Map() // source -> Map(connKey -> expiry)
  let anonKey = 0
  let lastPrune = now()

  function livePending(key, t) {
    const m = pendingByIp.get(key)
    if (!m) return null
    for (const [k, exp] of m) if (exp <= t) m.delete(k)
    if (m.size === 0) { pendingByIp.delete(key); return null }
    return m
  }

  function publicPendingTotal(t) {
    let n = 0
    for (const key of [...pendingByIp.keys()]) n += livePending(key, t)?.size ?? 0
    return n
  }

  // Drop expired/empty per-source state so a scan of many one-shot sources cannot grow memory forever.
  function prune(t) {
    if (t - lastPrune < Math.min(windowMs, pendingTtlMs)) return
    lastPrune = t
    for (const [key, ts] of recentByIp) {
      const kept = ts.filter((x) => t - x < windowMs)
      if (kept.length === 0) recentByIp.delete(key)
      else recentByIp.set(key, kept)
    }
    for (const key of [...pendingByIp.keys()]) livePending(key, t)
  }

  function allow(ip, connKey) {
    if (isExempt(ip)) return true // LAN / loopback / unknown: never limited
    const t = now()
    prune(t)
    const key = sourceKey(ip)
    const recent = (recentByIp.get(key) ?? []).filter((ts) => t - ts < windowMs)
    const pending = livePending(key, t)
    if (
      recent.length >= maxNewConnectionsPerWindow ||
      (concurrentByIp.get(key) ?? 0) >= maxConcurrentPerSource ||
      (pending?.size ?? 0) >= maxPendingPerSource ||
      publicPendingTotal(t) >= maxPublicPendingTotal
    ) {
      if (recent.length) recentByIp.set(key, recent) // persist the pruned window even on denial
      else recentByIp.delete(key)
      return false
    }
    recent.push(t)
    recentByIp.set(key, recent)
    const m = pending ?? new Map()
    m.set(connKey ?? `anon:${anonKey++}`, t + pendingTtlMs)
    pendingByIp.set(key, m)
    return true
  }

  function upgraded(ip, connKey) {
    if (isExempt(ip)) return
    const key = sourceKey(ip)
    const m = pendingByIp.get(key)
    if (m) { m.delete(connKey); if (m.size === 0) pendingByIp.delete(key) }
    concurrentByIp.set(key, (concurrentByIp.get(key) ?? 0) + 1)
  }

  function release(ip) {
    if (isExempt(ip)) return
    const key = sourceKey(ip)
    const c = (concurrentByIp.get(key) ?? 0) - 1
    if (c <= 0) concurrentByIp.delete(key)
    else concurrentByIp.set(key, c)
  }

  return {
    allow,
    upgraded,
    release,
    isExempt,
    _sizes: () => ({ ips: recentByIp.size, concurrent: concurrentByIp.size, pending: pendingByIp.size }),
  }
}

// The per-connection key the gater and connection:open agree on: "<ip>/<tcp port>". The upgraded
// connection's remoteAddr may carry a /p2p/<id> suffix the raw socket's does not, so only ip+port.
export function connKeyFromMultiaddr(maStr) {
  const ip = ipFromMultiaddr(maStr)
  if (!ip) return null
  const m = /\/(?:tcp|udp)\/(\d+)/.exec(maStr)
  return `${ip}/${m ? m[1] : ''}`
}
