---
ticket: T359
document_type: ticket
title: Router port mapping on rung 1 (UPnP-IGD / NAT-PMP, no STUN), five PRs, inert behind SHORESH_PUNCH_ENABLED
status: open
created: 2026-10-09
archive_when: "the punch UDP port is mapped through the router with no third party, the router-reported public address reaches a roaming peer's rung-1 memory and is dialled first, the mapping is removed on quit, revoke and disable and stale mappings are cleaned at startup, the director sees a plain status flag, the new LAN egress has a gate entry and test, and the owner's two-laptop session has recorded one consumer router and one phone hotspot; nothing activates without SHORESH_PUNCH_ENABLED"
task_class: security-auth
parent: T347
governing_docs: [docs/adr/2026-10-09-router-port-mapping-on-rung-1.md, docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/work/specs/2026-10-09-router-port-mapping-feasibility.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T358-s4c-reconnect-coordinator.md]
---

# T359 - Router port mapping on rung 1

Success predicate: with STUN unset and the rendezvous unreachable, a laptop at a new spot dials the office laptop's remembered router-mapped address and syncs; when the office router refuses, the director sees why, and the ladder falls to rungs 2 and 3; after quit or revoke the router table shows no entry.

Non-goals: CGNAT or double-NAT offices (detected and reported only), PCP, STUN of any kind, a port range or multi-peer-per-port, any change to the trust model, both devices at never-seen spots.

Library: `@achingbrain/nat-port-mapper` directly. Not `@libp2p/upnp-nat`. Each slice is its own PR, test-first, `npm run check:governance` before every push.

## Slices

1. **Mapper module + status result.** `electron/sync/automerge/portMapping.js` (collaborators injected, fake gateway in tests): discover UPnP then NAT-PMP, double-NAT check (private or 100.64/10), map the pinned port, 1 h lease with refresh, unmap. Returns `mapped | refused | no-gateway | double-nat | permanent-lease | error` plus the returned external IP and port. Never throws. Rejects SSDP `LOCATION` URLs off the gateway subnet; XML size cap and timeouts. Adds the dependency (resolve the version from the lockfile; under Node 22 on Intel macOS). No caller yet.
2. **Mapped candidate + rung-1 dial order.** Publish the mapped address first in this device's gossip entry; write verified peer gossip candidates into `peer_punch_memory.candidates` while connected (no schema change), public-filtered and bounded; rung 1 dials mapped-sourced candidates first with a 7 day age limit. **First step: verify whether a LAN-only pair has any punch memory (ADR "Consequences"); if not, add establishing one punch session while together.** Update the `punchRung1` public-address filter tests.
3. **Unmap on quit, revoke, disable + startup cleanup.** Hook `will-quit`, `forgetRevokedPeer` paths and the punch-disable path; delete stale mappings for our own LAN IP and port before mapping. Revoke test in the style of `punchRung1Revoke.test.js`; a crash-simulation test for the cleanup.
4. **Director status flag.** A flag (not a banner) in the existing sync flag area with a plain why per status; pending state and reduced-motion equivalent per DESIGN_STANDARD sections 5 and 8; visual evidence with a distinguishing frame for each status.
5. **Egress gate + docs + hardware check.** `dgram` pattern in `internetRendezvousScan.js`, a `portMapping` row in `transportCapabilities.js` with an explicit allowlist and `signoff: null`, a planted-defect test; update `SECURITY.md` and `docs/current/**`. Hardware check on one consumer router and one phone hotspot, done in the owner's two-laptop session (not by an agent); record the result.

Full `npm run verify` on every slice that touches `electron/sync/**`; schema is untouched, so `schema:check` is not expected to apply (confirm in slice 2).
