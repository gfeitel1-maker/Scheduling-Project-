---
ticket: T359
document_type: ticket
title: Router port mapping on rung 1 (map the libp2p TCP listener via UPnP-IGD / NAT-PMP, no STUN), five PRs, inert behind SHORESH_PUNCH_ENABLED
status: open
created: 2026-10-09
archive_when: "the libp2p TCP listener is pinned and mapped through the router with no third party, the router-reported public address reaches a roaming peer's remembered addresses and is dialled first in rung 1, the mapping is removed on quit, revoke and disable and stale mappings are cleaned at startup, the director sees a plain status flag, the new LAN egress has a gate entry and test, and the owner's two-laptop session has recorded one consumer router and one phone hotspot; nothing activates without SHORESH_PUNCH_ENABLED"
task_class: security-auth
parent: T347
governing_docs: [docs/adr/2026-10-09-router-port-mapping-on-rung-1.md, docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/work/specs/2026-10-09-router-port-mapping-feasibility.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T358-s4c-reconnect-coordinator.md]
---

# T359 - Router port mapping on rung 1

Success predicate: with STUN unset and the rendezvous unreachable, a laptop at a new spot dials the office laptop's remembered router-mapped TCP address and syncs; when the office router refuses, the director sees why, and the ladder falls to rungs 2 and 3; after quit or revoke the router table shows no entry.

Non-goals: CGNAT or double-NAT offices (detected and reported only), PCP, STUN of any kind, mapping the punch UDP port, any change to the trust model, both devices at never-seen spots.

**Revised 2026-10-09** after Red Hat FAILED the UDP-port design: the mechanism is now mapping the libp2p TCP listener; see `docs/adr/2026-10-09-router-port-mapping-on-rung-1.md` (Revision note). Slices below are the revised set.

Library: `@achingbrain/nat-port-mapper` directly. Not `@libp2p/upnp-nat`. Each slice is its own PR, test-first, `npm run check:governance` before every push.

## Slices

1. **Pinned TCP listen port + mapper module with status.** Pin the libp2p TCP listener (`syncStarter.js` `listenAddrs`, today `/ip4/0.0.0.0/tcp/0`) to a persisted per-device port stored like `punch_identity.local_port` (the slice decides where; a schema column triggers the migration, `vNN_down.js` and `npm run schema:check`); on bind conflict fall back to an ephemeral port and report `port-in-use`. `electron/sync/automerge/portMapping.js` (collaborators injected, fake gateway in tests): discover UPnP then NAT-PMP, double-NAT check (private or 100.64/10), map the TCP port using the router-reported external IP and the RETURNED external port, 1 h lease with auto-refresh, unmap. Returns `mapped | permanent-lease | refused | no-gateway | double-nat | port-in-use | error` plus external IP and port. Never throws. Rejects SSDP `LOCATION` URLs off the gateway subnet; XML size cap and timeouts. Adds the dependency (resolve the version from the lockfile; under Node 22 on Intel macOS). No dialling yet.
2. **Mapped address into remembered addresses, dialled first in rung 1, pinned no-STUN test.** Publish `/ip4/<ext>/tcp/<port>` first in this device's gossip entry (check the gossip candidate validator accepts `/tcp/` multiaddrs); while connected, write a peer's verified mapped TCP address into `peer_last_addresses` as `.../p2p/<peerId>` via a new `peerAddressBook.js` function (public-filtered; ensure the 5-row recency prune cannot evict it); rung 1 dials that address first, before the UDP punch attempt, with a 7 day age limit. Pinned test: the production start path passes no `iceServers`. Test with a real two-node libp2p dial, Noise/`authGate`/`isPeerRevoked` unchanged.
3. **Unmap on quit, revoke, disable, network change + startup cleanup.** Hook `will-quit`, `forgetRevokedPeer` paths and the punch-disable path; on network or gateway change unmap from the old gateway if still reachable before mapping on the new; delete stale mappings for our own LAN IP and port before mapping at startup. Revoke test in the style of `punchRung1Revoke.test.js`; a crash-simulation test for the cleanup. Residual to state in docs: lease-0 routers keep a stale mapping if the old gateway is unreachable.
4. **Director status flag.** A flag (not a banner) in the existing sync flag area with a plain why per status (`mapped | permanent-lease | refused | no-gateway | double-nat | port-in-use | error`); pending state and reduced-motion equivalent per DESIGN_STANDARD sections 5 and 8; visual evidence with a distinguishing frame for each status.
5. **Egress gate + docs + hardware check.** `dgram` pattern in `internetRendezvousScan.js`, a `portMapping` row in `transportCapabilities.js` with an explicit allowlist (SSDP multicast, HTTP to the gateway, NAT-PMP UDP 5351) and `signoff: null`, a planted-defect test; update `SECURITY.md` (the exposure: TCP port open to the internet, TCP accept, Noise, `authGate`, T340 bounds, scanners expected) and `docs/current/**`. Hardware check on one consumer router and one phone hotspot, done in the owner's two-laptop session (not by an agent); record the result.

Full `npm run verify` on every slice that touches `electron/sync/**`; slice 1 may add a column for the pinned TCP port; if so `npm run schema:check` applies to that PR.
