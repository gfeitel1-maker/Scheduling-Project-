# SECURITY ASSESSMENT — T328 Slice 1 (persisted-peer address + direct reconnect)

Date: 2026-10-02   Assessed against commit: 0506bbba (branch claude/t328-persisted-peer-reconnect)
Authority: docs/adr/2026-10-02-wan-discovery-transport-ladder.md (accepted). Assessor: security-assessment (Opus).

## Boundary verdict

Trusted-LAN boundary: **HOLDS for Slice 1.**

Evidence. Slice 1 adds only OUTBOUND dials to peer ids that are already trusted, using addresses
observed from an already-authenticated connection (`syncNode.js` onPeerAdmitted → remoteAddrFor →
rememberPeerAddress). Remembering and redialing grant NO trust: admission is still gated entirely by
the mutualAuth/Noise handshake + token, identical to any mDNS/rendezvous-discovered dial
(`transport.js` admitPeer / authenticatedPeers; redial runs BEFORE setAuthToken, so a redialed
connection cannot even authenticate until a token exists). The inbound listener is unchanged —
production already binds `/ip4/0.0.0.0/tcp/0` (syncStarter.js:322) pre-Slice-1; Slice 1 adds no
listener and does not widen inbound exposure. Trips no capability row; installs no libp2p package.
The Tier-4 guard (transportBoundary.guard.test.js) is therefore correctly untouched — with one
caveat recorded under Re-opened tradeoffs (the guard watches capability rows, not persisted
addresses).

## Confirmed findings (ranked by leverage)

1. **Stale-address safety is simulated, not verified against real libp2p — MEDIUM.**
   Location: electron/sync/automerge/peerAddressBook.js (module comment + redialTrustedPeers);
   peerAddressBook.test.js:152-171. Attack path: a remembered `/ip4/.../p2p/<peerId>` address is
   later reassigned (DHCP churn, WAN IP reuse) to a host under an attacker's control; the node
   redials it on startup. Evidence: the ENTIRE safety argument — and the commit message's central
   claim — rests on libp2p's Noise handshake rejecting an identity mismatch because the multiaddr
   carries the `/p2p/<peerId>` component. The committed test does NOT exercise real libp2p; it
   injects a fake `dial` that rejects with a hand-written error string and asserts redialTrustedPeers
   treats it as a non-fatal failure. The test comment is honest that "a unit test cannot drive real
   libp2p Noise negotiation." Confirmed how: read the test body and the module; the property libp2p
   must provide is assumed, not pinned. Fix: add one integration-level test (real libp2p dial with a
   /p2p-pinned multiaddr answered by a different identity) OR cite the installed libp2p version's
   documented behavior per org-source-verification, recorded in the slice's done-definition. Until
   then this is a correctly-handled failure path built on an unverified premise. (Residual even if
   libp2p rejects: the outbound dial itself leaks "a Shoresh node seeks peer X" to whoever now holds
   that IP — a minor metadata exposure, LAN-only today.)

2. **Never-synced guarantee is a REAL fail-closed guard — CONFIRMED (no defect; recorded because the
   task asked whether it is boundary or convention).** Location: electron/automerge/
   hostOnlyExclusion.test.js:63-110; electron/automerge/purgeCollateral.js + purgeCollateral.test.js:
   59-68. Evidence: (a) peer_last_addresses is asserted absent from MODELED_ENTITIES, fresh-doc
   collections, DIRECT_CAMP_ENTITIES, DEFERRED_ENTITIES; (b) purgeCollateral.test asserts
   ALL_NON_MODELED_TABLES sorted EXACTLY EQUALS the schema's CREATE-TABLE set minus MODELED_ENTITIES.
   A future slice that adds peer_last_addresses to MODELED_ENTITIES (the only mechanism that syncs a
   table) fails BOTH tests; a new unbucketed table fails the equality. This is enforcement that
   FAILS, not merely agrees. Caveat (not a Slice 1 defect): both guards are table-NAME enumerations,
   so they protect this table because it is named — a future differently-named cache gets protection
   only if someone adds it to the list; the equality test is the backstop that forces that.

## Open questions (NOT findings — need investigation before confirm/drop)

- Does the installed libp2p version actually abort a dial, before stream open, when the
  Noise-verified remote peer id differs from an explicit `/p2p/<peerId>` multiaddr component? This is
  the load-bearing premise of finding 1. Settle with a real-libp2p integration test or a version-
  pinned doc citation. Everything in Slice 1's safety story depends on it.
- remoteAddrFor returns the observed remote multiaddr of an already-connected peer. In today's
  deployment that is always a LAN/private address (mDNS link-local; loopback in tests). IS there any
  path by which it can already be a WAN address? Only via the already-signed-off `discovery`
  (rendezvous) capability when SHORESH_RENDEZVOUS_URL is set. If a camp runs rendezvous, confirm
  whether a WAN address can be observed and thus persisted (see tradeoff below). Needs a check of a
  rendezvous-enabled run, not assumed.

## Re-opened tradeoffs

- **Persisted reachability vs. transient discovery (conditions have shifted under the Tier-4 guard).**
  When accepted, the Tier-4 boundary assessment (2026-09-15 / 2026-09-26 reassessment) reasoned about
  WAN reach as a per-capability, discovery-mediated event: rendezvous (signed off 2026-09-28) finds a
  peer, you connect, nothing persists. Slice 1 changes that shape: any address observed from an
  authenticated connection — including a WAN address learned via the already-allowed rendezvous
  path — is now written to peer_last_addresses and REDIALED DIRECTLY on the next startup, without
  going back through rendezvous. The trust gate does not move (good), and the capability was already
  allowed (good), but a previously-ephemeral WAN reachability becomes persistent and
  discovery-independent, and the Tier-4 guard does not see it because it inspects capability rows, not
  the address cache. Do the conditions still hold? Mostly yes for Slice 1 (LAN-only in the default
  deployment; outbound-only; Noise-gated). Recommendation: record explicitly in the ADR/Slice that
  peer_last_addresses can persist a WAN address whenever a Tier-4 discovery capability is live, and
  make that an input to the Slice 3 (DHT) re-assessment rather than discovering it then.
- **0.0.0.0 inbound bind (unchanged, restated).** Still protected only by the deployment being a LAN
  with no port-forwarding plus the admission gate. Slice 1 does not touch it; it remains the standing
  assumption the whole ladder rests on. No action for Slice 1; named so it is not treated as settled.

## Battle-test framing (which of the owner's demanded tests apply to Slice 1)

- Forged-peer writes: N/A — Slice 1 adds no merge path; the address is written only locally from
  onPeerAdmitted (post-auth). An attacker cannot remotely inject an address into another node's table.
- Join-secret brute-force on DHT / DHT poisoning / eclipse / hole-punch failure: N/A — no DHT, no
  hole-punch, no join-secret change in Slice 1 (Slices 2-4).
- Replay / stale credential: the Slice-1 ANALOG is the stale/forged remembered-address dial — this is
  the real adversarial surface. Covered by a test, but the test is simulated (finding 1).
- Rotation-on-revocation: crypto rotation is N/A (Slice 2). The Slice-1 analog — forget-on-revocation
  — IS present and tested two ways: forgetPeerAddress deletes the row on revoke (main.js revokeDevice),
  AND listTrustedRememberedAddresses re-queries deviceTrustStatus per row and excludes a revoked peer
  even if the row survived (peerAddressBook.test.js:91,133). Confirmed, defense-in-depth, genuine.

## What must be re-assessed when Slice 3 (DHT) opens

Slice 3 lets a peer be discovered at an arbitrary WAN address from the public DHT; onPeerAdmitted will
then PERSIST that WAN address, and redialTrustedPeers will dial it on startup bypassing the rotating-
tag discovery entirely. The ADR already flags (lines 216-218) that "a peer holding a cached multiaddr
could still dial, so authorization must not rest on discovery rotation alone" — peer_last_addresses IS
that cache. Re-assessment owed: confirm the merge-layer epoch/trust check (Slice 2/3) actually denies a
revoked device that is redialed from a still-trusted peer's cache, with a red-before-green proof; and
re-rank finding 1 to HIGH, because once WAN addresses are cached the stale/reassigned-IP redial lands
on the public internet rather than a LAN segment.

## Summary Score (for Grader)

Security posture: 4/5 — the boundary holds for Slice 1 and the never-synced + forget-on-revocation
guards are real and fail-closed; the one real adversarial surface (stale/forged redial) is handled but
its load-bearing libp2p-Noise premise is simulated rather than verified, which should be closed before
Slice 3 makes that redial reach the internet.
