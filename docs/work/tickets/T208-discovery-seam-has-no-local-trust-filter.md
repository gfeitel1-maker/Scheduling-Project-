---
title: "The discovery-to-auth seam sends this device's session token to any discovered peer"
document_type: ticket
status: completed
created: 2026-09-17
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
archive_when: "A peer id that is not a locally-trusted device is never sent an authenticate frame, proven by a test that plants an untrusted peer id, and a hung dial no longer suppresses the real peer's rediscovery"
---

# T208 — The discovery seam has no local-trust filter

## Problem

`electron/sync/automerge/mutualAuth.js`'s `tryAuthenticate` gates only on an in-memory
`attempted` Set and on this device holding a token. It then sends
`{ type: 'authenticate', token, device_id }` to **any** peer surfaced by `onPeerDiscovery`.
Nothing checks that the peer id is a known, trusted device.

On the LAN this is bounded by mDNS link-local multicast, which is why it has been acceptable. The
moment a second discovery mechanism exists that anyone on the internet can write into, the bound is
gone: whoever can publish a record becomes a peer this node dials and hands a credential to. The
external spec's invariant — "a Cloudflare response never establishes trust" — is **not enforced by
any code today**; it would have to be built. Independently confirmed by reading the file.

Second, related defect in the same function: `attempted.add(peerId)` happens before any outcome
and is cleared on dial failure or explicit rejection but **not on a hang**. A record published for
a trusted peer id (peer ids are not secret) pointing at an endpoint that accepts and never replies
suppresses that peer's later, legitimate discovery. No trust is established; reconnection is simply
defeated by an unauthenticated actor.

## 0. What shipped 2026-09-17, and what did not

**Shipped.** `wireMutualAuth` now takes a REQUIRED `isPeerTrusted(peerId)` predicate and throws at
wire time without one — no permissive default and no deny default, because the first silently
reopens the hole and the second turns a wiring mistake into total silent sync failure. Trust is
re-checked on every discovery (never cached, so a revocation takes effect at the next announce), a
predicate that throws counts as untrusted, and a hung attempt no longer pins the `attempted` dedupe
slot. `startSyncNode` accepts `isPeerTrusted` and defaults to an explicitly named, separately tested
`lanTopologyTrust`.

_Prior (superseded 2026-09-18, T208 round 2): the paragraph below asserted the LAN case
"cannot be closed on this tree" because `transport.js` passed no `privateKey` to
`createLibp2p`. That premise stopped being true the same day it was written — T162 landed
(also 2026-09-17) and `syncNode.js` now loads a persisted per-device identity via
`ensureDeviceIdentity` and passes it to `startTransport` as `privateKey` BEFORE dialing
anyone, so a device's libp2p PeerId is stable across restarts. See what actually shipped
below instead._

~~**NOT shipped — escalated.** The LAN case the ticket was written for is **not** closed, and cannot
be on this tree. `transport.js` passes no `privateKey` to `createLibp2p`, so libp2p mints a fresh
keypair — and therefore a fresh PeerId — on every process start (`peerIdentity.js`'s own header says
so, and it records the column only *after* a successful authenticate). A trust check keyed on
`devices.libp2p_peer_id` would reject every legitimate device after any restart, in both directions,
and stop sync entirely. So today's control on the LAN remains topology — mDNS link-local multicast
on a camp-scoped tag — exactly as before.~~

~~**What this bought:** a second discovery mechanism can no longer be wired in without its caller
supplying a real predicate. Rendezvous (T211) cannot inherit `lanTopologyTrust`.~~

~~**What closes the rest: T162 — approved and implemented the same day (2026-09-17).** Persistent
per-device libp2p identity plus token-to-peer binding. With peer ids now stable across restarts and
a token bound to the peer presenting it, the objection that forced `lanTopologyTrust` to be
permissive no longer holds. Two things follow, and neither is done yet:~~

~~1. `lanTopologyTrust` can and should be replaced by a real check against `devices.libp2p_peer_id`.
   That is a follow-on, deliberately not bundled into the T162 change so the identity work could be
   gated on its own.~~
~~2. Even before that, the *severity* of the LAN residual drops sharply: a token handed to a stranger
   is now rejected at admission with `peer_identity_mismatch` unless that stranger is the bound
   peer. The leak is narrowed from "usable credential" to "useless credential".~~

**What actually shipped (2026-09-18).** `lanTopologyTrust` is gone. `createBoundPeerTrust(db)`
(`electron/sync/automerge/peerIdentity.js`) is now `startSyncNode`'s default `isPeerTrusted`: it
resolves a discovered peer id to the `devices` row it is bound to (`bindOrVerifyPeerIdentity`'s
TOFU bind, run on the admission path) and admits it only when `deviceTrustStatus` reports that row
`authorized` and not `revoked`, re-querying fresh on every discovery. T162's persisted identity was
exactly the precondition this needed — before it, a restart minted a fresh PeerId and a bound-peer
check would have rejected every legitimate device after any restart, which is why the ticket
originally called this unreachable. It is no longer unreachable; it is what ships.

**Round 2 correction (Red Hat, 2026-09-18):** the seam's own header comment claimed client-to-client
sync was safe from regression because "a client has no `devices` row for another client." That is
false — `connectionAuth.js`'s `evaluateAuthenticate` self-registers a `pairing_status: 'pending'`
row for ANY device id presenting a valid session token. The comment has been corrected in
`electron/sync/automerge/syncNode.js`: the actual reason is that a self-registered row has
`authorized_at` unset, so `createBoundPeerTrust` denies it, and the gate is symmetric on both
clients, so in practice neither ever gets far enough to dial the other. The conclusion (no
regression) was right; the stated mechanism was not.

**Round 2 correction, revocation (Red Hat, 2026-09-18):** this doc and the code comments previously
attributed live revocation enforcement to "the predicate re-queries on every announce." That is not
what enforces it for an already-authenticated peer: `mutualAuth.js`'s `attempted` Set is never
cleared on success, so the re-query never runs again for a peer already dialed. What actually tears
down a live, revoked peer's session is `electron/main.js` calling `getAutomergeNode()?.revokePeer(peerId)`,
which removes it from `transport.js`'s `authenticatedPeers` — the set `broadcastDoc` gates every
send on. The re-query only ever gated a peer not yet dialed (new since last process start, or not
yet attempted). See the corrected comments in `mutualAuth.js`, `peerIdentity.js`, and `transport.js`,
and the regression test at `electron/sync/automerge/transport.test.js` ("revokePeer stops
broadcastDoc from reaching a previously-authenticated peer").

## Success predicate

- An authenticate frame is sent only to a peer id already present in local trust state.
- A test plants an untrusted peer id at the discovery callback and asserts no token leaves.
- A hung authenticate attempt cannot permanently suppress rediscovery of the same peer id
  (bounded attempt, or clearance on timeout).
- LAN behaviour is unchanged: existing mDNS pairing and sync tests stay green.

## Does NOT count as done

- Filtering only in a future rendezvous module. The filter belongs at the seam every discovery
  mechanism feeds, or the next mechanism reintroduces the hole.
- Asserting the fix by reading the code. Plant the defect.

## Note

Whether the session token is additionally replayable once received is a separate claim, raised as
R2 in `docs/work/security/2026-09-17-rendezvous-wan-assessment.md`. This ticket closes the
*sending* of it; the binding question is tracked there and overlaps T162.
