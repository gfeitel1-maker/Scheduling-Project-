---
title: "T336 — Slice A (remembered-address + NAT hole-punch) design"
document_type: spec
authority: proposed
status: draft
created: 2026-10-03
archive_when: "Slice A's capability gate (dcutr signoff) lands or this design is superseded by a revised design doc"
task_class: security-auth
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md, electron/sync/automerge/peerAddressBook.js, electron/sync/automerge/rotatingDiscoveryTag.js, electron/automerge/authorityReplay.js, electron/sync/automerge/transportCapabilities.js]
---

# T336 — Slice A (remembered-address + NAT hole-punch) design

**RESEQUENCED 2026-10-03 — layers on the T337 coordination foundation.** The organizer
(owner-delegated) ruled on this design's own Open Questions §1 finding (dcutr cannot run cold,
because it upgrades an existing connection rather than creating one): the coordination layer that
supplies dcutr's first contact is foundational and is built FIRST, as T337
(`docs/work/specs/2026-10-03-t337-coordination-layer-design.md`), with this hole-punch design layered
on top of it. This resolves Open Question §1 as option (a)/(b)'s substance — the coordination channel
is opened as its own slice before `dcutr` — with the coordination default being a camp-admitted peer
acting as `circuit-relay-v2` in coordination mode (not Cloudflare, not a Shoresh-run node), per T337
§A. The remainder of this document is otherwise unchanged and still describes the hole-punch
mechanism, exposure profile, and test seams correctly; read "the coordination channel" wherever it
appears below as "the T337 coordination layer," now a resolved prerequisite rather than an open
question.

**Design-only. Opens and builds nothing.** Produced per the owner-decided ladder: LAN meet [hard
prerequisite] → remembered-address + NAT hole-punch (dcutr/AutoNAT) [PRIMARY cross-network rung] →
Cloudflare rendezvous [RARE firewall-only fallback] (`docs/adr/2026-10-02-wan-discovery-transport-
ladder.md`, Amendment 2026-10-03). Public DHT is rejected and removed; "never met on a LAN" is out
of scope by first principle — neither is reopened here.

## Candidate approaches considered (divergent pass)

Five parallel frames (regulator, attacker, inversion, logistics, 3am-on-call) were run against this
problem before converging. The frames did not disagree on *mechanism* — libp2p's dcutr/AutoNAT shape
is fixed by the library, not a design choice — so they converged into one architecture, with the
divergence doing its real work on the **exposure boundary** and **test seam shape**, both folded
into the Approach below:

- **Exposure scoping** (regulator + attacker frames, 4 independent hits): AutoNAT reachability
  probes and dcutr coordination must be scoped to already-admitted camp peers only, never a shared
  public STUN/AutoNAT service or a cross-camp-shared relay. Converged into the exposure section below
  — this is not a style preference, it is the one finding that, if missed, reproduces the exact
  public-DHT problem the owner already rejected, at a different layer.
- **Revocation-vs-transport race framing** (inversion + 3am-on-call + attacker frames, 3 independent
  hits, same underlying bug shape found three ways): a revoked device racing a hole-punch to
  completion before the revocation check runs, a cached NAT-mapping or relay token surviving
  revocation, a half-upgraded connection where some streams ride the new direct path before teardown
  reaches it. Converged into the two carry-forward proofs and the "transport success is not
  authorization" invariant stated throughout Approach §4.
- **Rejected as out of scope for Slice A**: per-device address-history retention limits, cross-camp
  rendezvous-relay fingerprinting defenses, and AutoNAT-identity rotation-per-dial — real attacker-
  frame findings, but they target a *shared public* AutoNAT/relay population. Slice A's design (below)
  never talks to one, so these don't apply yet; they become relevant only if a future slice widens
  AutoNAT/relay to non-camp infrastructure, which this design explicitly does not do. Flagged, not
  built.
- **The structural A/B sequencing gap** (logistics frame's "will-call vs. dispatched delivery vs.
  white-glove" framing, independently corroborated by rereading the ADR's own mechanism section
  against its build-sequence section): this is not a brainstormed idea at all — it is a plain
  contradiction inside the accepted ADR, surfaced by asking "what actually gets two reflexive
  addresses in front of each other before dcutr can punch." See Open Questions §1; it is the most
  consequential finding in this document.

## 1. Mechanism — the connection-establishment chain, stated honestly

Three distinct libp2p-level facts, not one:

- **Remembered-address reconnect (Slice 1, merged, unchanged).** `peerAddressBook.js`'s
  `redialTrustedPeers` dials a trusted peer's cached `(peer_id, multiaddr)` directly. This works
  whenever the peer's address hasn't changed since last observed (e.g. a laptop that kept the same
  home IP, or whose router kept the same public-facing port mapping). **No coordination channel
  needed** — it's a direct dial to a cached address, exactly the same `dial()` call Slice 1 already
  makes.
- **AutoNAT.** A peer learns its own public/reflexive address and NAT type by asking another libp2p
  node (an "AutoNAT server" in protocol terms) to dial it back and report what it saw. This is
  self-knowledge, not peer-reaching: it tells a device "you are behind a punchable NAT at
  reflexive-address X," it does not connect that device to anyone.
- **dcutr (Direct Connection Upgrade through Relay).** dcutr **upgrades an existing connection to
  direct** — it is a NAT-traversal upgrade, not a discovery mechanism. Per libp2p's own protocol
  (confirmed against the specific `@libp2p/dcutr`/`@libp2p/autonat` versions named in
  `transportCapabilities.js:40-45`, when those are actually added to `package-lock.json` — neither
  package is installed today, per `org-source-verification`; this design does not assume a cached
  training impression of dcutr's wire behavior holds unmodified for whatever version is pinned at
  build time), dcutr's mechanism is: two peers already connected over *some* path exchange their
  observed/reflexive addresses over that existing connection, then simultaneously attempt a direct
  dial to each other's advertised address (the "simultaneous open" trick that gets through many
  NATs). **dcutr cannot run until the two peers already have a connection to exchange addresses
  over.**

**The actual chain, for two LAN-trusted peers now on different wifis, in the order Slice A executes
them:**

1. Remembered-address redial (Slice 1, already shipped) is tried first, always — it's free and
   needs no coordination. If the cached address still resolves to the same peer identity (Noise
   handshake succeeds, per `peerAddressBook.js`'s stale-address-safety guarantee), **this is Slice
   A's success case and dcutr/AutoNAT never run.** This is the common case the ADR calls out: "a
   device moved to one new connection" where the other end's address didn't change.
2. Only if step 1 fails (both ends' addresses changed since last observed, or NAT rebinding moved the
   port) does hole-punch become relevant at all. Here is the chain's load-bearing fact, stated
   plainly because the ADR's own prose (mechanism section, "Reaching directly: NAT hole-punch") and
   its build-sequence section disagree on it: **dcutr needs the two peers to already be in contact
   over *some* channel to exchange reflexive addresses, and the ADR's mechanism section names that
   channel as `@libp2p/circuit-relay-v2`'s coordination-only mode** ("NAT hole-punch via `@libp2p/
   dcutr` coordinated by `@libp2p/circuit-relay-v2`... capped at ~128 KiB / ~2 min"). That coordination
   relay is a *different* capability-registry row (`relay`, `transportCapabilities.js:34-39`) from
   `dcutr` (`:40-45`), and the ADR's build-sequence section only schedules opening `relay` in **Slice
   B**, for the *data-path* use. **Slice A alone — opening only the `dcutr` row — has no mechanism
   to get the first message to a peer whose remembered address no longer resolves.** This is not a
   minor implementation detail; it is a hard dependency the ADR itself documents in one section and
   omits from its own build sequence. See Open Questions §1 for the three ways to close this.
3. Once *some* coordination channel has delivered both peers' reflexive addresses to each other
   (mechanism TBD by Open Questions §1), dcutr performs the simultaneous-open punch. On success, the
   connection is upgraded to direct and the coordination channel is torn down (capped duration/bytes,
   per the ADR). On failure, Shoresh closes the coordination connection and does **not** fall through
   to using it as a data path — that's tier 3 (Slice B), gated separately.
4. Whatever connection results (remembered-address direct dial, or dcutr-upgraded direct) is, from
   `mutualAuth.js`/`syncNode.js` downward, **byte-for-byte identical to any other admitted connection**
   — same Noise handshake, same `authenticate`/`authorize()` path, same `isPeerRevoked` live check.
   Connectivity and admission are different layers; Slice A changes only the former.

## 2. Exposure/cost profile — stated plainly

**AutoNAT reflexive-address exchange: who learns what, and from whom.** AutoNAT, as libp2p ships it,
lets a device ask *any* configured AutoNAT-server peer to dial it back. The exposure question is
entirely about **which peers Shoresh configures as AutoNAT servers**:

- **If scoped to already-admitted camp peers only** (another device already holding a valid,
  non-revoked device trust record for this camp) — acceptable. The information revealed ("this
  device is online at address X") goes only to a peer that has already passed the LAN-meet +
  admission gate; it is a strict subset of what that peer already learns the moment it successfully
  connects to this device by any transport. No new population learns anything.
- **If left at libp2p's defaults or pointed at a shared public AutoNAT service** — this reproduces
  the exact problem the owner rejected for the public DHT: an unbounded, uncontrolled population
  (whoever operates that public AutoNAT infrastructter) learns this device is online and at what
  address, with no camp-membership gate at all.

**This design requires AutoNAT be restricted to the camp's own already-admitted peer set — never a
shared/public AutoNAT service.** This is not a nice-to-have; it is the condition under which Slice A
does not reproduce the rejected DHT's exposure shape. Flagged as a decision to close before the
capability opens (Open Questions §2), because today's libp2p AutoNAT service configuration does not
default to this restriction — it must be built, not assumed.

**dcutr hole-punch: who learns what, and from whom.** The peer you exchange reflexive addresses with
to punch is, by construction in this design, the camp peer you are trying to reconnect to — already
LAN-met and admitted at some point in the past (that's the entire reason a remembered address exists
for it). No stranger is involved in the punch itself. The open question is only the **coordination
channel** that gets the two peers in contact before the punch (§1 step 2, Open Questions §1) — if
that channel is itself scoped to camp peers (e.g. a trusted peer acting as a relay for its own
camp-mate, never a public/shared relay), the punch exchange stays camp-scoped throughout. If the
coordination channel is a public/shared relay operator, that operator — but *only* that one operator,
not an unbounded population — learns that two opaque peer-ids are coordinating; this is the same
single-operator exposure class the owner already accepted for Cloudflare, and is why Slice B's
relay-as-data-path gets its own, later capability gate rather than being folded into Slice A.

**Confirmed explicitly: Slice A introduces no public-presence broadcast.** Nothing in this design
publishes "this device is online at this address" to an unbounded/uncontrolled population analogous
to the rejected DHT `provide`/`findProviders` call. AutoNAT reachability is told only to camp-scoped
peers (subject to the restriction above actually being built); dcutr's reflexive-address exchange
happens only with the specific camp peer being reconnected to, over a coordination channel that is
either camp-peer-scoped or a single named operator (never unbounded). This is categorically different
from the DHT's "any of millions of participants" exposure the 2026-10-03 amendment rejected.

**Cost profile.** Connection-attempt overhead: one extra RTT for AutoNAT's dial-back probe (run
opportunistically, not on every connection attempt — cached per observed network change, not
per-dial); dcutr adds the coordination-channel round-trip (§1 step 2) plus the simultaneous-open
attempt itself (sub-second on a punchable NAT, per upstream libp2p docs — to be re-confirmed against
the installed version at build time, not assumed). Failure mode: a non-punchable pairing (e.g. one
side behind symmetric NAT) fails the simultaneous-open within a bounded timeout and must not hang —
this is the explicit test seam in §4 and the 3am-on-call finding ("every dial gets a hard deadline
timer owned by the caller, not the library's internal state machine"). Retry/backoff: Slice A should
not retry a failed punch in a tight loop against the same coordination channel; the existing
`redialTrustedPeers` pattern (independent, `Promise.allSettled`, best-effort, logged-never-thrown) is
the template to extend, not reinvent.

## 3. NAT coverage — honest, and framed as the ladder working as intended

Remembered-address + hole-punch, together, solve:

- Both peers' addresses unchanged since last observed → Slice 1 alone (no hole-punch needed).
- One or both peers behind an endpoint-independent/"full cone" or "restricted cone" NAT (the common
  home-router case) whose address changed → dcutr's simultaneous-open punch succeeds in the large
  majority of real home-NAT configurations, once both reflexive addresses are exchanged (§1 step 2).

What it **cannot** solve: **both peers behind symmetric or CGNAT-style NATs simultaneously** — no
simultaneous-open trick exists for that pairing because each side's externally-visible port depends
on the destination, which the other side doesn't know until a packet already arrives. This is not a
Slice-A bug or an apologetic gap — it is the precise, by-design reason Slice B's Cloudflare-relay
data path exists as the rare fallback: "a weird firewall throws a barrier we can't work around" (owner,
2026-10-03). The ladder is designed with this boundary in mind, not surprised by it.

**Honest residual already recorded in the ADR and unchanged by this design:** a direct home↔home
punch has not yet been proven on real, independently-NATed hardware (only the relay-assisted CGNAT
path was prototyped in 2026-09-06). Proving it is part of Slice A's acceptance criteria, not an
assumption this design launders into "done" — see §4's real-layer test requirement.

## 4. The two carry-forward proofs — test seam design, red-before-green, real-layer

Both proofs must use a **real, in-process multi-node libp2p test** with actual `@libp2p/dcutr` and
`@libp2p/autonat` wired in — no mock-only proof for a capability-opening slice, per the T334/T335
lesson already recorded in this repo's history. The existing pattern to extend is
`transport.test.js`'s "stale address safety" describe block (two real libp2p nodes, a real Noise
handshake, assertions on the actual connection outcome) and `syncNode.js`'s `isPeerRevoked`/
`peerDeviceIds` map (already the live, per-connection admission check Slice A must route through
unchanged).

**Proof 1 — revoked-device carry-forward over the direct hole-punched path.**

- Setup: three real libp2p nodes — A (this device), B (a camp peer later revoked), and whatever
  coordination role §1 step 2 resolves to (either a third camp peer or a stubbed coordination
  channel, per Open Questions §1's resolution). B is admitted, LAN-trusted, and has a remembered
  address in A's `peer_last_addresses` (seeded via `rememberPeerAddress`, same as existing Slice-1
  tests).
- Action: revoke B (write the revocation the same way `authorityReplay.js`'s `currentRevokedDeviceIds`
  observes it — a real signed revoke entry, not a stubbed boolean). Then attempt reconnection to B via
  (a) `redialTrustedPeers`'s cached address, and separately (b) a simulated hole-punch dial using B's
  post-change address, wired through whatever dcutr dial path Slice A's implementation exposes.
- Assertion: **both** attempts are refused — not because discovery excludes B (it may still resolve
  B's address or complete a transport-level handshake), but because `syncNode.js`'s `authorize()`/
  `isPeerRevoked` check, run on the resulting connection exactly as it already runs for any other
  connection, rejects it. This is the parity requirement the ADR states at §2 of the (superseded)
  DHT design and restates for hole-punch: admission, not discovery, is what blocks a revoked device,
  regardless of which transport reached it.
- This extends (does not replace) the existing `peerAddressBook.js` stale-address-safety test; it
  adds the hole-punch transport as a second way of "reaching" B that must hit the same wall.

**Proof 2 — revoke-while-running cut-off over a live direct hole-punched connection.**

- Setup: two real libp2p nodes, A and B, with a connection that has already dcutr-upgraded to direct
  (not merely admitted — actually transport-upgraded, so the test exercises the exact post-punch
  connection state, including any dcutr-specific stream/connection object libp2p produces).
- Action: revoke B **while the direct connection is live**, racing the revocation write against an
  in-flight stream-open attempt on that connection (the 3am-on-call frame's specific framing: "race
  the connection-upgrade callback itself against the revocation write" — the dangerous failure mode
  is two live sockets to the same peer during the dcutr handoff window, not merely a stale cached
  list).
- Assertion: the connection is severed within one heartbeat interval of the revocation write landing
  (same bound already established for the non-hole-punched admission teardown path), and **no
  further stream can be opened on it** — this requires the revocation-enforcement hook to run on
  every multiplexed stream open, not only at initial connection establishment, because a hole-punch
  upgrade changes the transport under an existing connection without necessarily re-running the full
  handshake. Confirm `syncNode.js`'s existing `isPeerRevoked` call site (`handleSyncMessage`, line
  ~468) is reached for traffic arriving over a dcutr-upgraded connection exactly as it is for any
  other connection — if dcutr's connection-upgrade path bypasses that call site, that is a Slice-A
  implementation defect to fix, not a design gap to route around.
- Also assert: after severance, B cannot re-establish a new direct connection to A via a cached
  pre-revocation address or a fresh hole-punch attempt (covered by Proof 1's assertions, re-run
  post-severance).

## 5. Reuse vs. new

**Reused, unchanged:**
- `peerAddressBook.js` — `rememberPeerAddress`, `forgetPeerAddress`, `listTrustedRememberedAddresses`,
  `redialTrustedPeers`. Slice A's hole-punch dial path is a fallback *after* this, not a replacement.
- `rotatingDiscoveryTag.js`'s `rotatingDiscoveryDigest` — transport-agnostic by design; not consulted
  for the direct-reconnect/hole-punch rung at all (that rung works from already-known peer identities
  in `peer_last_addresses`/`devices`, not from a discovery tag lookup). No change needed here.
- `authorityReplay.js`'s `currentRevokedDeviceIds`, `createVerifiedEntryTrust`, and `syncNode.js`'s
  `isPeerRevoked`/`authorize()` admission path — untouched. Slice A must route every resulting
  connection through these exactly as every other connection already does.
- `transportCapabilities.js` — the registry mechanism itself (not the `dcutr` row's `signoff`, which
  stays `null` until the gate passes).

**New (sketch only, no code):**
- A hole-punch dial attempt, triggered when `redialTrustedPeers`'s direct dial to a remembered address
  fails, that (a) obtains the peer's current reflexive address via whatever coordination channel
  Open Questions §1 resolves, (b) invokes dcutr's simultaneous-open upgrade, (c) on success, hands the
  resulting connection to the exact same `syncNode.js` admission path every other connection uses —
  no new admission code, only a new way of arriving at a connection object.
- AutoNAT-server configuration restricted to the camp's own admitted peer set (§2) — new
  configuration/wiring, not new admission logic.
- The two real-layer multi-node tests in §4.

## Capability-gate sequence (unchanged mechanism, restated for this slice)

Per `transportCapabilities.js` and the ADR's established discipline: the `dcutr` row's `signoff`
stays `null` through this design pass. It becomes non-null only after (a) security-assessment +
Security + Red Hat review of the exposure boundary in §2, and (b) adversarial battle-testing
including both §4 proofs passing on the real installed `@libp2p/dcutr`/`@libp2p/autonat` versions, with
evidence recorded under `docs/work/security/` and referenced from the registry's `signoff.doc` field.
A Security or Grader FAIL stops the loop and returns to the owner via the organizer — never pushed
past. This design does not add the packages, does not flip the `signoff`, and does not write the
`sourceMarkers` (`dcutr`, `autonat`) into `syncStarter.js`/`transport.js` — that is Maker's job, after
this design and the organizer's review of it.

## Open questions for the owner/organizer

1. **The Slice-A/Slice-B coordination-channel dependency (the central finding of this design).**
   Per §1 step 2: dcutr cannot exchange reflexive addresses without *some* channel already connecting
   the two peers, and the ADR's own mechanism section names that channel as `@libp2p/circuit-relay-v2`
   coordination mode — a different capability row (`relay`) from `dcutr`, currently scheduled to open
   only in Slice B. Three honest ways to close this, **none chosen here** because this is a product/
   sequencing decision, not a technical one:
   - (a) **Widen Slice A to open a coordination-only-capped sub-scope of the `relay` row** alongside
     `dcutr` — i.e. Slice A opens both rows, but `relay`'s initial gate covers only the ~128 KiB/2 min
     coordination use the ADR already describes, with the larger data-path use still deferred to
     Slice B's own, separate gate. This keeps Slice A's own scope matching what it actually needs to
     function, at the cost of Slice A opening two registry rows instead of one.
   - (b) **Resequence: build Slice B's coordination-capable relay client first** (even though its
     data-path use stays gated off), then Slice A's dcutr consumes it. Functionally identical to (a)
     but changes which ticket/slice number does the work.
   - (c) **Scope Slice A to the remembered-address-only success case for this ticket**, and treat
     "both ends' address changed since last contact" (the case that actually needs coordination) as
     explicitly out of scope until the relay-coordination question is resolved — i.e. ship a narrower
     Slice A now (hole-punch only between peers that can still reach each other's *last-known* address
     to exchange addresses directly, a real but narrower win) and fold the full hole-punch-after-
     address-change case into whichever slice opens coordination.
   Recommend the organizer rule on (a) vs (c) before Maker is briefed — (b) is equivalent to (a) in
   substance, just renumbered.
2. **AutoNAT-server scoping is a design decision to close, not a default to inherit.** §2 requires
   AutoNAT be restricted to the camp's own admitted peers; this is not how libp2p's AutoNAT service
   behaves out of the box (it is written assuming a shared public AutoNAT population analogous to STUN
   servers). Confirm the organizer wants this restriction built as part of Slice A's gate (recommended
   — it's the condition under which Slice A doesn't reproduce the rejected DHT's exposure shape) rather
   than assumed satisfied by "we didn't configure a public one."
3. **Real independently-NATed hardware for the home↔home proof.** §3's honest residual — a direct
   home↔home punch has not been proven on real hardware, only the relay-assisted CGNAT case was
   prototyped. Confirm this is in scope for Slice A's battle-test evidence (two devices on genuinely
   separate home networks, not two processes on one LAN simulating separate networks) before the gate
   is considered closed.

## Carry-forward note (gate-fix round 4, T337 pre-signoff hardening)

The ticket for this slice, `docs/work/tickets/T336-nat-holepunch-dcutr.md`, records three items as
explicit BLOCKING preconditions on this capability's gate — not loose "deferred" notes — carried
forward from T337's own build: (1) relay-specific every-hop revocation proven over the REAL
merge-propagated revoke chain to a third relay node, not only T337's direct-call revoke proof; (2)
client-side camp-only auto-reservation (`RelayDiscovery`/`circuitRelayTransport`'s own behavior,
which T337's server-side gate does not cover), red-before-green at enable time; (3) UI surfacing of
`RESERVATION_REFUSED` once a camp exceeds the relay's `maxReservations` cap. See that ticket for
the full acceptance criteria.

## Commit

Doc path: `docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md`. No capability opened, no
package added, no production code written.
