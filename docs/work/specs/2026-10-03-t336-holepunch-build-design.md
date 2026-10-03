---
title: "T336 — NAT hole-punch (dcutr/AutoNAT) full build design, layered on T337's landed coordination foundation"
document_type: spec
status: approved
created: 2026-10-03
archive_when: "the dcutr/autonat capability gate passes (security-assessment + Security + Red Hat + battle-test + Grader) and transportCapabilities.js's dcutr row gets a non-null signoff, or this design is superseded by a revised design doc"
task_class: security-auth
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md, docs/work/specs/2026-10-03-t337-coordination-layer-design.md, docs/work/tickets/T336-nat-holepunch-dcutr.md, SECURITY.md, electron/sync/automerge/transportCapabilities.js, electron/sync/automerge/relayEnablement.js, electron/sync/automerge/peerAddressBook.js, electron/sync/automerge/syncNode.js, electron/sync/automerge/transport.js, electron/sync/automerge/syncStarter.js]
related_docs: [docs/work/security/2026-10-03-t337-standing-reservation-signoff-battletest.md]
---

# T336 — NAT hole-punch build design

**Supersedes-in-practice:** `docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md` (that
doc's own frontmatter has been updated with a pointer to this one — not deleted, per this repo's
historical-marking convention; its mechanism analysis, exposure analysis, and two carry-forward
proofs are correct and are carried forward here, cited rather than restated where unchanged).
What changed since that doc was written: **T337 landed** (`#736`, merged to `main`) — the
coordination foundation this slice depends on is no longer a design, it is running code with a
scoped `relay` signoff (`transportCapabilities.js:34-54`). This document is T336's **build**
design: it takes T337's actual landed shape (not T337's design-time description of itself) as
given, resolves the three BLOCKING preconditions the ticket carries forward, and produces a
test-first slice plan Maker can execute without further architectural judgment calls.

**Design-only. Opens and builds nothing.** `@libp2p/dcutr`/`@libp2p/autonat` are not installed;
`dcutr.signoff` stays `null` through this document.

## Candidate approaches considered (divergence)

The mechanism itself is not open: libp2p's dcutr/AutoNAT wire behavior is fixed by the library,
the owner's ladder is accepted (ADR 2026-10-02 + amendment), and the slice-A/T337 design passes
already ran five-frame divergence against "how does hole-punch layer on the coordination relay"
and converged on the architecture this document builds on (remembered-address-first, dcutr as an
upgrade not a discovery mechanism, camp-scoped AutoNAT, admission-not-discovery-is-the-control).
Re-running that same divergence against the same already-ruled mechanism would reproduce it, not
widen it — this is the `adhd` pre-flight gate's own abstention case ("a bug with a known root
cause... never" applies by analogy to "a mechanism already ruled by the owner and already
divergently explored twice"). What remained genuinely open after reading T337's *landed* code
(not just its design doc) were four implementation-shape questions, and divergence was run
directly against those four, reasoning from four of the frames used in the prior passes
(regulator, 3am-on-call, attacker/competitor, inversion) plus a fresh read of the actual
`relayEnablement.js`/`transportCapabilities.js`/`syncNode.js` code, rather than spawning a fresh
five-agent pool to re-litigate a settled mechanism:

- **How to implement AutoNAT camp-scoping** (regulator + attacker frames): three candidates —
  (a) a static snapshot of `devices` at AutoNAT-service construction time, (b) a live
  closure over the same `authenticatedPeers`/admission set `transport.js`'s connection gater
  already uses for relay (T337's own pattern), (c) a per-probe callback that re-queries admission
  at dial time. **(b) wins** — it is the same mechanism T337 already built and battle-tested for
  the identical hazard one layer over (`denyInboundRelayReservation`/`denyOutboundRelayedConnection`
  closing over `authenticatedPeers`), so reusing it is both less code and inherits an
  already-reviewed pattern rather than introducing a second camp-membership check that could drift
  from the first. (a) is a trap — a snapshot taken at service-construction time goes stale the
  moment a device is admitted or revoked after startup, reproducing exactly the staleness bug class
  `peerAddressBook.js`'s "per-target trust re-check" comment already exists to prevent one layer
  over. (c) is viable but redundant with (b) once (b) is in place.
- **How to prove the three BLOCKING preconditions real-multi-node** (3am-on-call + inversion
  frames): the inversion frame's question — "how would a test *fail to catch* each precondition
  even while technically running 3 nodes?" — surfaced the actual risk in each: (1) a revoke test
  that calls `revokePeer` directly on the relay node instead of driving the revoke through
  `authorityReplay.js`'s real merge path would pass green while proving nothing about propagation
  timing (this is literally what T337's own gate-fix-round-4 note flags about itself); (2) a
  client-side auto-reservation test that only asserts the *server* declines could pass green while
  the *client* never even attempted to reserve through a non-camp relay, because nothing forced
  that attempt to happen; (3) a UI-surfacing test that asserts a Redux/IPC event fires, without
  asserting a director actually *sees* something, could pass green against a silently-swallowed
  toast. Each test design below is written to close the specific blind spot the inversion frame
  found, not just to exercise the happy path.
- **dcutr activation trigger — eager vs. on-redial-failure** (regulator + attacker frames): (a)
  attempt dcutr proactively on every connection, even ones that didn't need it; (b) attempt it only
  after `redialTrustedPeers`'s direct dial fails, exactly mirroring slice-A §1's documented chain.
  **(b) wins, no real contest** — (a) triples AutoNAT/coordination-relay traffic for the common case
  (unchanged address) where Slice 1 already succeeds for free, and the attacker frame flagged it as
  also widening the AutoNAT-probe frequency finding below for no benefit. Kept as a one-line
  decision, not a deepened branch, because slice-A's own §1 already settled this; restated here so
  Maker does not have to re-derive it from two documents.
- **Naming-trap avoidance for the dcutr wiring in `syncStarter.js`** (attacker frame, direct
  application of the lesson T337 already paid for once): T337's `relayEnablement.js` carries an
  explicit warning not to let the substrings `dcutr`/`autonat` leak into helper names that get
  imported into `syncStarter.js`'s scanned source ahead of the `dcutr` capability's own signoff.
  This is not a new finding — it is the single highest-confidence carry-forward from T337's build,
  stated in Approach §5 below as a hard constraint on file/symbol naming, because it is exactly the
  kind of thing a Maker unfamiliar with `relayEnablement.js`'s header comment will reintroduce by
  accident on the very next file that needs to say "is the hole-punch foundation present."

No cluster of ideas here rejects the ruled architecture; all four questions converged to a single
recommended answer each, stated in Approach below with its rejected alternative named for the
record.

## Approach

### 1. Mechanism — dcutr upgrades, AutoNAT informs, admission gates (unchanged from slice-A, restated for build precision)

Carried forward verbatim in substance from `docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md`
§1 — **not re-derived here**, because re-deriving it would risk a silent drift between two documents
describing the same fixed library behavior. The chain, now resolved against T337's *landed* code:

1. `redialTrustedPeers` (shipped, unchanged) tries the cached address first, always. Success here
   means dcutr/AutoNAT never run — this is still the common case and still free.
2. On failure, T337's **landed** coordination relay (not T337's design-time description — the real
   `circuitRelayServer`/`circuitRelayTransport` wiring in `syncStarter.js:380-396`, gated behind
   `relayRuntimeEligible({ relayEnabled, nextRungPresent: await holePunchFoundationPresent() })`)
   supplies the first live channel between the two peers once both pieces exist: T337's `relay`
   row (signed off, `transportCapabilities.js:34-54`) and this slice's `dcutr`/`autonat` presence
   (the `nextRungPresent` input — currently always `false`, since neither package is installed).
   **This is the one piece of plumbing this build design adds that the ADR's own build-sequence
   section and slice-A's Open Question §1 both flagged as missing: it is not missing anymore.**
   T337 built exactly the coordination-only relay slice-A's Open Question §1(a) asked for, already
   landed, already gated by `relayRuntimeEligible` on this slice's own presence. Opening the
   `dcutr` row is therefore the **only** remaining gate-opening act this slice performs; no
   `relay`-row re-opening or re-scoping is needed.
3. Through that relay, both peers exchange current reflexive addresses; `@libp2p/dcutr` performs
   the simultaneous-open punch. On success, `transport.js`'s connection becomes direct; the
   relay reservation this peer holds with R (T337's standing, auto-renewed reservation,
   `relayEnablement.js`/T337 §B) is **not torn down** — it goes idle, exactly as T337's own
   corrected description states, and remains the fallback path if the direct connection later
   drops.
4. On punch failure (non-punchable NAT pairing — both ends CGNAT/symmetric), Shoresh does not
   retry in a tight loop and does not promote the relayed coordination connection to carrying
   ongoing sync traffic — that promotion is Slice B (Cloudflare fallback / relay-as-data-path),
   separately gated, not built here. The relayed connection through R, already a *standing*
   reservation per T337, simply continues serving as whatever fallback it already was; this
   slice adds no new "use the relay as data" code path.
5. Whatever connection results — remembered-address direct dial, or dcutr-upgraded direct — is
   byte-for-byte identical, from `syncNode.js` downward, to any other admitted connection: same
   Noise handshake, same `authorize()`/`isPeerRevoked` check (`syncNode.js:365-468`). **This
   invariant is the single most load-bearing fact in this whole program and is restated once more
   because it is what every test below is actually proving:** connectivity (how a connection gets
   made — mDNS, redial, dcutr, relay) and authorization (whether a device may stay connected and
   exchange sync data) are different layers, and this slice changes only the former.

**Activation trigger (resolved, divergence item 3 above): on-redial-failure, not eager.** The
dcutr dial path is attempted only after `redialTrustedPeers` has exhausted its cached-address
attempts for a given target peer. Implementation note for Maker: this is the same place
`redialTrustedPeers`'s caller already decides "no cached address worked" — thread the dcutr
attempt in as the next step of that same decision point, not a parallel/racing attempt (the ADR's
own "a slower tier must not preempt a faster one that already succeeded" discipline, restated one
layer down from WAN tiers to this slice's own internal steps).

### 2. AutoNAT camp-scoping — concrete mechanism (resolved, divergence item 1)

**Reuse, don't reinvent, T337's admission closure.** `transport.js`'s connection gater already
closes over an `authenticatedPeers`/admitted-peer set to decide `denyInboundRelayReservation`/
`denyOutboundRelayedConnection` for the relay role. This slice's AutoNAT service configuration
must be constructed from **the same set**, passed the same way (a live reference the gater already
holds, not a fresh snapshot) — so that a peer admitted or revoked *after* AutoNAT service
construction is picked up without restart, exactly as T337's relay gating already is. Concretely:
libp2p's AutoNAT service takes a list (or a dynamic provider) of peers it may use as AutoNAT
servers / may serve AutoNAT requests for; Maker's job is to wire that configuration surface — once
`@libp2p/autonat`'s actual installed-version API is read (`org-source-verification`: the package is
not in `package-lock.json` today, so this must be re-confirmed against whatever version resolves
at pin time, not assumed from training knowledge) — to read from the same admitted-peer source
`transport.js`'s gater already uses, not libp2p's own unrestricted default.

**Rejected:** a static snapshot of `devices` taken once at startup (goes stale on
admission/revocation, reproducing the exact staleness class `peerAddressBook.js` already guards
against one layer over); a per-probe re-query that duplicates rather than reuses T337's existing
admission closure (more code, two places that must agree on "who is camp-admitted" instead of
one).

**This restriction is a hard, blocking gate-scope item, not an assumption** (carried forward
verbatim from slice-A §2 and T337 §C — restated once more because it is the second time in this
program the same hazard shape (an unbounded-population exposure reproduced one layer deeper) could
leak back in if anyone treats "we didn't configure a public AutoNAT service" as equivalent to "we
actively excluded one").

### 3. Intrinsic exposure — owner-facing finding, surfaced before build (required per the owner's design-time-exposure rule)

**Precise statement of what becomes observable, to whom, as a direct consequence of this slice
existing (not of T337, which is already signed off and running):**

- **AutoNAT dial-back probe.** When device A asks camp peer B (its configured AutoNAT server, per
  §2's camp-scoped set) "dial me back and tell me what you see," B learns A's current reflexive
  (public) address and that A is online, at the moment of the probe. **This is not a new exposure
  class** — B already learns the identical fact (A's address, A's online status) the instant B
  successfully connects to A by *any* existing transport (mDNS, remembered-address redial,
  rendezvous), which has been true since before this program began. What AutoNAT **does** add is
  *frequency*: AutoNAT probes opportunistically on an observed network change, not only when an
  active sync connection happens to occur — so B's picture of "when A is online and at what
  address" becomes a more complete, more continuous presence record than B would otherwise
  accumulate from sync traffic alone. **This is the one genuinely new fact this slice introduces,
  and it is flagged here rather than buried in the gate, per the standing rule that a mechanism's
  known exposure is a design-time owner input.** The audience is unchanged (only already-admitted
  camp peers, never anyone else) and the content learned per-event is unchanged (address +
  liveness, already learnable by any direct connection) — only the *cadence* at which one
  camp-admitted device can build a presence timeline of another increases.
- **dcutr reflexive-address exchange.** The two peers performing the punch exchange their current
  public addresses with each other — but they are, by construction (§1), the exact camp peer pair
  already attempting to reconnect; neither learns anything about the other that a successful
  direct connection between them wouldn't already reveal. **No third party, ISP, or ongoing
  observer learns anything new**: the simultaneous-open packets exchanged during the punch attempt
  are ordinary UDP/TCP packets to/from each side's own already-public-facing address, visible to
  each side's own ISP exactly as any other outbound connection from that network already is — this
  is not a new class of exposure to a network operator, it is the same exposure every home internet
  connection already has every time it makes an outbound connection to anything.
- **The relay node R (T337, already signed off, unchanged by this slice).** R learns the same two
  facts (A's and the target's addresses, that they're coordinating) it already learns under T337's
  signed-off design — this slice adds no new fact for R to learn, only a *consumer* of the channel
  R already provides.
- **No public-presence broadcast, confirmed.** Nothing in this slice publishes anything to an
  unbounded or uncontrolled population. Every fact above is learned only by a peer that has already
  passed the LAN-meet + T331 admission gate for this camp — contrast the rejected public DHT, whose
  defining defect was exposure to an unbounded population of strangers. This slice does not
  reproduce that shape at any layer, *provided* §2's camp-scoping is built as specified, not
  assumed.

**Conclusion and recommendation to the owner:** this slice introduces **no new exposure class** and
**no new audience** beyond what T337 (already accepted) and Slice 1 (already shipped) created. The
one incremental fact — AutoNAT's higher-frequency presence/liveness picture available to a camp
peer configured as an AutoNAT server — is a *cadence* increase within the *already-accepted*
audience (camp-admitted peers), not a new disclosure. **Recommendation: proceed without requiring a
fresh owner ruling on this point, confidence high** — it does not meet the bar of "exposure not
already accepted," because the owner has already accepted camp-peer-to-camp-peer address/liveness
disclosure via Slice 1's remembered-address reconnect and via ordinary sync connections themselves.
**Flagged explicitly here, rather than silently assumed, per the standing design-time-exposure
rule** — if the organizer or owner reads this differently (e.g. judges continuous presence-pattern
accumulation as qualitatively different from point-in-time address disclosure even within a trusted
population), that is the one open item in this section to confirm before the capability gate
proceeds; see Open Questions.

### 4. Security/battle-test plan — how each gate item gets proven, real-multi-node, red-before-green

**Full `npm run verify` is the gate, not a targeted suite** — restated as a hard requirement
because of the T337 #736 lesson (transform-time Vite failures only surface in the browser-env
`.jsx` path; a targeted Vitest run of only the new files would have missed
`relayEnablementImportSafety.test.jsx`'s class of failure). Every slice below ends with a full
`npm run verify` run, not merely the new test files passing in isolation.

**Capability-gate structure (unchanged from the ADR/slice-A's established discipline, restated for
this slice specifically):** `dcutr.signoff` stays `null` until, in order:

1. **Security-assessment + Security + Red Hat review** of this design's §2 (AutoNAT camp-scoping),
   §3 (exposure), and the three BLOCKING preconditions below.
2. **Adversarial battle-testing**, real multi-node libp2p, no mocks for any capability-opening
   assertion, covering:
   - The two carry-forward proofs from slice-A §4 (revoked-device carry-forward; revoke-while-
     running cut-off), extended to the dcutr-upgraded connection specifically.
   - T337's own two carry-forward proofs extended to the full relay→dcutr handoff (T337 §D),
     re-run against the **real** dcutr/AutoNAT packages once installed (T337 proved these with
     dcutr/AutoNAT absent, necessarily — "the relayed connection is severed... and the subsequent
     dcutr punch attempt either never starts or is itself rejected" was asserted against a stubbed
     punch step; this slice is what makes that assertion real).
   - The red-before-green AutoNAT camp-peers-only test (T337 §C's design, now executed against
     this slice's actual implementation — see test seam list below).
   - The three BLOCKING preconditions, detailed next.
3. A Security or Grader **FAIL on any item above stops the loop and returns to the owner via the
   organizer** — never pushed past, per the ADR's acceptance §4 and the ticket's own closing line.
4. Only after a clean pass does `transportCapabilities.js`'s `dcutr` row get a non-null `signoff`,
   with `doc` pointing at the dated battle-test evidence record under `docs/work/security/`.

**The three BLOCKING preconditions, each with its test-design closing the specific blind spot the
inversion-frame divergence pass (above) found:**

**Precondition 1 — relay-specific every-hop revocation over the REAL merge-propagated revoke
chain.** Test must NOT call `revokePeer` directly on the relay node (that is what T337 already
proved and is insufficient here). Real setup: four libp2p nodes — A (device under test), B (to be
revoked), R (a third node acting as relay, distinct from A and B), and the device that *mints* the
revoke. Action: mint a real signed revoke entry for B, write it to `authority_cache` on the
minting device, and let it **merge-propagate to R** through the ordinary Automerge sync path (not
a direct function call) — this is the one step T337's own existing tests skip. Assert, in order:
(a) R's own merge observer picks up the revoke and calls `tearDownRevokedConnectedPeers` as a
*result of the merge event*, not a test harness calling it directly; (b) `revokePeer` fires on R
for B as a consequence of (a); (c) R's `reservationStore.removeReservation` is actually invoked for
B's reservation (the existing `transport.js:498` call site) and B's reservation is gone from R's
store afterward; (d) A, attempting to reach B through R after this propagation completes, is
refused — both at the relay-broker level (R declines to broker, per T337's existing
`relayRoleCampOnly.test.js` pattern, extended to post-propagation state) and, as a backstop, at
`syncNode.js`'s `authorize()`/`isPeerRevoked` if somehow a connection to B is produced anyway.
**Test file:** new, `electron/sync/automerge/relayRevocationMergePropagation.test.js` — extends
the real-merge pattern already used by `electron/automerge/authorityReplay.js`'s own tests (reuse
the merge-doc fixture helpers from there; do not hand-roll a second way to produce a real merged
revoke).

**Precondition 2 — client-side camp-only auto-reservation, red-before-green at enable time.**
T337's `denyInboundRelayReservation`/`denyOutboundRelayedConnection` prove the **server** (R)
declines to broker for non-camp peers. This precondition is about the **client**:
`RelayDiscovery`/`circuitRelayTransport`'s own behavior when `SHORESH_RELAY_ENABLED=true` — does
the client itself only ever *attempt* to reserve through / advertise itself via a relay that is a
camp-admitted peer, or would it attempt to reserve through *any* reachable relay (camp or not) and
rely entirely on the server-side refusal to save it? Red-before-green test design: three real
libp2p nodes — A (client under test, `circuitRelayTransport` enabled), B (a camp-admitted peer
also running `circuitRelayServer`), X (a reachable peer running `circuitRelayServer` but **not**
camp-admitted — simulating a stray non-camp relay). **Red baseline (before the client-side
restriction is implemented):** demonstrate A's `circuitRelayTransport`/`RelayDiscovery` is willing
to attempt a reservation against X (even if X would decline it per its own camp-check, were X
built that way — the point is A should never have *tried*). **Green (after the restriction):** A's
reservation-candidate selection is itself restricted to camp-admitted peers — sourced from the same
admitted-peer set §2 uses for AutoNAT, not from whatever `RelayDiscovery`'s own default peer-store
scan would surface — so A never issues a RESERVE to X at all, independent of whether X would have
granted it. **Test file:** new, `electron/sync/automerge/relayClientCampOnlyReservation.test.js`.

**Precondition 3 — UI surfacing of `RESERVATION_REFUSED`.** `relayRefreshNoGrowth.test.js`
(existing, T337) proves the server-side `maxReservations` cap refuses an over-capacity reservation
request. This precondition requires that refusal to actually reach a director, not merely a log
line — closing the inversion-frame blind spot ("a test that asserts an event fires without
asserting a director sees anything"). Design: the client's relay-reservation failure path (the
same `circuitRelayTransport` client exercised in Precondition 2) must emit a distinguishable,
documented error shape on `RESERVATION_REFUSED` (per `org-interface-contracts`'s error-shape
checklist) that an existing IPC/renderer surface can forward to a visible UI element — reuse the
existing "surface every write failure" pattern this codebase already has for other mutation
failures (same family as the `camper_preferences`/`write` failure-surfacing path), not a new toast
mechanism. Test design must assert the actual rendered/visible state change (per this project's
"Assert the Row, Not the Call" discipline — a webapp-testing or component-level assertion that a
director-visible element appears), not merely that an event was emitted. **Test files:** new,
`electron/sync/automerge/relayReservationRefusedSignal.test.js` (the signal reaching the IPC
surface, real multi-node to trigger the refusal) + a renderer-side test (file TBD by Maker,
depending on which existing screen/component is the right host for this signal — Designer input
may be needed here if no existing surface fits; flagged in Open Questions).

**Honest residual carried forward unchanged: real independently-NATed hardware.** Slice-A §3's
residual — a direct home↔home punch has not been proven on genuinely separate home networks, only
simulated in-process — remains open and is this slice's acceptance criterion to close, not an
assumption to launder into "done." Two real devices on two genuinely separate home networks (not
two processes on one LAN simulating separate networks) must complete a successful dcutr punch as
part of this capability's battle-test evidence.

### 5. Naming-trap constraint (hard constraint on Maker, carried forward from T337's own lesson)

Per `relayEnablement.js`'s own header comment: the literal substrings `dcutr` and `autonat` are in
`ALL_FORBIDDEN_MARKERS()` while `dcutr.signoff` is `null`, and `transportBoundary.guard.test.js`
scans `syncStarter.js`'s **source text** for them. **Any new helper function, variable, or import
alias that Maker introduces in `syncStarter.js` (or any file transitively imported into it) to
express "is the hole-punch foundation present/wired" must avoid those literal substrings** — follow
`relayEnablement.js`'s existing `holePunchFoundationPresent`/`nextRungPresent` naming convention
exactly, do not invent new names that happen to contain `dcutr` or `autonat` as a "more readable"
alternative. This is not a style note; it has already caused one gate-fix round in this program's
own history (T337's round-3 Code Reviewer finding) and will reproduce the identical failure mode if
not held as a constraint from the first commit.

## Files/modules affected

**New files (sketch only — Maker writes the real content, test-first):**
- `electron/sync/automerge/relayRevocationMergePropagation.test.js` — Precondition 1.
- `electron/sync/automerge/relayClientCampOnlyReservation.test.js` — Precondition 2.
- `electron/sync/automerge/relayReservationRefusedSignal.test.js` — Precondition 3 (signal side).
- A renderer-side test for Precondition 3's visible surfacing — path TBD, see Open Questions.
- An AutoNAT camp-peers-only red-before-green test extending T337 §C's pattern, real multi-node
  (name TBD by Maker; suggest `electron/sync/automerge/autoNatCampOnly.test.js` to match the
  existing `relayRoleCampOnly.test.js` naming convention).
- A real-hardware, cross-network dcutr punch proof (not a Vitest file — a manual/scripted
  two-device procedure, documented under `docs/work/security/` as battle-test evidence, same class
  as the 2026-09-06 prototype's documented result).

**Changed files (sketch only, no code written here):**
- `electron/sync/automerge/transportCapabilities.js` — `dcutr` row's `signoff` written only after
  the gate passes (currently `null`, unchanged by this design).
- `electron/sync/automerge/syncStarter.js` — dcutr/AutoNAT wiring added behind the same
  `holePunchFoundationPresent()`-style presence check pattern already established for relay; must
  not introduce the naming trap in §5.
- `electron/sync/automerge/transport.js` — the AutoNAT service configuration (§2), reusing the
  existing `authenticatedPeers`/admission closure the relay gater already holds.
- `electron/sync/automerge/relayEnablement.js` — no change expected (its existing
  `holePunchFoundationPresent` probe already does exactly what this slice needs it to do once the
  packages are installed); Maker should confirm, not assume, that no change is needed here once the
  real packages are added to `package-lock.json`.
- Whatever existing IPC/renderer failure-surfacing path Precondition 3 reuses — file TBD by Maker.

**No schema migration.** This slice adds no persisted shape; `peer_last_addresses` (Slice 1) and
the relay reservation store (T337, in-memory/libp2p-internal) are both reused unchanged.

## Reused vs. new

**Reused, unchanged:** `peerAddressBook.js`'s `redialTrustedPeers`/stale-address-safety (Slice 1);
T337's **landed** coordination relay (`circuitRelayServer`/`circuitRelayTransport` wiring,
`relayRuntimeEligible`, the standing-reservation behavior, the `authenticatedPeers`-closure
admission gating pattern this slice's AutoNAT config reuses directly); `authorityReplay.js`'s
`currentRevokedDeviceIds` and `syncNode.js`'s `authorize()`/`isPeerRevoked` (T331, untouched);
`transportCapabilities.js`'s registry mechanism itself; the existing "surface every write failure"
UI pattern Precondition 3 extends rather than reinvents.

**New:** the dcutr/AutoNAT wiring itself (the one piece of actual new transport code this slice
adds); the AutoNAT camp-scoping configuration (§2 — new wiring reusing an existing admission
closure, not new admission logic); the three BLOCKING-precondition tests (§4); the real-hardware
cross-network punch proof. Nothing here duplicates a primitive that already exists — the design
was checked against T337's landed code specifically to confirm the coordination channel slice-A's
Open Question §1 worried about missing is, in fact, already built and already gated correctly on
this slice's own presence.

## ADR required: no

No new persistent data shape, no new IPC/wire contract, and no reversed tradeoff is introduced by
this document — it operates entirely within the already-accepted ADR
(`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`) and the already-established per-capability
registry mechanism (`transportCapabilities.js`, itself governed by the 2026-09-14/2026-09-27 ADRs).
The one load-bearing judgment call this document makes — AutoNAT camp-scoping reuses T337's
existing admission closure rather than introducing a second mechanism — is a reuse decision, not a
new architectural commitment, and is easily revisited without consequence if Maker finds a cleaner
seam during implementation.

## Open questions for Governor

1. **The AutoNAT presence/liveness cadence finding (§3).** This document's own recommendation is
   that this does not rise to the level of "exposure not already accepted" and does not need a
   fresh owner ruling before the gate proceeds. Confirm Governor agrees with that read, or wants it
   escalated to the owner explicitly before Maker is briefed — this is the one place in this
   document where a reasonable second reader could land differently, and per the standing
   design-time-exposure rule it should be a deliberate confirmation either way, not a silent pass.
2. **Where Precondition 3's director-visible surfacing actually lives.** This design names the
   requirement (a real, visible signal, not a log line) and the pattern to extend ("surface every
   write failure"), but does not pick a specific screen/component — that may need Designer input
   if no existing failure-surfacing UI element is the natural host for a relay-capacity-exhausted
   signal (this condition is rare — only relevant for camps near or above 8 devices simultaneously
   needing relay coordination — so a lightweight treatment, e.g. folded into an existing
   connectivity/sync-status area, may be all it needs; Governor's call on whether this is
   UI-significant enough to route through Designer before Maker, or small enough for Maker to pick
   a reasonable host directly).
3. **Real independently-NATed hardware availability.** The real-hardware cross-network punch proof
   needs two devices on genuinely separate home networks. Confirm who/what provides this test
   environment (the owner's own devices, a cloud-VM-plus-real-home-network pairing, or something
   else) before this slice's battle-test evidence can be considered complete — this is a logistics
   question, not a technical one, and this document cannot resolve it.
