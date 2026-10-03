---
title: "T337 — Coordination layer design (camp-peer circuit-relay, foundation-first)"
document_type: spec
authority: proposed
status: draft
created: 2026-10-03
archive_when: "the relay capability's capped-coordination signoff lands or this design is superseded by a revised design doc"
task_class: security-auth
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md, electron/sync/automerge/transportCapabilities.js, electron/sync/automerge/peerAddressBook.js, electron/sync/automerge/rotatingDiscoveryTag.js, electron/automerge/authorityReplay.js, docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md]
---

# T337 — Coordination layer design (camp-peer circuit-relay, foundation-first)

**Design-only. Opens and builds nothing.** Produced per the organizer's (owner-delegated) ruling:
libp2p `dcutr` cannot run cold — it upgrades an *existing* connection, it does not create one — so
the coordination layer that gets two peers' reflexive addresses in front of each other is the
**foundation** T336's hole-punch design (`docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md`)
turns out to need as a prerequisite, not an optional add-on. This doc is T337; T336 is the hole-punch
slice that layers on top of it, resequenced (see note appended to that doc).

**Ruled, not reopened:** the coordination mechanism is a publicly-reachable **camp peer** acting as a
`@libp2p/circuit-relay-v2` relay in **coordination/signaling mode only**, restricted to camp-admitted
peers. Cloudflare rendezvous (Slice B / T334's demoted tier 3) is the fallback used only when no camp
peer is reachable. This design states how that ruled mechanism works concretely; it does not weigh it
against alternatives.

## Candidate approaches considered (divergent pass)

Five parallel frames (3am-on-call, logistics, remove-load-bearing-assumption, competitor/attacker,
ant-colony) were run before converging, with the explicit guardrail that the mechanism itself is
already ruled by the organizer. The frames did not surface a competing mechanism worth presenting as
a live alternative — none challenged "a camp peer in signaling mode" as the foundation — but they
did converge on refinements *within* that ruled shape, folded into the Approach below:

- **Rotating/elected coordinator, not a fixed one** (3am-on-call, 2 hits): no single camp device is
  permanently load-bearing as the coordination point; whichever camp-admitted peer currently has a
  reachable address serves, and that can change device-to-device and day-to-day. Converged into §A's
  eligibility rule — this was already implicit in "a camp peer" but the frame made explicit that it
  must not harden into a de-facto permanent host, which would silently recreate the single-point-of-
  failure/centralization shape the owner has repeatedly rejected elsewhere in this program.
- _Prior: **Disposable, one-shot coordination, never persisted** (3am-on-call + logistics, 3 hits —
  "cross-dock handoff," "dead-man's-switch failover," "ad hoc relay that forgets it ever
  happened"): reinforces the ADR's existing ~128 KiB/2 min coordination cap — the relay role is
  transient per rendezvous attempt, not a standing service. Folded into §A/§B._ **Correction
  (gate-fix round 3, Red Hat MEDIUM): this converged belief is FALSE against the actually-
  installed `@libp2p/circuit-relay-v2@4.2.13`.** The client transport auto-REFRESHES its
  reservation roughly every 30s for as long as it stays connected to R
  (`transport/reservation-store.js`'s refresh timer: with a 120000ms TTL, `max(120000 − 300000,
  30000) = 30000`), and the server's own `reserve()` resets the TTL on each refresh while
  bypassing `maxReservations` for an EXISTING reservation (`server/reservation-store.js`). A
  reservation is therefore a STANDING, perpetually-renewed camp-internal relay slot while the
  client is online — not a one-shot, disposable, per-attempt thing. See §B/§E below for the
  corrected description; whether a standing-but-bounded reservation of this shape is acceptable
  under the owner's "no standing relay" line is a separate, still-pending owner decision — this
  note only fixes what the mechanism actually does.
- **CRDT-piggybacked presence as a complement, not a replacement** (logistics' "consignment
  inventory"/"kanban pull signal" + the 3am-on-call "Automerge-document-as-rendezvous-channel" idea,
  independently hit by two frames): worth recording as an open question (§G) precisely because it has
  a bootstrap dependency — the document can only carry a fresh address if *some* transport already
  synced it, which is the same cold-start problem the coordination relay exists to solve. It does not
  displace the ruled mechanism; it is a candidate future complement for the case where any sync path
  (even a stale/slow one) is already live.
- **Rejected as out of scope here**: ant-colony's various "no central coordinator at all, pure
  gossip/emergent" framings are a genuinely different architecture (no distinguished coordination
  role, ever) — interesting, but it is not a refinement of the ruled mechanism, it is a different
  mechanism, and the organizer's guardrail is explicit that this pass converges on the ruled one, not
  on competing designs. Noted, not built. Competitor/attacker's "exploit the coordinator going
  offline" hits converged into §A's eligibility/rotation language and §D's revocation requirements
  rather than becoming a separate idea.

## A. Mechanism

**The problem stated precisely.** Two camp-admitted peers, B and C, each already hold the other's
`peer_id` and a possibly-stale `(peer_id, multiaddr)` row in `peer_last_addresses`
(`electron/sync/automerge/peerAddressBook.js`). `redialTrustedPeers` tries the cached address first,
always, for free. When that fails — both ends moved networks since last contact — B and C have no
live channel to exchange *current* reflexive addresses, and `dcutr` cannot help them get one, because
`dcutr` only upgrades a connection that already exists (T336 §1). The coordination layer is what
supplies that first live channel.

**Finding a reachable camp peer.** Every device in a camp already holds, from ordinary sync
membership, the camp's device roster (`devices` table, peer ids) and — via `peer_last_addresses` —
its own most-recently-observed address for every other camp peer it has directly connected to at any
point (not only B/C's addresses of each other; A, D, E, every camp device's addresses, to the extent
each has previously connected to each). A coordination attempt therefore works like this:

1. B (trying to reach C) consults its own `peer_last_addresses` for *any* camp peer other than C that
   it has a plausibly-current address for, ranked by `last_seen_at` (most-recently-observed first —
   reuses the existing ordering `redialTrustedPeers` already applies, no new ranking logic).
2. B attempts a direct dial to that candidate peer (call it R) using the existing stale-address-safe
   dial (`peerAddressBook.js`'s Noise-pinned multiaddr dial). If R answers and passes the ordinary
   Noise mutual-auth handshake, B now has a live connection to *some* camp peer.
3. B asks R (now connected, admitted, and itself a camp peer) to act as a `circuit-relay-v2`
   coordination point: R relays a signaling exchange between B and C **only if R also already has (or
   can establish) a live connection to C** — R attempts its own address-book dial to C the same way.
   If R cannot reach C either, B tries the next-best candidate in its own address book, then (if none
   of the camp's devices B knows an address for can reach C) the attempt falls through to the
   Cloudflare rendezvous fallback named in §A's last paragraph.
4. Through R, B and C exchange their *current* reflexive/observed addresses (the same payload dcutr's
   coordination mode needs, per T336 §1 step 2 — "two peers already connected over *some* path
   exchange their observed addresses over that existing connection"). Once both sides have each
   other's current address, `dcutr`'s simultaneous-open punch (T336) runs between B and C directly;
   R's job is done.

**What makes a device eligible/reachable as R.** No special role, no designated "coordinator" device,
no configuration flag — any camp-admitted device that happens to be reachable at the moment another
camp peer needs it is eligible, by the plain fact that it answers a dial. In practice this favors
devices with a stable public-facing address or port-forward (e.g. a camp office desktop left on, a
device on a network whose NAT happens to still match its last-observed mapping), but Shoresh does not
designate one — it is discovered empirically, per attempt, the same way `redialTrustedPeers` already
discovers which cached addresses still work. This is deliberate: a fixed "the office computer is
always the relay" convention would recreate a single point of failure and a de-facto standing service,
which is the shape this design avoids (the divergence pass's "rotating, not fixed" finding, above).
Nothing is persisted about which device served as R for a given attempt beyond the ordinary connection
log already produced by any dial.

**Restricting the relay to camp-admitted peers only.** This falls out of the mechanism rather than
needing separate enforcement: R only relays for peers it can itself authenticate. B's connection to R
and R's connection to C both go through the ordinary Noise mutual-auth handshake and then
`syncNode.js`'s `authorize()`/`isPeerRevoked` check (T331 admission gates), **exactly as every other
connection does** — R never relays for an unauthenticated or revoked peer because it never establishes
a connection to one in the first place. There is no separate "camp-membership check" for the relay
role to get right or get wrong; it inherits T331's existing admission gate by construction. This is
the same "admission, not discovery, is the control" invariant T336 states for hole-punch, applied one
layer earlier.

**How the brief exchange drops out — corrected (gate-fix round 3).** Each individual relayed
*stream* over the `circuit-relay-v2` hop is still capped per the ADR (~128 KiB / ~2 min per
stream, unchanged by this design). But the underlying *reservation* that makes R reachable for B
at all is NOT torn down once dcutr's simultaneous-open punch succeeds between B and C directly
(T336 §1 step 3) — the reservation is a standing, auto-renewed slot (see the correction note
above) that persists for as long as B's `circuitRelayTransport` stays connected to R, independent
of whether any particular coordination attempt succeeded, failed, or was ever made. What DOES
change once dcutr succeeds is which path carries TRAFFIC: the direct B↔C connection becomes
primary, and R's relayed path for that pair goes idle — present as a fallback route, not
exercised unless the direct path later breaks. The reservation itself is the standing, bounded
reachability primitive this mechanism maintains; the DATA that flows through R per attempt is
what's capped and short-lived. On punch failure, no relayed connection to C was ever carrying
data to begin with (that is the data-path relay Slice B's own capped mechanism, separately
gated) — this coordination layer's reservation existing is not the same thing as this
coordination layer's reservation being USED as a data path.

**When no camp peer is reachable at all.** If B's address book contains no camp peer it can currently
reach (or none it can reach that can also reach C), the coordination attempt exhausts its candidates
and the connection attempt falls through to the Cloudflare rendezvous fallback — the boundary named in
the ADR's tier 3 ("a weird firewall throws a barrier we can't work around") and in T336's own framing
of Slice B. **This design does not build or deploy that fallback** — it only names the handoff point
(the same `redialTrustedPeers`-exhausted / "no coordination candidate succeeded" signal that currently
has nowhere to go) so a future slice can wire it in. No Cloudflare Worker deploy is pulled forward by
this design (T209 stays untouched, owner-spend, as the ADR already reserves).

## B. Exposure/cost

**No public-presence broadcast — confirmed explicitly.** Nothing in this mechanism publishes "this
device is online at this address" to any population outside the camp's own admitted peer set. R
learns B's and C's current reflexive addresses only because B and C are devices R has itself
authenticated via the ordinary Noise handshake and T331 admission gate — the same information R would
learn the instant it directly connects to either of them by any other transport. No peer outside the
camp's `devices` roster is ever a candidate for R; there is no lookup against a public/unbounded
population anywhere in this mechanism (contrast the rejected public-DHT `provide`/`findProviders`,
which is reachable by an unbounded population of strangers — this mechanism has no equivalent
publish-to-everyone step at all). This is the same confirmation T336 §2 makes for AutoNAT/dcutr,
extended to the coordination relay that supplies dcutr's first contact.

**What R, the relay-node device, learns.** R learns that B and C are each online, their current
reflexive addresses, and that they are attempting to reconnect to each other — all three facts R
already has standing to learn, since R is by construction an authenticated fellow camp member of both.
R does not learn anything about B or C that a direct connection between R and either of them wouldn't
already reveal; the coordination role adds no new category of exposure, only a slightly earlier/more
frequent occasion to learn facts R is already camp-entitled to.

**Cost — corrected (gate-fix round 3).** Relay-node load on R is NOT a one-shot, torn-down-after-
the-attempt cost. R holds a STANDING reservation per connected camp peer that has asked to be
reachable through it — auto-refreshed roughly every 30s by the client side, for as long as that
peer stays connected to R — plus whatever short-lived `circuit-relay-v2` STREAMS get opened
through that reservation, each individually capped at ~128 KiB / ~2 min per the existing ADR cap.
R's own normal sync/connectivity work is otherwise unaffected, and the per-stream cap bounds any
single relayed exchange's cost, but the RESERVATION itself is not bounded in duration by this
design — it lives as long as the connection does. Setup overhead for B: one extra address-book
dial (to R) before the dcutr exchange can begin, plus R's own dial to C if R didn't already have a
live connection to C — worst case two sequential dial attempts beyond what T336's remembered-address
redial alone would need, each bounded by the same hard-deadline dial timer T336 §2 already requires
("every dial gets a hard deadline timer owned by the caller"). If B's address book holds several
candidate R's, trying them is best-effort/sequential (or capped-parallel), logged-never-thrown, the
same pattern `redialTrustedPeers` already uses — this design does not introduce a new retry
philosophy, it reuses the existing one.

**Gate-fix round 3 correction (Red Hat MEDIUM — the round-2 addendum below was itself still
wrong, make the claim true this time).** The round-2 addendum (preserved below for the record)
described the fix as making reservations "disposable" on a short TTL. That is not what the code
does, and cannot be made to do that without disabling the library's own refresh behavior entirely
(which this design does not propose). What the implementation actually provides, honestly stated:
a **standing, BOUNDED, camp-internal relay reservation** — bounded by (a) camp-admitted-only
eligibility (§A's "falls out of the mechanism" argument, unchanged), (b) a per-stream data/time
cap (~128 KiB / ~2 min per relayed exchange, unchanged by this round), and (c) a cap of 8
simultaneous NEW reservations R will grant (`maxReservations`, `syncStarter.js`) — not bounded in
how long an EXISTING reservation may be renewed, which the library does automatically and which
this design does not override. With T336's dcutr present, the direct connection is primary once
punched and the standing reservation becomes an idle fallback — traffic crosses R only when the
direct path is unavailable. In the T337-alone case (dcutr absent), nothing prevents the relay from
being the ONLY path for as long as the client stays connected — this is exactly the "relay as
primary data path" risk the enablement gate (relayEnablement.js, §E below) exists to prevent by
withholding relay activation until dcutr exists in the build. `transport.js`'s `revokePeer`
evicts a revoked peer's reservation outright (`reservationStore.removeReservation`) as defense-in-
depth alongside the CONNECT-time gater check — this remains correct and unchanged by this
correction. See `electron/sync/automerge/relayCoordinationWindow.test.js` for the reservationTtl/
maxReservations proofs, and `docs/work/security/` for the standing-reservation acceptability
question, which is the owner's pending decision, not resettled here.

_Prior (round 2, superseded by the correction above): "The ~128 KiB / ~2 min figure above is not
automatic from `@libp2p/circuit-relay-v2`'s own defaults — the library's `reservations.
reservationTtl` defaults to 2 hours (`DEFAULT_MAX_RESERVATION_TTL`), a renewable window, not the
disposable one this design requires. The implementation (`syncStarter.js`) sets `reservations.
reservationTtl` and `defaultDurationLimit` to the SAME explicit 120000ms window... " — kept for
the record; the "disposable" framing in that text was itself wrong, per the round-3 correction._

## C. AutoNAT-camp-peers-only — hard, blocking requirement

T336 §2 already states this requirement for AutoNAT itself; it is restated here as spanning both
layers because the coordination relay and AutoNAT are the two places this program could silently
reproduce the rejected public-DHT exposure shape at a different layer, and both must close before
either capability's `signoff` entry is written:

**libp2p's default AutoNAT service configuration assumes a shared public population analogous to
STUN servers — unmodified, it would let a device ask *any* reachable peer, camp or not, to act as its
AutoNAT server.** That default must not ship. AutoNAT servers must be restricted to this device's own
camp-admitted peer set — the same roster the coordination relay restricts R to — never left at
library defaults, never pointed at a shared/public AutoNAT service.

**This is a hard, blocking gate-scope requirement, not an assumption carried forward from "we didn't
configure a public one."** The `dcutr`/`autonat` capability row's `signoff` must not be written until
a red-before-green test demonstrates the restriction actively rejects use of a non-camp peer, not
merely that no non-camp peer happened to be configured. Test seam (extends T336 §4's real-multi-node
pattern, same `transport.test.js`-style harness):

- Setup: three real libp2p nodes — A (device under test), B (a camp-admitted peer), X (a peer that is
  reachable and otherwise looks like a valid libp2p node, but is **not** in A's camp roster/admitted
  set — simulating either a stray non-camp peer or, worse, a configuration regression that left a
  shared/public AutoNAT default active).
- Action: configure A's AutoNAT service list with the camp-scoping logic this design requires, with X
  present as a reachable-but-non-camp candidate. Trigger A's AutoNAT reachability probe.
- Assertion (red-before-green): **before** the scoping restriction is implemented, the test must show
  A is willing to use X as an AutoNAT server (demonstrating the hazard exists and the test actually
  catches it) — this is the "red" baseline. **After** the restriction lands, the same test asserts A
  never dials X for AutoNAT purposes and only ever uses B (or another camp-admitted peer) — the
  "green" state. A non-camp peer must be provably, mechanically excluded, not merely absent from the
  default config by convention.
- This same red-before-green discipline applies to the coordination-relay candidate selection in §A:
  a non-camp peer must never be selectable as R, because R-selection only ever draws from
  `peer_last_addresses`/`devices`-rooted, already-admitted entries — but because this is the second
  place the same hazard could leak back in, it gets its own assertion in the capability's battle-test
  evidence, not an assumption that §A's prose alone covers it.

## D. The two carry-forward proofs, extended to the coordinated/relayed-then-punched path

T336 §4 already specifies both proofs for the direct hole-punched path once dcutr has produced a
connection. This design extends both to cover the coordination hop that gets dcutr its first contact,
because the coordination relay introduces a connection-upgrade step (B↔R↔C relayed signaling →
B↔C direct) that is a second place a stream could ride a connection without the full re-check the
T334/T335 lesson exists to prevent.

**Proof 1 — revoked-device carry-forward, now covering all three arrival paths.** Extends T336 Proof 1
(cached address, simulated hole-punch dial) with a third arrival path: **via the camp-peer
coordination relay**. Setup: three real libp2p nodes — A (this device), B (a camp peer, later
revoked), R (a third camp peer acting as coordination relay). B is admitted, LAN-trusted, with a
remembered address; A's address book does not currently have a working address for B, forcing A to
attempt coordination through R. Revoke B (a real signed revoke entry via `authorityReplay.js`, not a
stubbed boolean). Attempt reconnection to B via (a) cached address, (b) a simulated hole-punch dial,
and (c) **the coordination-relay path through R**. Assertion: **all three** attempts are refused by
`syncNode.js`'s `authorize()`/`isPeerRevoked` check, run on the resulting connection exactly as it runs
for any other connection — not because R refuses to relay for a revoked peer (R may not even know B is
revoked yet, depending on propagation timing — that is a tolerated, bounded residual, not a gap this
proof is required to close, since admission is the backstop regardless), but because the connection
that eventually reaches A's admission layer is rejected there. Also assert: R itself, on receiving B's
revocation, refuses to continue relaying for B going forward (R is also a camp member subject to the
same admission check on its own connection to B) — this is a defense-in-depth check, not the proof's
load-bearing assertion.

**Proof 2 — revoke-while-running cut-off, now covering the relay-then-punch handoff window.** Extends
T336 Proof 2 (live hole-punch-upgraded connection severed within a heartbeat, no further stream
openable) with the specific window T336 already flagged as dangerous: "a hole-punch upgrade changes
the transport under an existing connection without necessarily re-running the full handshake." The
coordination relay adds an earlier instance of the same shape — the B↔R↔C relayed connection is itself
a connection that could have live streams open on it (the signaling exchange) at the moment a
revocation lands. Setup: four real libp2p nodes — A, B (to be revoked), R, and the relayed connection
between A and B actively mid-signaling-exchange through R. Action: revoke B while the relay stream is
open, before dcutr's simultaneous-open attempt completes. Assertion: the relayed connection is severed
within one heartbeat of the revocation write landing, and the subsequent dcutr punch attempt either
never starts or is itself rejected by the same admission check once it would otherwise produce a
connection — i.e. revocation must be checked **at every hop of the handoff** (B↔R, R↔C, and the final
direct B↔C), not only at the first or the last. This is the T336-stated requirement ("the
revocation-enforcement hook must run on every multiplexed stream open... because a hole-punch upgrade
changes the transport under an existing connection") carried one layer earlier into the relay handoff.

## E. Capability-gate sequence

This slice opens the `relay` row (`@libp2p/circuit-relay-v2`, `transportCapabilities.js:34-39`,
currently `signoff: null`, sourceMarker `circuitRelay`). At build time: the real package lands in
`package-lock.json`, the `circuitRelay` sourceMarker appears in `syncStarter.js`/`transport.js`'s
wiring, and `signoff` stays `null` — the guard (`transportBoundary.guard.test.js`) fails red,
correctly, until the capability passes its gate. Unblocking requires, per the ADR's established
discipline (unchanged by this design): (a) security-assessment + Security + Red Hat review of this
design's exposure boundary (§B) and the AutoNAT-camp-peers-only requirement (§C), and (b) adversarial
battle-testing including both extended carry-forward proofs (§D) and the red-before-green AutoNAT
scoping test (§C), on the actually-installed `@libp2p/circuit-relay-v2` version
(`org-source-verification` — resolve the real installed version before relying on any claim about its
wire behavior; neither it nor `@libp2p/dcutr`/`@libp2p/autonat` is in `package-lock.json` today). A
Security or Grader FAIL stops the loop and returns to the owner via the organizer. Only after a clean
pass does the `signoff` entry get written and the capability merge. This design does not add the
package, does not flip `signoff`, and does not write `circuitRelay` into production wiring — that is
Maker's job, after this design and the organizer's review of it.

**Gate-fix round 2 addendum (Security-Assessment F-1).** `signoff` authorizes CODE MERGE, not
runtime promotion to the PRIMARY data path — those are deliberately two separate gates. A bare
`SHORESH_RELAY_ENABLED=true` must never be sufficient to make relay carry live traffic ahead of
T336's dcutr direct-upgrade existing to bootstrap from it; the implementation (`relayEnablement.js`)
additionally requires dcutr to actually be present in the build (`@libp2p/dcutr`/`@libp2p/autonat`
resolvable) before `relayServerFactory`/`relayTransportFactory` are ever constructed, mechanically
coupling activation to the thing this coordination layer exists to serve, rather than trusting a
human to remember a second sentinel.

**Gate-fix round 3 addendum (Red Hat MEDIUM — presence-not-signoff gap).** The round-2 coupling
above checks whether `@libp2p/dcutr`/`@libp2p/autonat` are importable, not whether the `dcutr`
capability row is actually SIGNED OFF. That gap matters precisely because of the round-3
correction above §B: a relay reservation is standing, not disposable, so the window where dcutr's
packages are present in the tree (T336 lands them) but `dcutr.signoff` is still `null` (review not
yet complete) is a window where this coupling alone would already flip relay-eligible — exactly
the "relay as the only path, indefinitely" shape this design exists to avoid outside dcutr being
actually reviewed-and-authorized, not merely present. `electron/sync/automerge/
dcutrPresenceWithoutSignoff.guard.test.js` asserts this invariant directly (either both packages
are absent from the resolved tree, or `dcutr.signoff` is non-null) and fails loudly the moment it
breaks, rather than relying on this doc note alone.

## F. Reuse vs. new; slice sequence

**Reused, unchanged:**
- `peerAddressBook.js` — `rememberPeerAddress`, `listTrustedRememberedAddresses`,
  `redialTrustedPeers`'s stale-address-safe, per-target trust-re-checked dial pattern. The
  coordination layer's candidate-R selection and the R→C dial both reuse this exact mechanism; no new
  dial-safety logic is introduced.
- T331's admission gates (`authorityReplay.js`'s `currentRevokedDeviceIds`, `syncNode.js`'s
  `authorize()`/`isPeerRevoked`) — untouched, and the entire reason §A's "restriction falls out of the
  mechanism" claim holds. Every hop (B↔R, R↔C, eventual B↔C) is just another connection subject to the
  same gate.
- `rotatingDiscoveryTag.js` — not consulted. This mechanism works entirely from already-known peer
  identities in `peer_last_addresses`/`devices`, never from a discovery-tag lookup; consistent with
  T336 §5's note that the tag is unrelated to the remembered-address/hole-punch rung.
- `transportCapabilities.js` — the registry mechanism itself (not the `relay` row's `signoff`, which
  stays `null` until the gate passes).

**New (sketch only, no code):**
- The candidate-R selection + relay-request flow in §A — a device, failing a direct redial to its
  target, iterates its own address book for *other* reachable camp peers and asks one to coordinate.
- The `circuit-relay-v2` wiring in coordination-only mode (capped per the ADR), consumed by T336's
  dcutr dial path once it lands.
- The AutoNAT-camp-peers-only server-list restriction (shared with T336, built once, required by
  both capabilities).
- The extended carry-forward tests in §D and the red-before-green AutoNAT test in §C.

**Slice sequence (resequenced per the organizer's ruling):**

1. **T337 (this design) — coordination layer.** Foundation. Opens `relay` (coordination-only scope).
2. **T336 — hole-punch.** Layers on T337's coordination hop to get dcutr its first contact; opens
   `dcutr`/`autonat`. Resequence note added to that doc (see below).
3. **(Later, rare) Slice B — Cloudflare traffic-relay fallback.** Only when no camp peer is reachable
   to coordinate. Extends `relay`'s data-path scope and/or the existing `discovery` (rendezvous)
   capability. Not built here; client-only when it is picked up (per the ADR's owner-spend reservation
   on the Worker deploy).

## G. Open questions for Governor

1. **The CRDT-piggybacked presence complement (§ divergence pass).** Two independent frames surfaced
   writing each peer's current observed address into an ephemeral, GC'd field of the Automerge
   document itself, so any already-live sync path (even a slow/stale one, or one that reached a third
   device first) also carries fresh address data opportunistically. This is a genuine complement, not
   a replacement — it has a bootstrap dependency (the document can only propagate a fresh address if
   some transport already synced it) so it cannot be the primary coordination mechanism, but it could
   reduce how often the §A candidate-R dial-out is even needed. Worth a future ticket; not scoped into
   T337.
2. **Candidate-R ordering when several are available.** §A ranks by `last_seen_at` (same as
   `redialTrustedPeers`). Confirm this is sufficient, or whether Governor wants a bound on how many
   candidates are tried per attempt (this design assumes best-effort/sequential-or-capped-parallel,
   matching the existing pattern, but does not fix a specific number).
3. **R's own exposure/role-awareness.** This design does not require R's software to treat
   "coordinating for B and C" as a distinguishable mode from "just relaying a short-lived capped
   stream" — it falls out of the existing admission gate. Confirm Governor is comfortable that no new
   UI/consent surface is needed on R's device when it incidentally serves this role (it is the same
   kind of background connectivity work any camp device already does for sync).
