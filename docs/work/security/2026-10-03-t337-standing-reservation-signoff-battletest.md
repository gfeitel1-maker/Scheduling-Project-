---
title: "T337 — standing-reservation reality: deep security battle-test for capability signoff"
document_type: security
authority: evidence
status: active
task_class: security-auth
created: 2026-10-03
assessed_commit: 598b1921
supersedes_framing_of: docs/work/security/2026-10-03-t337-relay-capability-assessment.md
governing_docs: [docs/work/specs/2026-10-03-t337-coordination-layer-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md, electron/sync/automerge/transportCapabilities.js]
archive_when: the T337 relay(coordination) capability records its final signoff decision
---

# SECURITY ASSESSMENT — T337 (camp-peer circuit-relay-v2 coordination, standing-reservation reality)

Date: 2026-10-03   Assessed against commit: 598b1921 (branch claude/t337-coordination-build, NOT merged)

Assessed with security-review (surface map), systematic-debugging (traced each hop entry→effect),
bdi-mental-states (adversarial toward the trusted-LAN boundary and the standing-reservation tradeoff),
verification-before-completion (ran all 29 relay battle-tests + the Tier-4 guard + probed the installed
library version; confirmed-vs-open split below). Assessor: Opus 4.8 (security-assessment profile).
Installed: @libp2p/circuit-relay-v2@4.2.13. `npm audit --omit=dev`: 0 vulnerabilities.

This re-opens my earlier 4/5 PASS-conditional (f4c4e83b / commit 227187bb) against two changes: (1) the
design now honestly documents the reservation as STANDING + bounded, not "disposable ~2min"; (2) the F-1
enablement gate is now mechanized. The owner's conditional YES delegates safe/secure/reasonable to this
battle-test.

## What my prior 4/5 hinged on, and what the corrected design changes

The 5th point — the single reason it was not 5/5 and not unconditional — was **F-1**: nothing MECHANICAL
tied runtime enablement (`SHORESH_RELAY_ENABLED=true`) to the hole-punch foundation (T336 dcutr) existing.
Enabled alone, a camp peer becomes a STANDING traffic relay — the owner's RARE tier-3 role silently
installed as normal operation. Conditions C2 (client auto-reservation camp-only), C3 (end-to-end relayed
admission), C4 (pre-auth rate-limit sizing for internet scale) were the supporting open items.

**The honest standing-reservation framing does not weaken the verdict — it sharpens exactly why F-1 is the
load-bearing control, and F-1 is now closed.** My prior read assumed the reservation was shorter-lived. It
is not: `@libp2p/circuit-relay-v2@4.2.13`'s client transport auto-refreshes the reservation every ~30s for
as long as it stays connected to R, and the server's `reserve()` resets the TTL on refresh while bypassing
`maxReservations` for an existing reservation. So a reservation is a STANDING, perpetually-renewed
camp-internal slot. The consequence that matters: **enabled WITHOUT dcutr, the standing reservation makes R
the ONLY path indefinitely** — precisely the "standing traffic relay" the owner reserves for the rare case.
The corrected design confronts this honestly (design §B round-3 correction; `syncStarter.js:359-377`
comment rewritten to drop the false "disposable" claim) and mechanizes the fix:

- `relayEnablement.js#relayRuntimeEligible` requires `relayEnabled && nextRungPresent`, where
  `holePunchFoundationPresent()` actually imports `@libp2p/dcutr`/`@libp2p/autonat`. Today neither resolves,
  so a bare flag flip CANNOT construct `relayServerFactory`/`relayTransportFactory`
  (`syncStarter.js:381-395`). Proven: `relayEnablementIntegration.test.js` — "flag ON but dcutr absent →
  startSyncNode receives NO relay factories."
- `dcutrPresenceWithoutSignoff.guard.test.js` (Tier-4 sibling) closes the presence-not-signoff gap: either
  both dcutr packages are absent from the resolved tree OR `dcutr.signoff` is non-null. Red-before-green
  non-vacuity proven. This stops the window where T336 lands the packages but `dcutr.signoff` is still null
  from silently flipping relay eligible.

This is the right shape: `signoff` authorizes CODE MERGE (inert); the dcutr coupling + guard withhold
RUNTIME promotion to a data path until the foundation it exists to serve is itself present and reviewed.

## Boundary verdict

**Trusted-LAN boundary: HOLDS in running code. The capability is correctly inert at this commit.** The
Tier-4 `transportBoundary.guard.test.js` is RED on exactly two assertions — @libp2p/circuit-relay-v2 present
in the tree, and the `circuitRelay` marker present in syncStarter.js — both correct for "code landed,
signoff withheld." `relay.signoff` is `null` (`transportCapabilities.js:34-39`). With the flag unset AND
dcutr absent, the node is byte-identical to pre-T337 (TCP + Noise + Yamux + mDNS). The boundary moves only
at `SHORESH_RELAY_ENABLED=true`, which is now impossible to reach effectively while dcutr is absent.

## Per-criterion verdict (owner's HARD criteria)

### (i) NO DATA EXPOSURE — **PROVEN**
R is a blind forwarder. Relayed traffic is Noise ciphertext end-to-end; R holds no session key (forward-only
relay role in v4.2.13, re-confirmed). Each relayed STREAM is capped at 128 KiB / 2 min
(`defaultDataLimit: 131072n`, `defaultDurationLimit: 120000`, `syncStarter.js:387-392`). The standing nature
of the RESERVATION does not change this — a reservation is a reachability slot, not a data channel; data
only flows as capped streams. R learns B/C are online + their reflexive addresses — facts R already holds
standing to as an authenticated fellow camp member. No camp data to R or any third party. No new
confidentiality category versus a direct camp connection.

### (ii) NO HARMFUL DEVICE EXPOSURE — **PROVEN for the controls that exist; one residual is CONDITIONAL**
- Camp-admitted-only on BOTH sides, fail-closed: `isPeerAdmittedForRelay` defaults to `() => false`
  (`transport.js:90`) and is reassigned to read the live `authenticatedPeers` set only after
  `registerAuthGate` (`transport.js:165`). `denyInboundRelayReservation` refuses a RESERVE from a
  non-admitted peer; `denyOutboundRelayedConnection` refuses a CONNECT unless BOTH requester and destination
  are admitted (`transport.js:127-135`). Proven with red-before-green + non-vaciety + revoke
  (`relayRoleCampOnly.test.js`, 5 tests). These are circuit-relay-v2's own extension points, not an
  app-side afterthought.
- Resource/DoS bound incl. refresh-bypass: `maxReservations: 8` explicitly (`syncStarter.js:379,391`) caps
  NEW reservations; the library's refresh-bypass only RENEWS existing ones, so it cannot grow the slot count
  past 8, and only camp-admitted peers can hold any slot at all. A camp is a few devices; 8 standing slots
  is ample and bounded. A stranger cannot obtain even one (gater). The refresh-bypass therefore cannot
  exhaust R's slots.
- Revoked-device eviction severs every hop + blocks re-reservation: `revokePeer`
  (`transport.js:483-499`) deletes from `authenticatedPeers` (severing broadcast + the per-stream
  `node.handle` admission check, which is opted into for limited/relayed connections at `transport.js:194`)
  AND evicts the standing reservation via `reservationStore.removeReservation`. Re-reservation is blocked by
  the gater reading live state. Proven end-to-end: `relayCoordinationWindow.test.js` ("revokePeer evicts →
  later CONNECT gets NO_RESERVATION, not merely PERMISSION_DENIED"), `relayRevokeWhileRunning.test.js`
  (revoke mid-session, both revoked-requester and revoked-destination), `relayEndToEndRevoke.test.js` (B
  dials C THROUGH R over a REAL circuit-relay-v2 connection; admission on C gates it exactly like a direct
  connection — this closes prior condition C3).
- No public presence from a standing reservation — **PROVEN for server role, CONDITIONAL for client role.**
  No publish-to-unbounded-population step exists (contrast the rejected DHT provide/findProviders). R's
  reservation gater sits behind the Noise mutual-auth + admission handshake, so an external scanner that
  dials R learns only "a libp2p/Noise node is listening" — true of any node, relay or not — and cannot
  obtain a reservation or a relayed connection. The RESIDUAL: circuit-relay-v2's CLIENT transport
  (`circuitRelayTransport()`) auto-reserves on connected peers advertising the HOP codec. In THIS deployment
  the connected-peer set is camp-admitted-only (no public bootstrap/DHT is wired), so the client should only
  ever auto-reserve on camp peers — but this is established by DEPLOYMENT INFERENCE, not by an explicit
  red-before-green test (prior condition C2, still open). This cannot matter until runtime enablement, which
  is gated to T336.

### (iii) REASONABLE — **PROVEN for merge-inert; the never-primary runtime property is carried to T336**
Relay-never-primary is enforced by construction: activation is coupled to dcutr presence, and once dcutr
exists the direct punched path is primary with the standing reservation as an idle fallback (design §B).
The documentation is now honest (the false "disposable 2min" framing is struck in both the design and the
syncStarter.js comment; the naming-trap comment prevents a future rename from tripping the dcutr guard
marker). Rotating/empirical R selection (`selectCoordinationCandidates`, camp-only, capped, revoke-rechecked
— `relayCoordination.test.js`) avoids a de-facto permanent host. The "never-primary at runtime" property
itself is only fully demonstrable once T336 makes dcutr primary — that is T336's assessment, not T337's.

## Confirmed findings (ranked by leverage)

- **F-1 (prior HIGH) — NOW CLOSED.** The enablement gate is mechanized (`relayEnablement.js` +
  `dcutrPresenceWithoutSignoff.guard.test.js`), not prose. Evidence: `relayEnablementIntegration.test.js`,
  `dcutrPresenceWithoutSignoff.guard.test.js` (both green, non-vacuity proven). No residual runtime vuln.
- **F-2 (LOW, unchanged) — volunteer-relay abuse is real but well-bounded and not a materially new insider
  threat.** A malicious admitted R can refuse to broker (availability only) or see metadata it is already
  camp-entitled to. It cannot read relayed traffic (ciphertext). `maxReservations` is now set explicitly to
  8 (prior assessment's only F-2 recommendation), closing the "left at library default 15" note.

## Open questions (NOT findings — settle at the T336 runtime-enable gate, before SHORESH_RELAY_ENABLED=true)

- **C2 — client auto-reservation population.** Confirm by explicit red-before-green test that the enabled
  client auto-reserves/advertises only via camp-admitted peers (the client-role analogue of the proven
  server-role scoping). Today sound by deployment inference (no public discovery wired), not by test.
- **C4 — pre-auth sizing.** Re-confirm `rateLimit.js`/`authGate.js` are sized for internet-scale connection
  attempts an internet-reachable relay invites, not LAN scale, before the flag is ever set true. Same C4
  condition the T334 DHT slice raised.

## Re-opened tradeoffs

- **Standing reservation vs "no standing relay" owner line.** Conditions when the "rare fallback" framing
  was accepted: the relay was believed transient/per-attempt. That belief is FALSE against v4.2.13 (the
  reservation is standing + auto-renewed). Do the conditions still hold? The owner's concern — a camp device
  silently becoming a standing traffic relay — is real and is exactly what enabling T337 ALONE would do.
  Recommendation: the standing-but-bounded reservation is acceptable BECAUSE it is (a) camp-admitted-only,
  (b) capped at 8 slots, (c) carries only capped ciphertext streams, (d) evicted on revoke, AND (e)
  mechanically prevented from being the PRIMARY path until dcutr exists. (a)-(e) together are what make
  "standing" safe; without (e) it would not be. (e) now exists.
- **No-TLS / Noise-only on the wire.** Still holds: end-to-end Noise + mutual auth; R forwards ciphertext,
  holds no key. Unaffected by opening the coordination relay.
- **Plaintext-PIN-on-wire.** Not reachable over this path (PIN is local `attemptLogin`, never transmitted).
  Unimplicated.
- **Trusted-LAN deployment boundary.** Does not break at this commit (flag default false, dcutr absent).
  The containment that carries the load once enabled is admission (`authenticatedPeers`) + the live gater +
  the per-stream cap + the 8-slot cap — NOT reachability.

## Verdict

**PASS for capability signoff (CODE MERGE, inert) — CONDITIONAL.** The code being signed off exposes no
data and no device: with the flag unset and dcutr absent, the node is byte-identical to pre-T337, and the
Tier-4 guard + dcutr-presence coupling make runtime activation unreachable without T336. Against the owner's
test ("if it exposes data or exposes the computer in a way that would be at any level harmful, then no"):
the merged inert code exposes nothing; the capability, when eventually enabled alongside a signed-off T336,
is safe/secure/reasonable PROVIDED C2 and C4 are closed at that runtime-enable gate — which the mechanism
now forces rather than trusting to discipline.

The prior 4/5 blocker (F-1) is closed and test-proven. C3 is closed. The honest standing-reservation framing
does not introduce exposure I would not previously have accepted — it bounds to 8 camp-admitted slots of
ciphertext-only reachability, evicted on revoke — and it makes the F-1 mechanization the correct, necessary,
and now-present control. Remaining residuals (C2, C4) are runtime-enable conditions, not merge blockers.

**Security posture: 4 / 5.** Not 5/5 only because two conditions (C2 explicit client-side scoping test; C4
internet-scale pre-auth sizing) remain to be closed before `SHORESH_RELAY_ENABLED=true` in any real build —
both correctly deferred to the T336 gate and both mechanically blocked until then. This is a PASS to merge
inert and write the `relay` signoff with those two conditions recorded in it; it is NOT authorization to set
the runtime flag true.

## Signoff decision

_Addendum appended at signoff time. The body above was assessed against `598b1921`; this section records
the owner authorization lineage, the consolidated evidence map at the signoff commit (which adds two proofs
that postdate `598b1921`), the deferred set, and the Grader provenance caveat — so a future reader has the
whole basis in one place, not inferred from a commit diff._

### Owner authorization lineage (not a hand-signature)

The owner did NOT hand-sign this capability. He gave a **conditional YES** on 2026-10-03 and DELEGATED the
safe/secure/reasonable determination to this security + battle-test gate (his T327 delegation). His ruling,
verbatim:

> "if it is safe, secure, and reasonable, then yes i agree. if it exposes data or exposes the computer in a
> way that would be at any level harmful, then no."

The gate PASSED under that condition (every (i)/(ii)/(iii) sub-property PROVEN at the merge-inert level, no
confirmed vulnerability, three reviewers converging: Security 5, Red Hat 4/5, Security-Assessment 4/5; Grader
4.0 PASS_ELIGIBLE). The organizer accepted on the passed gate and spot-checked the evidence package before
the signoff was written. The `owner` field in the `relay` signoff entry therefore records this gate lineage,
not a personal name.

**Scope of this signoff:** coordination/signaling only. Primary-data-path use is gated on the `dcutr` (T336)
signoff, which remains `null`. This entry authorizes the CODE MERGE of the inert capability; it is NOT
authorization to set `SHORESH_RELAY_ENABLED=true`.

### Consolidated evidence map — each owner sub-property → test (file:line), at signoff commit

Assessed-against `598b1921`; evidence re-run green at the signoff commit, which adds the two refresh/byte-cap
proofs below (they postdate the body above).

- **(i) no data exposure** — blind-forwarder / R holds no key: installed `@libp2p/circuit-relay-v2@4.2.13`
  `transport/index.js` (B↔C upgrade runs end-to-end) + `server/index.js` `createLimitedRelay` (raw byte
  pipe); `host_signing_key` has zero references in the relay surface (`transport.js`, `syncStarter.js`,
  `relayEnablement.js`). Payload intact through a real R: `relayEndToEndRevoke.test.js:77-80`. Per-stream
  128 KiB / 2 min cap wired: `syncStarter.js:387-392`. **>128 KiB byte-cap fires (behavioral, new):**
  `electron/sync/automerge/relayByteCap.test.js` — under-cap delivers byte-identical, over-cap aborts;
  red-before-green proven by raising the limit to 10 MiB.
- **(ii)(a) bounded resource / refresh-bypass can't exhaust** — cap enforced live:
  `relayCoordinationWindow.test.js:112-135`; TTL 120000 vs library 2h default: `:63-110`. **Refresh-non-growth
  (regression pin, new):** `electron/sync/automerge/relayRefreshNoGrowth.test.js` — a single peer's repeated
  RESERVE stays flat at reservation count 1 while distinct peers grow to the cap and the (N+1)th gets
  `RESERVATION_REFUSED`; red-before-green proven by a planted `toBe(999)` against the live value 1. This is
  now a repo test pinned against a future `@libp2p/circuit-relay-v2` version bump, not a library-source read.
- **(ii)(b) camp-admitted-only both sides, fail-closed, standing case** — `relayRoleCampOnly.test.js`
  (RED baseline + GREEN + live admit-flip), connect side both src+dst `transport.js:127-135` proven by
  `relayRevokeWhileRunning.test.js`; fail-closed default `transport.js:90` (`isPeerAdmittedForRelay = () => false`).
- **(ii)(c) no public presence/address from a standing reservation** — LAN-bound listen, no public
  rendezvous/DHT in the relay wiring; `relay.egressAllowlist` is empty. Server-role PROVEN; client-role is
  C2, deferred (below).
- **(ii)(d) revoke evicts every hop + blocks re-reservation** — slot eviction
  `relayCoordinationWindow.test.js` (revoke → later CONNECT `NO_RESERVATION`); severs open relayed hop
  `relayEndToEndRevoke.test.js`; re-reservation refused `relayRoleCampOnly.test.js`. The merge-PROPAGATED
  revoke chain to a third relay node R is proven by code-reading, not test → deferred to T336 precondition #1.
- **(iii) reasonable / never-primary / honest doc** — triple blockage: `relay.signoff` + `SHORESH_RELAY_ENABLED`
  default false + `relayRuntimeEligible` requires `holePunchFoundationPresent()` (false today;
  `relayEnablement.test.js:21-23`), proven at real wiring by `relayEnablementIntegration.test.js:83-96`;
  `dcutrPresenceWithoutSignoff.guard.test.js` (4 green). Honest doc: `syncStarter.js:356-380`, design §B/§E.

### Deferred to the T336 runtime-enable gate — recorded as HARD BLOCKING preconditions

Recorded in `docs/work/tickets/T336-nat-holepunch-dcutr.md` (`archive_when` + "BLOCKING preconditions"
section); the `dcutr`/`autonat` signoff cannot be written until all three are proven on real multi-node:
(1) every-hop revocation over the REAL merge-propagated revoke chain to a third relay node R; (2) client-side
camp-only auto-reservation (C2), red-before-green at enable time; (3) UI surfacing of `RESERVATION_REFUSED`
for a >8-device camp that exhausts slots once enabled. Plus C4 (internet-scale pre-auth sizing of
`rateLimit.js`/`authGate.js`). None can bite before T336 passes its own gate (four-way containment:
flag-default-false + `holePunchFoundationPresent()` false until dcutr resolves + the `dcutrPresenceWithoutSignoff`
guard + `dcutr.signoff` null).

### Grader provenance caveat (recorded, not buried)

The consolidated Grader verdict (4.0, PASS_ELIGIBLE, "all gaps are runtime-enable conditions deferrable to
T336; none are merge blockers; merged inert code exposes no data and no device") rests on gates the Grader
**re-ran itself** (relay suite 25→29/29 pass; Tier-4 boundary guard red by design; signoffs null). The
GateReport reducer's mechanical provenance-binding step did NOT run, because a subagent Grader cannot read the
parent Governor session's dispatch transcript to bind the three opinion reports to their dispatches. This is a
tooling limitation, not a substantive gap. CI on the signoff PR — the gate of record — is the authoritative
backstop over the local Grader, and the organizer reads the signoff diff and confirms CI green before merge.
