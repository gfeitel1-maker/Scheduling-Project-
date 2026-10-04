---
ticket: T336
document_type: ticket
title: NAT hole-punch (dcutr) layered on T337's coordination foundation, opens the dcutr capability
status: open
created: 2026-10-03
archive_when: "dcutr is built test-first on T337's coordination foundation, the three T337-carry-forward blocking preconditions below are each proven on real multi-node libp2p, and the dcutr capability is signed off through the full capability+battle-test gate (AutoNAT DROPPED — see 'What it does')"
task_class: security-auth
parent: ""
governing_docs: [docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md, docs/work/specs/2026-10-03-t337-coordination-layer-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md]
related_prs: []
---

# T336 — NAT hole-punch (dcutr/AutoNAT), layered on T337's coordination foundation

## Context

The owner-decided WAN ladder (ADR `docs/adr/2026-10-02-wan-discovery-transport-ladder.md`,
Amendment + RESEQUENCE 2026-10-03) is: LAN meet [hard prerequisite] → remembered-address reconnect
+ NAT hole-punch (dcutr/AutoNAT) [PRIMARY cross-network] → Cloudflare rendezvous [RARE
firewall-only fallback]. T337 (`docs/work/specs/2026-10-03-t337-coordination-layer-design.md`)
built the camp-peer circuit-relay-v2 coordination foundation this slice needs — dcutr cannot run
cold (it upgrades an existing connection, it does not create one). This ticket is the hole-punch
slice itself: `@libp2p/dcutr` (AutoNAT dropped — see "What it does"), opening the `dcutr` row in
`electron/sync/automerge/transportCapabilities.js` (`packages: ['@libp2p/dcutr']`, `signoff: null`).
Design: `docs/work/specs/2026-10-03-t336-holepunch-build-design.md` (supersedes the slice-A doc).

## What it does

Once T337's coordination relay (R) gets two camp peers (B and C) each other's current reflexive
addresses, `dcutr`'s simultaneous-open punch (this slice) attempts a DIRECT connection between B
and C, bypassing R once it succeeds. dcutr works from the relay/identify-observed addresses it
already has; it does not depend on AutoNAT.

**AutoNAT DROPPED (organizer ruling 2026-10-03).** `@libp2p/autonat@3.0.28` has NO
admission/connectionGater hook (verified in installed source + `autoNatCampOnly` test before it was
removed), so it CANNOT be camp-scoped — a non-camp party could use our node AS an AutoNAT server,
which is a new outside-audience exposure = the owner's NO. Since `@libp2p/dcutr` does not depend on
AutoNAT, the capability ships dcutr-only: this DROPS the AutoNAT-camp-peers-only precondition as
unachievable-and-unneeded (not "passed"/"done" — explicitly removed) and ELIMINATES the AutoNAT
dial-back exposure entirely rather than camp-scoping it. Honest tradeoff: without AutoNAT
self-reachability detection, dcutr may fall back to the T337 standing relay somewhat more often in
some NAT scenarios — no capability loss, just occasional extra (already-approved, bounded) relay
use. If AutoNAT is ever revisited it is separately-scoped new work with its own exposure review and
owner decision.

## Acceptance (hard, red-before-green, real multi-node libp2p — NO mocks)

- The direct simultaneous-open punch succeeds between two camp peers once T337's coordination
  relay has exchanged their current reflexive addresses, and the relayed connection through R
  becomes an idle fallback once punched (not torn down — see T337's round-3 doc correction:
  circuit-relay-v2 reservations are standing, not disposable).
- ~~AutoNAT camp-peers-only~~ **DROPPED** — AutoNAT is not shipped (see "What it does"):
  `@libp2p/autonat@3.0.28` has no admission hook so it cannot be camp-scoped, and dcutr does not
  need it. There is no AutoNAT to prove camp-only; the exposure is eliminated by not shipping it.
- Revocation enforced at every hop of the punch handoff (the direct B↔C connection included), the
  same "admission, not discovery, is the control" invariant T337 already proves one layer earlier.

## BLOCKING preconditions carried forward from T337 (gate-fix round 4)

T337 landed (guard-blocked, `relay.signoff: null`) with three items explicitly deferred to this
ticket rather than loosely noted — the `dcutr`/`autonat` capability's gate below MUST prove all
three before `SHORESH_RELAY_ENABLED` can ever be `true` in a signed-off build. These are hard
preconditions, not optional follow-ups:

1. **Relay-specific every-hop revocation, end-to-end over the REAL merge-propagated revoke
   chain**, real multi-node: a revoke entry minted, written to `authority_cache`, merged to a
   THIRD relay node R (not the revoking device itself), R's own `tearDownRevokedConnectedPeers`
   path running, `revokePeer` firing, and the relay reservation actually being evicted as a
   result of that propagated merge — not the direct-call revoke T337 proved
   (`electron/sync/automerge/relayRevokeWhileRunning.test.js`,
   `electron/sync/automerge/relayCoordinationWindow.test.js`'s eviction test), which calls
   `revokePeer` directly rather than driving it through real merge propagation to a third node.
2. **Client-side camp-only auto-reservation**, red-before-green at enable time: T337's
   `denyInboundRelayReservation`/`denyOutboundRelayedConnection` gates prove the SERVER side (R
   only brokers for camp-admitted peers) — they say nothing about whether
   `RelayDiscovery`/`circuitRelayTransport` on the CLIENT side auto-reserves and advertises
   itself via a relay ONLY when that relay is a camp-admitted peer. Today this is
   asserted-not-tested (T337's own design assumes it falls out of the server-side gate, but the
   client's own reservation/advertisement behavior has no direct proof). This capability's gate
   must add that proof before signoff.
3. **UI surfacing of `RESERVATION_REFUSED`**: `relayRefreshNoGrowth.test.js` proves the real
   `maxReservations` cap (8) refuses an (N+1)th distinct camp peer's RESERVE once the relay is
   full. A camp with more than 8 devices simultaneously needing relay coordination would hit this
   refusal with no surfaced signal today — violates the spirit of "Surface Every Write Failure."
   This capability's gate must wire a surfaced signal (director-visible, not a silent log line)
   before signoff.

A Security or Grader FAIL on any acceptance item above (including these three carried-forward
preconditions) stops the loop and returns to the owner via the organizer. Only after a clean pass
on all of them does `dcutr.signoff` get written.
