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
2. **Mapped address into remembered addresses, dialled first in rung 1, pinned no-STUN test.** Publish `/ip4/<ext>/tcp/<port>` first in this device's gossip entry (extend the UDP-only `CANDIDATE_RE` in `punchGossip.js` to `/tcp/`; old readers drop the whole entry, acceptable pre-production); while connected, write a peer's verified mapped TCP address into `peer_last_addresses` as `.../p2p/<peerId>` via a new `peerAddressBook.js` function (public-filtered; the table has only `peer_id, multiaddr, last_seen_at`, so **a schema change (source/kind marker) may be needed** for the age rule and prune protection; the protection must not let a peer republishing changed ports churn or evict its own good row); rung 1 dials that address first, before the UDP punch attempt, with a 7 day age limit applied on the rung-1 dial path, not `redialTrustedPeers`' startup redial. Tests: planted private, loopback and 100.64/10 gossip addresses are rejected at the `peer_last_addresses` write. Pinned test: the production start path passes no `iceServers`. Test with a real two-node libp2p dial, Noise/`authGate`/`isPeerRevoked` unchanged.
3. **Unmap on quit, revoke, disable, network change + startup cleanup.** Hook `will-quit`, `forgetRevokedPeer` paths and the punch-disable path; on network or gateway change unmap from the old gateway if still reachable before mapping on the new; delete stale mappings for our own LAN IP and port before mapping at startup. Revoke test in the style of `punchRung1Revoke.test.js`; a crash-simulation test for the cleanup. Residual to state in docs: lease-0 routers keep a stale mapping if the old gateway is unreachable, and after a DHCP reassignment that stale mapping can forward the public port to a DIFFERENT host's LAN address.
4. **Director status flag.** A flag (not a banner) in the existing sync flag area with a plain why per status (`mapped | permanent-lease | refused | no-gateway | double-nat | port-in-use | error`); pending state and reduced-motion equivalent per DESIGN_STANDARD sections 5 and 8; visual evidence with a distinguishing frame for each status.
5. **Egress gate + docs + hardware check.** `dgram` pattern in `internetRendezvousScan.js`, a `portMapping` row in `transportCapabilities.js` with an explicit allowlist (SSDP multicast, HTTP to the gateway, NAT-PMP UDP 5351) and `signoff: null`, a planted-defect test; a limiter test: hold 16 public-source pending connections and assert the outcome of a legitimate dial (scanner DoS on the reconnect path, LAN exempt); update `SECURITY.md` (the exposure: TCP port open to the internet, TCP accept, Noise, `authGate`, T340 bounds, scanners expected) and `docs/current/**`. Hardware check on one consumer router and one phone hotspot, done in the owner's two-laptop session (not by an agent); record the result.

Full `npm run verify` on every slice that touches `electron/sync/**`; slice 1 may add a column for the pinned TCP port; if so `npm run schema:check` applies to that PR.

## Slice 1 notes (2026-10-09, round 2)

- `createPortMapper` takes an injected `grantStore` that remembers the external port the router actually granted. `cleanupStale()` deletes both the local-port mapping and the remembered one, so a crash cannot leave a mapping behind when the router granted a different port. Covers permanent leases too, per the keeper's lease ruling. Slice 3 wires a device-local file store into the production lifecycle; in slice 1 nothing in production imports the mapper.
- SSDP descriptor fetches no longer follow redirects (`redirect: 'manual'`).
- Honest limit: `@achingbrain/nat-port-mapper` speaks IGD:2 only, so in production a lease-0-only (IGDv1) router cannot currently produce `permanent-lease`; the path is exercised against the fake gateway only. The owner's hardware check will show whether IGDv1 routers matter.
- The pinned-port test now occupies a deterministic in-range port (49152-65535). It was shown red with the bind-conflict check disabled.

## Slice 2 notes (2026-10-09)

- No schema change. A router-mapped row is identified by its shape (a public TCP address), written only by `rememberMappedPeerAddress` from a connected peer's verified gossip entry, at most one per peer, replaced only by a strictly newer signed entry (its `last_seen_at` is the entry's own timestamp, which is what the 7 day rung-1 age limit reads). `rememberPeerAddress` no longer stores a public TCP address (an inbound connection's ephemeral source port is not a listener) and its LAN prune does not rank the mapped row, so neither can displace it.
- Old readers drop a whole gossip entry that contains a TCP candidate (their `CANDIDATE_RE` is UDP-only). Accepted pre-production.
- Nothing in production supplies the mapped address until slice 3 (`getMappedAddress` defaults to null), so publishing is wired but inert; the address is never exposed to the renderer or IPC.
- Found while testing: `transport.dial` treated every string as a peer id, so a stored multiaddr string (`redialTrustedPeers`, rung 2) could never dial. `toDialTarget` now parses a leading-`/` string as a multiaddr; pinned by the real two-node test in `mappedDialRung1.test.js`.
- Rung 1 dials the mapped address first through the injected `dial`; a failed or mismatched dial falls through to the UDP punch. Trust is checked before the dial and again after it (with `isPeerRevoked`).
