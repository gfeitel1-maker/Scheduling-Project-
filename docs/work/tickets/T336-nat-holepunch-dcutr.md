---
ticket: T336
document_type: ticket
title: NAT hole-punch (dcutr/AutoNAT) layered on T337's coordination foundation, opens the dcutr/autonat capability
status: open
created: 2026-10-03
archive_when: "dcutr/AutoNAT are built test-first on T337's coordination foundation, AutoNAT is proven camp-peers-only (red-before-green, a reachable non-camp peer is never usable as an AutoNAT server), the three T337-carry-forward blocking preconditions below are each proven on real multi-node libp2p, and the dcutr/autonat capability is signed off through the full capability+battle-test gate"
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
slice itself: `@libp2p/dcutr` + `@libp2p/autonat`, opening the `dcutr` row in
`electron/sync/automerge/transportCapabilities.js` (currently `packages: ['@libp2p/dcutr',
'@libp2p/autonat']`, `signoff: null`). Design: `docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md`.

## What it does

Once T337's coordination relay (R) gets two camp peers (B and C) each other's current reflexive
addresses, `dcutr`'s simultaneous-open punch (this slice) attempts a DIRECT connection between B
and C, bypassing R once it succeeds. AutoNAT (this slice) is the reachability-probe service each
device runs to learn its own reflexive address in the first place — restricted to camp-admitted
peers only (never a shared/public AutoNAT default), per the design's §C hard requirement.

## Acceptance (hard, red-before-green, real multi-node libp2p — NO mocks)

- The direct simultaneous-open punch succeeds between two camp peers once T337's coordination
  relay has exchanged their current reflexive addresses, and the relayed connection through R
  becomes an idle fallback once punched (not torn down — see T337's round-3 doc correction:
  circuit-relay-v2 reservations are standing, not disposable).
- AutoNAT camp-peers-only — hard, blocking, per the T337 design's §C requirement restated for this
  capability: 3 real libp2p nodes (A / camp-admitted B / reachable-but-non-camp X). Red-before-
  green: BEFORE the camp-scoping restriction is implemented, demonstrate A is willing to use X as
  an AutoNAT server (the hazard exists and the test catches it); AFTER, A never dials X for AutoNAT
  purposes and only ever uses B or another camp-admitted peer.
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

A Security or Grader FAIL on any of the four acceptance items above (including these three
carried-forward preconditions) stops the loop and returns to the owner via the organizer. Only
after a clean pass on all of them does `dcutr.signoff` get written.
