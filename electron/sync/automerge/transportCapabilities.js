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
    // T337 — authorizes CODE MERGE of the inert coordination relay only. Not a hand-signature: the
    // owner gave a 2026-10-03 conditional YES ("if it is safe, secure, and reasonable... if it
    // exposes data or the computer harmfully, then no") and DELEGATED the determination to the
    // security + battle-test gate (his T327 delegation); the gate passed and the organizer accepted
    // on the passed gate. Runtime activation (SHORESH_RELAY_ENABLED) stays blocked independently of
    // this entry: relayRuntimeEligible requires SHORESH_RELAY_ENABLED, which defaults false. (As of
    // T336 holePunchFoundationPresent() — the @libp2p/dcutr presence probe — is now true, but the
    // flag default alone keeps relay+dcutr inert.) See relayEnablement.js + dcutrPresenceWithoutSignoff.guard.test.js.
    signoff: {
      date: '2026-10-03',
      owner: 'gate (owner 2026-10-03 conditional-YES + T327 delegation; accepted by organizer)',
      scope: 'coordination/signaling only; primary-data-path use gated on dcutr (T336) signoff',
      conditions: [
        'C2: client-side camp-only auto-reservation — prove at the T336 runtime-enable gate before SHORESH_RELAY_ENABLED=true',
        'C4: internet-scale pre-auth sizing (rateLimit.js/authGate.js) — re-confirm at the T336 gate',
      ],
      doc: 'docs/work/security/2026-10-03-t337-standing-reservation-signoff-battletest.md#signoff-decision',
    },
  },
  // T336 ships dcutr only. AutoNAT (@libp2p/autonat) is deliberately NOT shipped — @libp2p/autonat@3.0.28
  // has no admission/connectionGater hook (cannot be camp-scoped; a non-camp party could use our node
  // AS an AutoNAT server) and @libp2p/dcutr does not depend on it. See relayEnablement.js + the T336
  // design doc. If AutoNAT is ever revisited it is separately-scoped new work with its own exposure review.
  dcutr: {
    packages: ['@libp2p/dcutr'],
    sourceMarkers: ['dcutr'],
    egressAllowlist: [],
    // T336 — authorizes the CODE MERGE of the inert hole-punch capability only. Not a hand-signature:
    // the owner gave a 2026-10-03 conditional YES ("if it is safe, secure, and reasonable... if it
    // exposes data or the computer harmfully, then no") and DELEGATED the determination to the
    // security + battle-test gate (T327 delegation); the gate passed for the INERT merge and the
    // organizer accepted after independently spot-checking the branch. Writing this flips the dcutr
    // Tier-4 guard reds green = the merge; it does NOT activate anything (this registry is never read
    // at runtime). Runtime activation is SHORESH_RELAY_ENABLED (default false), a SEPARATE owner
    // go-live gated on the pre-activation preconditions in `doc`.
    signoff: {
      date: '2026-10-03',
      owner: 'gate (owner 2026-10-03 conditional-YES + T327 delegation; accepted by organizer)',
      scope: 'coordination/hole-punch, code-merge-inert; runtime activation gated on the pre-activation preconditions + owner go-live',
      conditions: [
        'MAX_CONNECTIONS=200 distributed-source DoS mitigation (T336-created latent exposure) — reserved-slot floor for admitted peers + early-drop for un-admitted + aggregate inbound cap',
        'real independently-NATed two-device cross-network dcutr punch validation (owner hardware)',
        're-confirm T337 C2 (client camp-only reservation) + C4 (pre-auth sizing) at the activation gate',
        're-run dcutr-subtree npm audit + postinstall check at activation',
        'ADR 2026-09-14 owner items: signed auto-update; internet-scale rate-limit review',
        "SHORESH_RELAY_ENABLED must be the literal string 'true' (fails closed otherwise)",
      ],
      doc: 'docs/work/security/2026-10-03-t336-holepunch-dcutr-inert-merge-assessment.md#signoff-decision',
    },
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
