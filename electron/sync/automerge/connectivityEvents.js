// ADR: docs/adr/2026-09-18-connectivity-observability-event-vocabulary.md
// T212 (docs/work/tickets/T212-wan-connectivity-measurement.md): a pure, sink-injectable event
// vocabulary for the discovery -> dial -> mutual-auth seam, so a WAN pairing failure can be
// classified as "never discovered" vs "discovered but direct dial never succeeded" vs "dialed and
// mutual auth rejected it" from logs alone, instead of the ad-hoc console.error/warn strings
// mutualAuth.js reported before this.
//
// No imports from libp2p, automerge, better-sqlite3, or any other file in this directory — this
// module is unit-testable with a plain fake sink. Callers (mutualAuth.js) never touch redaction
// policy directly: emit() hides field-allowlisting, address classification, and crash-proofing.
//
// This module does NOT read process.env. The caller that constructs the emitter (syncNode.js)
// decides `verboseAddrs` from its own environment; keeping that read out of this file is what
// keeps it dependency-free and trivially unit-testable.

export const EVENTS = Object.freeze({
  PEER_DISCOVERED: 'PEER_DISCOVERED',
  TRUST_CHECK_REJECTED: 'TRUST_CHECK_REJECTED',
  DIAL_FAILED: 'DIAL_FAILED',
  ATTEMPT_STALLED: 'ATTEMPT_STALLED',
  AUTH_REJECTED: 'AUTH_REJECTED',
  AUTH_ERROR: 'AUTH_ERROR',
  AUTH_OK: 'AUTH_OK',
  // Vocabulary only. Reserved for the still-parked rendezvous adapter (T211) — no running code
  // emits this today, and nothing under electron/sync/automerge/rendezvous*.js is imported here.
  RENDEZVOUS_UNAVAILABLE: 'RENDEZVOUS_UNAVAILABLE',
  NO_TOKEN: 'NO_TOKEN',
})

// Per-event field allowlist, beyond the shared { ts, peerId, source }. This is itself a leak
// guard (ADR Decision 1): a field not named here is silently dropped rather than passed through,
// so a caller that accidentally hands emit() a token or PIN under a made-up key does not leak it.
// NOTE (Code Reviewer, T212 round 2): PEER_DISCOVERED's entry below is NOT authoritative for that
// event's shape — its real field set comes from buildPeerDiscoveredFields()/emit()'s special-case
// branch (multiaddrCount/multiaddrClasses/repeatCount, plus multiaddrs when verboseAddrs), not from
// this list. It is listed only so the EVENTS/FIELD_ALLOWLIST key-parity invariant below has an
// entry to compare against. Every other event's list below IS authoritative.
export const FIELD_ALLOWLIST = Object.freeze({
  [EVENTS.PEER_DISCOVERED]: [],
  [EVENTS.TRUST_CHECK_REJECTED]: ['reason'],
  [EVENTS.DIAL_FAILED]: ['reused', 'errorClass', 'attemptId'],
  [EVENTS.ATTEMPT_STALLED]: ['attemptTimeoutMs', 'attemptId'],
  [EVENTS.AUTH_REJECTED]: ['retried', 'attemptId'],
  [EVENTS.AUTH_ERROR]: ['retried', 'errorClass', 'attemptId'],
  [EVENTS.AUTH_OK]: ['attemptId'],
  [EVENTS.RENDEZVOUS_UNAVAILABLE]: ['reason'],
  [EVENTS.NO_TOKEN]: ['attemptId'],
})

const ERROR_CLASSES = Object.freeze(['timeout', 'refused', 'reset', 'unreachable', 'unknown'])

// A closed enum, derived from the caught error, is what reaches emit() — never err.message
// verbatim (a libp2p dial error message can itself embed a multiaddr; see the ADR's Decision 2).
export function classifyError(err) {
  const code = err?.code
  if (code === 'ETIMEDOUT' || code === 'ETIMEOUT') return 'timeout'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') return 'reset'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND') return 'unreachable'
  return ERROR_CLASSES.includes(code) ? code : 'unknown'
}

// 'cgnat' is its own class, not folded into 'private' (Security finding, T212 round 2): a CGNAT
// peer (behind its ISP's shared address, RFC 6598) is exactly the case the D/F NAT-traversal
// decision turns on — it is NOT under this device's own network administration the way an RFC1918
// address is, and folding it into 'private' would make a carrier-NAT peer indistinguishable from
// one on a home router the operator controls, hiding the very signal the measurement exists to
// surface.
function classifyIp4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'public'
  const [a, b] = parts
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'private'
  return 'public'
}

function classifyIp6(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1') return 'loopback'
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) embeds a real IPv4 address — classify by that address's own
  // rules rather than falling through to 'public', or a private/CGNAT peer reached via a
  // dual-stack socket would misreport as publicly reachable.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return classifyIp4(mapped[1])
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return 'private'
  return 'public'
}

// Classifies a single multiaddr string into a class, never returning the address itself — this
// is the privacy boundary the ADR names: a multiaddr on a residential/camp network is a personal
// or institutional network location, and only its class is emitted by default.
export function classifyMultiaddr(addr) {
  const str = String(addr)
  const ip4 = str.match(/\/ip4\/([\d.]+)(?:\/|$)/)
  if (ip4) return classifyIp4(ip4[1])
  const ip6 = str.match(/\/ip6\/([0-9a-fA-F:.]+)(?:\/|$)/)
  if (ip6) return classifyIp6(ip6[1])
  return 'public'
}

function defaultConsoleSink(line) {
  // Structured data, not an operator alarm — console.log, not console.error. Existing
  // console.error/warn lines in mutualAuth.js stay as-is; this is additive.
  console.log(line)
}

function buildPeerDiscoveredFields(fields, verboseAddrs) {
  const multiaddrs = Array.isArray(fields.multiaddrs) ? fields.multiaddrs.map(String) : []
  const out = {
    multiaddrCount: multiaddrs.length,
    multiaddrClasses: multiaddrs.map(classifyMultiaddr),
  }
  // repeatCount: how many announces this emission summarizes, set by the caller's own dedupe
  // window (mutualAuth.js) — this module has no notion of "recent" on its own. Present only when
  // the caller passes it, so a single first-time discovery keeps the pre-existing shape.
  if (Number.isInteger(fields.repeatCount) && fields.repeatCount > 0) out.repeatCount = fields.repeatCount
  if (verboseAddrs) out.multiaddrs = multiaddrs
  return out
}

/**
 * createConnectivityEmitter({ sink, verboseAddrs, now }) -> { emit }
 *
 * emit(eventName, fields) never throws: an unknown event name is dropped with a single
 * console.error, and a sink that throws is caught and reported the same way — a broken sink
 * must never break libp2p's event dispatch or the auth path it instruments.
 */
export function createConnectivityEmitter({ sink = defaultConsoleSink, verboseAddrs = false, now = () => Date.now() } = {}) {
  function emit(eventName, fields = {}) {
    try {
      const allowlist = FIELD_ALLOWLIST[eventName]
      if (!allowlist) {
        console.error(`connectivityEvents: unknown event "${eventName}" dropped`)
        return
      }

      const payload = {
        event: eventName,
        ts: now(),
        peerId: fields.peerId,
        source: fields.source ?? 'mdns',
      }

      if (eventName === EVENTS.PEER_DISCOVERED) {
        Object.assign(payload, buildPeerDiscoveredFields(fields, verboseAddrs))
      } else {
        for (const key of allowlist) {
          if (key in fields) payload[key] = fields[key]
        }
      }

      sink(JSON.stringify(payload))
    } catch (err) {
      console.error(`connectivityEvents: sink threw handling ${eventName}: ${err?.message ?? err}`)
    }
  }

  return { emit }
}
