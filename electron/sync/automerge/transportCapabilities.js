// Per-capability transport-boundary registry — Tier-4 (docs/adr/2026-09-14-internet-transport-security-gate.md,
// docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, "Addendum 2026-09-28 (Architect, T288)" §1).
//
// This file is the ONLY place a capability's authorization state lives. transportBoundary.guard.test.js
// reads it; nothing else hard-codes a second copy of "is X allowed". Default for every capability is
// BLOCKED; a capability becomes ALLOWED only by adding a `signoff` entry here, in the same PR that
// lands the capability's code, under mandatory Security + Red Hat review.
//
// Deliberately data, not wiring: imported by the guard test and by nothing at runtime. Production
// code (transport.js, syncStarter.js) must never import this file and branch on it — the gate is a
// build-time/test-time check only.
//
// `packages`: npm package names whose presence anywhere in the RESOLVED dependency tree (not just
// direct deps — package-lock.json's `packages` map, walked, not package.json) implies this capability.
// `sourceMarkers`: literal strings that must not appear in syncStarter.js's source while this
// capability is blocked.
// `egressAllowlist`: for the discovery capability only — the exact, closed set of repo-relative
// FILE PATHS (not basenames — a second file sharing a basename at a different path must not
// inherit the exemption) authorized to perform their own network egress (fetch/https/etc). Every
// other file under electron/sync/** must have zero egress, regardless of capability state.
// `signoff`: null = blocked (default). `{date, owner, doc}` = authorized, `doc` pointing at a dated
// sign-off record.
export const TRANSPORT_CAPABILITIES = {
  discovery: {
    packages: [],
    sourceMarkers: [],
    egressAllowlist: ['electron/sync/automerge/rendezvousClient.js'],
    signoff: {
      date: '2026-09-28',
      owner: 'gfeitel1', // GitHub handle, not an email — keep PII out of public history; provenance is `doc`
      doc: 'docs/work/security/2026-09-26-internet-transport-signoff-reassessment.md#owner-sign-off',
    },
  },
  relay: {
    packages: ['@libp2p/circuit-relay-v2'],
    sourceMarkers: ['circuitRelay'],
    egressAllowlist: [],
    signoff: null,
  },
  dcutr: {
    packages: ['@libp2p/dcutr', '@libp2p/autonat'],
    sourceMarkers: ['dcutr', 'autonat'],
    egressAllowlist: [],
    signoff: null,
  },
  webrtc: {
    packages: ['@libp2p/webrtc', '@libp2p/webrtc-direct'],
    sourceMarkers: ['webRTC'],
    egressAllowlist: [],
    signoff: null,
  },
  websockets: {
    packages: ['@libp2p/websockets'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
  webtransport: {
    packages: ['@libp2p/webtransport'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
  quic: {
    packages: ['@chainsafe/libp2p-quic'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
  kadDht: {
    packages: ['@libp2p/kad-dht'],
    sourceMarkers: ['kadDHT'],
    egressAllowlist: [],
    signoff: null,
  },
  bootstrap: {
    packages: ['@libp2p/bootstrap'],
    sourceMarkers: ['bootstrap('],
    egressAllowlist: [],
    signoff: null,
  },
  upnp: {
    packages: ['@libp2p/upnp-nat'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
}

// Flat views the guard consumes — computed, never hand-duplicated.
export const ALL_FORBIDDEN_PACKAGES = () =>
  Object.values(TRANSPORT_CAPABILITIES).flatMap((c) => (c.signoff ? [] : c.packages))
export const ALL_FORBIDDEN_MARKERS = () =>
  Object.values(TRANSPORT_CAPABILITIES).flatMap((c) => (c.signoff ? [] : c.sourceMarkers))
export const DISCOVERY_EGRESS_ALLOWLIST = TRANSPORT_CAPABILITIES.discovery.egressAllowlist
