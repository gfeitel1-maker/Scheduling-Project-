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
// `inertPresence`: true = the package may sit in the tree while `signoff` is null, but only under a
// dedicated guard test that proves its sole strictly-gated entry point. No row uses it since the T340 switch-on.
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
        "MAX_CONNECTIONS=200 distributed-source DoS mitigation (T336-created latent exposure) — MITIGATED 2026-10-08 (docs/adr/2026-10-08-max-connections-dos-mitigation.md): un-admitted inbound cap + authGate deadline + pending cap. An ESTABLISHED admitted connection is never evicted by an un-admitted flood (hard guarantee — the floor). A RECONNECTING camp device regains a slot LIKELY within an authGate-deadline turnover cycle, but this is NOT guaranteed under a sustained distributed flood — it competes for the recycling un-admitted slots.",
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
  // T347 (S1 of docs/adr/2026-10-08-relayless-cross-network-reconnect.md): node-datachannel, the ICE
  // data-channel pipe wrapped as a libp2p transport (punchTransport.js), reached only through the single
  // strictly-gated door in syncStarter.js (SHORESH_PUNCH_ENABLED === 'true'; punchPresenceWithoutSignoff.guard.test.js
  // proves there is no other importer). T340 switch-on: signed off 2026-10-10 on the owner's "On now" go,
  // so packaged builds resolve the flag to 'true' by default (electron/wanDefaults.js). No STUN/TURN server
  // is ever configured (punchTransport.js refuses a non-empty iceServers).
  punch: {
    packages: ['node-datachannel'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: {
      date: '2026-10-10',
      owner: 'gfeitel1 (owner GO "On now" 2026-10-10, relayed by board keeper)',
      scope: 'hole-punch rungs 1-2 plus the rung-3 Cloudflare rendezvous fallback, default ON in packaged builds only; no STUN',
      doc: 'docs/work/security/2026-10-09-wan-ladder-assessment.md#verdict-go-with-conditions-for-shoresh_punch_enabled-default-on',
      conditions: [
        'met: F1 fixed, rendezvous namespace and address key rotate on revocation (PR #841)',
        'OPEN: real independently-NATed two-device hardware proof; owner chose On now ahead of the 2-laptop test; to be recorded after the fact',
        'met: PRs #836 and #837 merged with CI green',
        'met: this signoff written; npm audit and postinstall re-check recorded in docs/work/security/2026-10-08-t340-precondition-evidence.md (b), re-run by npm run security in the gate',
        'met: revoked peer on a punch connection is disconnected, test added (PR #841)',
        'met: Cloudflare Workers Logs and Logpush off, limiter bindings live (docs/work/security/2026-10-09-wan-ladder-assessment.md, owner-side evidence Q3)',
      ],
    },
  },
  // T359 (docs/adr/2026-10-09-router-port-mapping-on-rung-1.md): router port mapping of the libp2p TCP
  // listener via UPnP-IGD / NAT-PMP. LAN-only egress: SSDP multicast to 239.255.255.250:1900, HTTP/SOAP to the
  // gateway's own LAN address, NAT-PMP UDP to the gateway's port 5351. `egressAllowlist` is the exact set of
  // files allowed to open that UDP egress (the scan exempts ONLY its dgram label there; any other egress
  // label in the file still fails). Reached only through portMappingLifecycle.js, built inside the strict
  // SHORESH_PUNCH_ENABLED block. T340 switch-on: signed off 2026-10-10 with the punch row.
  portMapping: {
    packages: ['@achingbrain/nat-port-mapper', '@achingbrain/ssdp'],
    sourceMarkers: [],
    egressAllowlist: ['electron/sync/automerge/portMapping.js'],
    signoff: {
      date: '2026-10-10',
      owner: 'gfeitel1 (owner GO "On now" 2026-10-10, relayed by board keeper)',
      scope: 'one router port opened for the libp2p TCP listener while the app runs; only paired devices pass Noise plus mutual auth; removed on quit, sync stop and network change (kept on a peer revoke; the revoked peer is stopped by Noise, authGate and isPeerRevoked)',
      doc: 'docs/work/security/2026-10-09-wan-ladder-assessment.md#verdict-go-with-conditions-for-shoresh_punch_enabled-default-on',
      conditions: [
        'met: pre-Noise pending slots sized for internet exposure, public sources capped (PR #858, T340 precondition 5)',
        'met: egress gate, pending-slot scanner test and docs (PR #865)',
        'met: fixed pending caps 128 total / 32 public (LAN keeps 96); combined fd worst case recorded in SECURITY.md (PR #868)',
        'OPEN: real independently-NATed two-device hardware proof; owner chose On now ahead of the 2-laptop test; to be recorded after the fact',
      ],
    },
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
export const forbiddenPackagesFor = (registry) =>
  Object.values(registry).flatMap((c) => (c.signoff || c.inertPresence ? [] : c.packages))
export const ALL_FORBIDDEN_PACKAGES = () => forbiddenPackagesFor(TRANSPORT_CAPABILITIES)
export const ALL_FORBIDDEN_MARKERS = () =>
  Object.values(TRANSPORT_CAPABILITIES).flatMap((c) => (c.signoff ? [] : c.sourceMarkers))
export const DISCOVERY_EGRESS_ALLOWLIST = TRANSPORT_CAPABILITIES.discovery.egressAllowlist
export const PORT_MAPPING_EGRESS_ALLOWLIST = TRANSPORT_CAPABILITIES.portMapping.egressAllowlist
export const portMappingEgressOn = (registry = TRANSPORT_CAPABILITIES) =>
  Boolean(registry.portMapping.signoff || registry.portMapping.inertPresence)
