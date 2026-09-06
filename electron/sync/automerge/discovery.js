// Stage 4d (docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md):
// thin @libp2p/mdns wrapper — NOT a rename or replacement of the existing
// electron/sync/discovery.js (Bonjour), which remains the live WS-protocol
// discovery path, untouched. This is a separate, optional service for
// startTransport() to use on a real LAN.
//
// Deliberately not wired into transport.js's default config: tests dial
// directly over loopback (mDNS needs a real network interface and is
// unreliable in CI/sandboxes — see the design doc's Test strategy). A caller
// that wants real LAN discovery passes this into createLibp2p's
// peerDiscovery array itself, or a future transport.js option threads it
// through — that wiring is Stage 5/6, once this wrapper is proven on real
// hardware (slice 4d's owner-run validation).
//
// Stage 5d-2a (docs/adr/2026-09-06-libp2p-membership-mapping.md, open
// question 1, option (a)): camp-scoped discovery. A Client must be able to
// find only ITS camp's Host among however many Shoresh devices (and
// non-Shoresh libp2p nodes) happen to be on the same LAN.
//
// @libp2p/mdns's public API (init.serviceTag, default '_p2p._udp.local')
// does not expose arbitrary custom TXT-record fields — its query/response
// cycle (query.js: queryLAN/gotQuery/gotResponse) only ever matches on the
// serviceTag string itself: a node querying serviceTag X only ever receives
// answers from nodes also using serviceTag X, and only ever responds to
// queries for its own serviceTag. So a camp-scoped serviceTag IS the
// "advertise a camp identifier" mechanism this library gives us — nodes for
// two different camps advertising two different serviceTags structurally
// never see each other's mDNS traffic at all, before any application-level
// filtering would even run.
//
// PRIVACY: mDNS is broadcast in the clear to every device on the LAN,
// including a stranger's laptop in a shared building. The existing Bonjour
// path (electron/sync/discovery.js, advertiseHost) broadcasts `campName`
// verbatim as the plaintext service name — a real, pre-existing leak this
// module deliberately does NOT copy (flagged separately for Security/Red Hat
// review; not fixed here, out of this slice's scope, which is net-new
// libp2p discovery). This module derives the serviceTag from a one-way hash
// of the camp id, never the camp's human-readable name — an observer on the
// LAN sees an opaque, non-reversible tag, never "Camp Ohalo" or similar.
import crypto from 'node:crypto'
import { mdns } from '@libp2p/mdns'

const SERVICE_TAG_PREFIX = '_shoresh-'
const SERVICE_TAG_SUFFIX = '._udp.local'

// Pure function: campId -> opaque mDNS service tag. SHA-256, truncated to 16
// hex chars — plenty of collision resistance for "how many camps exist on
// one LAN" while keeping the tag well under DNS's 63-char label limit
// (prefix + 16 chars + suffix segment is one label, ~30 chars total).
// One-way: given the tag, the camp id (and certainly the camp name, which
// this function never even sees) cannot be recovered.
export function campDiscoveryTag(campId) {
  if (typeof campId !== 'string' || campId.length === 0) {
    throw new Error('campDiscoveryTag requires a non-empty campId string')
  }
  const hash = crypto.createHash('sha256').update(campId).digest('hex').slice(0, 16)
  return `${SERVICE_TAG_PREFIX}${hash}${SERVICE_TAG_SUFFIX}`
}

// Pure function, independently testable without any real mDNS traffic: does
// a discovered service tag belong to the given camp? Since @libp2p/mdns
// itself already refuses to surface a peer:discovery event for any
// serviceTag other than the one a discovery instance was configured with
// (see the module comment above), this is defense-in-depth / documentation
// of that invariant for any caller that independently tracks which tag a
// peer arrived on — not the primary filtering mechanism, which is the
// serviceTag passed into createMdnsDiscovery below. A missing or malformed
// tag (a stranger's node, or a discovery mechanism that surfaced something
// with no camp affiliation at all) is never treated as a match.
export function belongsToCamp(discoveredServiceTag, campId) {
  if (typeof discoveredServiceTag !== 'string' || typeof campId !== 'string' || campId.length === 0) {
    return false
  }
  return discoveredServiceTag === campDiscoveryTag(campId)
}

// Returns an mDNS peerDiscovery service for use in createLibp2p's
// `peerDiscovery` array. Passing `campId` scopes discovery to that camp's
// opaque tag, so this node only queries for and only responds to its own
// camp's devices — a peer advertising a different camp, or plain
// unscoped mDNS with no campId given, is never in the same discovery
// namespace and is never surfaced as a discovered peer at all. Kept as its
// own module (rather than inlining the hash at every call site) so it has
// one place to grow further LAN-specific options (interval, custom
// serviceTag override for tests) and its own unit test independent of
// mdns()'s own implementation.
export function createMdnsDiscovery({ campId, ...options } = {}) {
  const serviceTag = campId ? campDiscoveryTag(campId) : options.serviceTag
  return mdns({ ...options, serviceTag })
}
