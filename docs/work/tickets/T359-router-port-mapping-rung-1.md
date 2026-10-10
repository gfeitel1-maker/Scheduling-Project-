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
- `transport.dial` still treats every string as a peer id (the `toDialTarget` change was reverted in round 2, see below); rung 1 passes a `Multiaddr` object to the injected `dial`, as `hostHandoffWire` and the other direct-dial callers already do. Pinned by the real two-node test in `mappedDialRung1.test.js`.
- Rung 1 dials the mapped address first through the injected `dial`; a failed or mismatched dial falls through to the UDP punch. Trust is checked before the dial and again after it (with `isPeerRevoked`).

## Slice 2 round 2: CI red root cause (2026-10-09)

CI run 38005929497 (attempt 1 and its re-run, both red) failed `hostHandoffWire.test.js` "moves hosting from H to S ..." at the final `waitFor` (C never receives H's write). It was NOT a flake: it failed 5 of 5 locally with slice 2 and passed 3 of 3 on `4960700c`.

- Bisect by file: reverting only `transport.js` to `4960700c` made it pass; reverting the `toDialTarget` branch while keeping the new import also passed. The other slice-2 files made no difference.
- Mechanism: `syncNode.js` calls `redialTrustedPeers(db, { dial: transport.dial })` at startup (T328 slice 1). It passes remembered `/ip4/...` strings, which `toDialTarget` sent to `peerIdFromString` and threw, so that startup redial has never dialed anything since T328 (the error was swallowed and logged). Making `toDialTarget` parse them made the redial live. On relaunch the device dials its peers' previous-process ports, which are refused; the later mDNS-triggered dials by peer id (multiaddrCount 0) then fail with `DIAL_FAILED refused` instead of `AUTH_OK`, and C is left connected but never synced (`activities` count 0).
- With `redialTrustedPeers` forced to reject, the test passes (3 of 3) on slice-2 code, which isolates the redial as the trigger. The libp2p side (a failed dial recording `LAST_DIAL_FAILURE_KEY` / stale addresses affecting the by-peer-id dial) is the likely detail; not pinned further.
- Fix: revert the `toDialTarget` change so slice 2 does not change startup behaviour; `attemptMappedDial` wraps the address in `multiaddr()`. `reconnectCoordinator.test.js` now asserts the dialed address by its string form.
- Found, out of scope, needs its own ticket: the T328 startup redial is dead code in production, and turning it on as-is breaks post-restart reconnect on stale addresses. Whoever makes it real must make a stale remembered address harmless to later discovery dials.

## Slice 3 notes: LAN redial identity (T361 follow-ups)

- `attemptLan` (`punchReconnectWiring.js`, now `createAttemptLan`) was dead for the reason T361 fixed in `redialTrustedPeers`: it dialed a `/p2p/` string, which `transport.dial` treats as a peer id. It now dials the multiaddr object with the `/p2p` component dropped (`redialTarget`), 5s abort per dial, failures isolated, identity checked on the resulting connection. Pinned by a real two-node connect (`lanRedialIdentity.test.js`).
- `dialAndVerify` (`peerAddressBook.js`) is the one shared dial-and-verify used by both paths. A connection to anyone other than the expected peer, or with no `remotePeer`, is never a success, and is closed only when its `timeline.open` is not earlier than the moment this dial started (a missing timeline counts as opened by this dial), so an existing connection to another trusted peer is not torn down.
- The 30 day LAN age limit is skip-only: a stale row is not dialed and is not deleted. Pinned by the 31-day-row-survives test.
