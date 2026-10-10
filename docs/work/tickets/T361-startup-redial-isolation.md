---
ticket: T361
document_type: ticket
title: Make the startup redial real, fresh and isolated (T328 follow-up found in T359 slice 2)
status: in-progress
created: 2026-10-09
archive_when: "the startup redial dials remembered addresses in a form libp2p accepts, skips addresses past their age limit, can never break a later discovery dial for the same peer, and the gossip timestamp clamp and the removal of production loopback bypasses have shipped"
task_class: security-auth
parent: T328
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T359-router-port-mapping-rung-1.md]
---

# T361 - Startup redial: real, fresh, isolated

Follows T328 slice 1 and T359 slice 2 (which found the redial dead and, when accidentally revived, harmful).

## Root cause

`redialTrustedPeers` passed remembered `/ip4/.../p2p/<id>` strings to `transport.dial`, whose `toDialTarget` sent strings to `peerIdFromString`; that threw and was swallowed, so the redial never dialed in production. Once it did dial, a refused stale address broke the mDNS/LAN dial for the same peer because of libp2p's dial queue (`node_modules/libp2p/dist/src/connection-manager/dial-queue.js`, `dial()`): a dial whose target carries a peer id (a `/p2p/<id>` multiaddr or a bare id) is keyed by that peer id, and a later dial to the same peer id JOINS the pending job and adds its addresses to it. The discovery dial (by peer id, no addresses) therefore waited on the stale job and inherited its `ECONNREFUSED`; the joined job never did its own peer-store lookup. The failure also writes `last-dial-failure` metadata under that peer id.

Reproduced red with a real two-node libp2p test: the naive "dial the /p2p multiaddr" variant rejects the concurrent by-peer-id dial with `ECONNREFUSED`.

## Fix

- The redial validates that the `/p2p/<id>` component names the trusted peer, then dials the address WITHOUT it, so the job has no peer id: nothing can join it, and no per-peer failure metadata is written. Identity is checked on the connection (`remotePeer`), and a mismatched connection is closed. Each dial has its own `AbortSignal.timeout`. `toDialTarget` is unchanged.
- `listTrustedRememberedAddresses` drops mapped (public TCP) rows older than 7 days (the rung-1 limit) and LAN rows older than 30 days (new, `LAN_ADDRESS_MAX_AGE_MS`: DHCP-lease-scale; the dial is now isolated and cheap, so the bound only stops ancient rows being tried forever), and returns the mapped row first.
- `rememberMappedPeerAddress` rejects an entry dated beyond `MAX_FUTURE_SKEW_MS`, so a peer cannot pin its own row.
- The production `allowNonPublic` / `allowNonPublicMapped` loopback bypasses are replaced by an injected `isAddressAllowed` / `mappedAddressFilter` defaulting to the public-TCP filter.

## Not changed (found)

`punchReconnectWiring.js` `attemptLan` still calls `node.dial(r.multiaddr)` with a string and is dead for the same reason.
