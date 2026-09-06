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
import { mdns } from '@libp2p/mdns'

// Returns an mDNS peerDiscovery service for use in createLibp2p's
// `peerDiscovery` array. A thin pass-through today; kept as its own module so
// it has one place to grow LAN-specific options (interval, service tag) and
// its own unit test independent of `mdns()`'s own implementation.
export function createMdnsDiscovery(options = {}) {
  return mdns(options)
}
