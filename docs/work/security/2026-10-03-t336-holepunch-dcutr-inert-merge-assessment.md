---
title: "T336 NAT hole-punch (dcutr-only) — deep security assessment for inert-merge signoff"
document_type: security-assessment
status: complete
created: 2026-10-03
assessed_commit: b163732e75246e4813a88874d2338b3edf57765d
scope: T336 dcutr-only hole-punch capability — inert merge verdict + pre-activation go-live preconditions
assessor: security-assessment (Opus 4.8)
governing_docs:
  - docs/work/specs/2026-10-03-t336-holepunch-build-design.md
  - docs/adr/2026-09-14-internet-transport-security-gate.md
  - docs/adr/2026-10-02-wan-discovery-transport-ladder.md
  - docs/work/security/2026-10-03-t337-standing-reservation-signoff-battletest.md
---

# T336 hole-punch (dcutr-only) — deep security assessment

Date: 2026-10-03  Assessed against commit: b163732e75246e4813a88874d2338b3edf57765d

This is the real runtime-activation-enabler assessment: once this merges (inert) and a later
operator flips `SHORESH_RELAY_ENABLED`, camps use cross-network relay + dcutr hole-punch. The two
events are assessed SEPARATELY, as the task requires.

## Boundary verdict

Trusted-LAN boundary: **HOLDS for the inert merge; the merge does NOT itself cross it.**

Evidence (all traced in code at the assessed commit, not inferred):
- Discovery remains mDNS-only unless `SHORESH_RENDEZVOUS_URL` is set (syncStarter.js:335-349);
  rendezvous is a separate, already-signed-off discovery capability and is unchanged here.
- The relay + dcutr factories are BOTH gated behind a single `relayEligible` computed as
  `relayRuntimeEligible({ relayEnabled, nextRungPresent: await holePunchFoundationPresent() })`
  (syncStarter.js:386-419). `relayEnabled = process.env.SHORESH_RELAY_ENABLED === 'true'`
  (default unset/false). `relayRuntimeEligible` is a pure AND of both inputs
  (relayEnablement.js:29-31). With the flag unset, `relayEligible` is false, so NEITHER
  `await import('@libp2p/circuit-relay-v2')` NOR `await import('@libp2p/dcutr')` executes, and
  `relayServerFactory`/`relayTransportFactory`/`directUpgradeServiceFactory` are all `undefined`
  when passed to `startSyncNode`. transport.js then wires none of them (the `...(factory ? {} : {})`
  spreads at transport.js:188, 234, 235 contribute nothing).
- There is no auto-activation path: nothing in the tree flips the default or sets
  `SHORESH_RELAY_ENABLED` for the user. Confirmed by reading the only two consumers of the flag
  (syncStarter.js:386 and the relayEnablement unit boundary). Activation is a deliberate operator
  act.

When ACTIVATED (flag true), the device becomes internet-reachable via the T337 relay and dcutr
punch. That is the second event; the boundary is deliberately crossed there and is governed by the
pre-activation preconditions below. dcutr itself, once active, introduces no new exposure CLASS or
AUDIENCE beyond T337 (already signed off) + Slice-1 — see "Re-opened tradeoffs."

## Confirmed findings (ranked by leverage)

### 1. Inert merge is effect-equivalent to pre-T336 at the flag default — CONFIRMED SAFE (not a defect; the central thing to confirm)
- Location: syncStarter.js:386-419; relayEnablement.js:29-65; transport.js:188/234/235;
  holePunchInertnessWithPackages.test.js.
- Attack path considered: does merely having `@libp2p/dcutr` resolvable in the build change any
  runtime behavior while the flag is off? Traced: the only effect of package presence is
  `holePunchFoundationPresent()` returning true (relayEnablement.js:57-65, via `require.resolve`,
  which never executes the package). `relayRuntimeEligible` still requires `relayEnabled`, so the
  dcutr/relay imports never run and no service is wired.
- Confirmed how: ran holePunchInertnessWithPackages.test.js at this commit — all 3 cases pass:
  (a) non-vacuity, `@libp2p/dcutr` IS resolvable (so inertness is not trivially true);
  (b) flag default → `relayServerFactory`/`relayTransportFactory`/`directUpgradeServiceFactory`
  all `undefined`; (c) flag ON → all three ARE produced (proves the OFF result is a real gate, not
  broken wiring). This is the deterministic proof of byte-equivalent-in-effect inertness.
- Fix: none required for the merge.

### 2. The three capability-guard reds are the capability provably blocked — CONFIRMED CORRECT
- Location: dcutrPresenceWithoutSignoff.guard.test.js; transportBoundary.guard.test.js (x2:
  package-presence assertion + syncStarter.js source-marker assertion, the literal `dcutr` at
  syncStarter.js:417).
- Confirmed how: ran dcutrPresenceWithoutSignoff.guard.test.js — fails exactly as designed
  ("@libp2p/dcutr present ... while dcutr.signoff is still null"). The test's own message documents
  that this red IS the blocked state and flips green in the same change that writes the signoff at
  gate-pass. Consistent with the deterministic `npm run verify` state reported (fails only at
  `test`, only on these 3 reds).
- Fix: none — writing `dcutr.signoff` is the gate-pass act, out of scope for this inert assessment
  (and explicitly not something I wrote).

### 3. C4 pre-auth AUTH_PROTO frame cap is genuinely WIRED, not just declared — CONFIRMED FIXED
- Location: wireProtocol.js:65 (`AUTH_MAX_FRAME_BYTES = 64 * 1024`); authGate.js:200 (AUTH_PROTO
  handler), :203 (receiveFramed), :392 (`{ maxDataLength: AUTH_MAX_FRAME_BYTES }`).
- Attack path (real DoS this closes): an UN-admitted peer dialing AUTH_PROTO could previously force
  up to `MAX_FRAME_BYTES` (32 MiB) of buffering per connection before any admission decision,
  amplified by `MAX_CONNECTIONS` concurrency. Now bounded to 64 KiB (~500x reduction), generous over
  the largest real auth payload (a signed join_confirm, <1 KiB).
- Confirmed how: traced the constant from definition to the exact AUTH_PROTO receive call site;
  it is applied on the handler an un-admitted peer reaches first. The systematic-debugging concern
  (constant defined but not enforced) is ruled out — it IS enforced.
- Fix: none. Note this hardens pre-auth memory on ALL transports, LAN included — a defense-in-depth
  gain independent of activation.

### 4. P1/P2/P3 preconditions are genuinely proven real-multi-node, red-before-green — CONFIRMED
- P1 relayRevocationMergePropagation.test.js: real libp2p nodes (createLibp2p + startTransport +
  circuitRelayTransport); RED = a revoke minted on D that never merge-propagates leaves B connected
  AND reserved; GREEN = a revoke that merge-propagates D->R via the ORDINARY Automerge sync path
  triggers R's OWN merge observer (not a test harness calling `revokePeer`/`tearDown` directly) to
  tear B down at both admission and reservation. This closes precisely the blind spot the design's
  inversion-frame flagged ("a revoke test that calls revokePeer directly on the relay proves
  nothing about propagation").
- P2 relayClientCampOnlyReservation.test.js: RED = a plain unrestricted circuitRelayTransport
  reserves through ANY reachable relay; GREEN = transport.js's wrapped client never reserves through
  non-admitted X even though X would grant it; plus a non-vacuity case (still reserves through an
  admitted relay). Client-side candidate restriction closes over the SAME `isPeerAdmittedForRelay`
  set as the server gater (transport.js:99-169), not a second copy.
- P3 relayReservationRefusedSignal.test.js (signal side, real multi-node, genuine RESERVATION_REFUSED
  at capacity) PLUS the director-visible half wired end-to-end: syncStarter.getRelayReservationRefused
  -> main.js makeHandlers:326/894/925 getSyncStatus payload -> src/components/layout/sidebarState.js
  + Sidebar.test.jsx. The "assert the row, not the call" discipline is satisfied — a director-visible
  element, not merely an emitted event.
- Fix: none for the merge. These are activation-gate proofs and are in good shape.

## Open questions (NOT findings — need investigation before confirm/drop)

- **npm audit posture of the dcutr subtree.** I confirmed dcutr@3.0.28 is pure JS with only
  standard libp2p-ecosystem transitive deps already present in the tree (interface, utils,
  multiaddr(+matcher), protons-runtime, uint8arraylist, delay) — no new native module, no
  postinstall. I did NOT run `npm audit` in this pass (the task scoped me off full verify). What
  would settle it: a targeted `npm audit` focused on the dcutr subtree before activation. Low
  concern for the inert merge (code never loads when inert); worth a one-line check at the
  activation gate.
- **Real independently-NATed hardware punch.** The design itself carries this as the acceptance
  criterion to close (two devices on genuinely separate home networks completing a dcutr punch),
  not yet done. This is a pre-activation precondition, not an inert-merge blocker. What would settle
  it: the documented two-device cross-network battle-test evidence under docs/work/security/.

## Re-opened tradeoffs

- **Trusted-LAN boundary (ADR 2026-09-14).** Conditions when accepted: sync reachable only on the
  local network (mDNS-only discovery, NAT-blocked inbound). Do they still hold? For the inert merge,
  YES — nothing in this change makes the node internet-reachable at the flag default. At ACTIVATION
  the boundary is deliberately crossed; the ADR's own mandatory re-assessment list (TLS/plaintext-PIN,
  relay trust, rate limits + MAX_CONNECTIONS, update integrity, CRDT role enforcement) is the correct
  gate and remains the governing checklist. Recommendation: the inert merge does not expire the
  boundary; activation does, and must clear the pre-activation list below.
- **Plaintext PIN on wire / no TLS.** Conditions: PIN travels inside the Noise channel between
  authenticated peers; acceptable on-LAN. Still hold? For dcutr specifically — YES, unchanged: a
  dcutr-upgraded connection is byte-identical from syncNode.js down (same Noise, same
  authorize()/isPeerRevoked), per design §1.5. dcutr changes connectivity, not the auth layer. No
  new PIN exposure. Recommendation: no change needed by this slice; the join-secret hardening
  (ADR 2026-09-15 blocker #1) remains the separate WAN-join concern it already was.
- **Relay-as-blind-forwarder (R).** Conditions: R brokers Noise ciphertext, holds no camp key,
  cannot read/forge traffic. Still hold? YES — dcutr adds only a CONSUMER of the channel R already
  provides under T337; the punch exchanges reflexive addresses between the camp peer PAIR, and the
  relayed bytes remain Noise ciphertext. No new fact for R. Confirmed against design §3 and
  transport.js (R has no decryption path).

## Pre-activation go-live preconditions (explicit)

These do NOT block the inert merge; they are mandatory before `SHORESH_RELAY_ENABLED=true` ships:
1. **MAX_CONNECTIONS=200 DoS mitigation (transport.js:46).** Classification: LATENT-UNTIL-ACTIVATION.
   It cannot bite while inert — with the flag off there is no inbound internet path (mDNS-only
   discovery + NAT), so the 200 global ceiling is unreachable from a hostile internet population.
   At activation the device becomes internet-reachable and a distributed flood from many source IPs
   (the per-source connectionRateLimiter bounds per-IP, not aggregate) could exhaust 200 slots and
   deny service to legitimate camp peers — this touches the owner's "harmful to the computer" bar.
   Mitigation shape to scope: (a) reserved-slot floor for already-admitted/camp peers so a flood of
   un-admitted connections can never starve camp sync; (b) connection priority / early-drop for
   un-admitted sources once above a low watermark; (c) an aggregate (not only per-source) inbound
   cap sized for hostile scale, with admitted peers exempt. The C4 64 KiB pre-auth cap already
   reduces per-connection memory amplification ~500x, which is complementary but not a substitute
   for a connection-count mitigation.
2. **Real independently-NATed cross-network dcutr punch evidence** (design acceptance criterion).
3. **T337 carried conditions C2 + C4 re-confirmed at this gate** (transportCapabilities.js:50-53):
   client-side camp-only auto-reservation (P2 now proves it) and internet-scale pre-auth sizing
   (C4 now adds AUTH_MAX_FRAME_BYTES; confirm rateLimit.js/authGate.js caps are internet-sized).
4. **Targeted npm audit of the dcutr subtree** (open question above) — cheap, do at the gate.
5. **ADR 2026-09-14 full re-assessment items not owned by this slice remain owner decisions**:
   signed/integrity-checked auto-update (an internet-facing Electron app without it is an RCE
   vector), and the internet-scale libp2p rate-limit review.

## INERT MERGE VERDICT: PASS

The inert merge is safe to land. It is proven effect-equivalent to pre-T336 at the flag default
(deterministic test evidence), exposes no data and no device while inert, has no auto-activation
path, and carries no new supply-chain surface that loads while inert. The 3 guard reds are the
capability correctly held blocked and flip green only when the signoff is written at the activation
gate. dcutr.signoff MUST remain null until the pre-activation preconditions above are met; writing
it is a separate act gated on those, and was not performed in this assessment.

## Summary Score (for Grader)
Security posture: 4 — The inert merge is cleanly gated, deterministically proven effect-equivalent
to pre-T336, and introduces no new exposure while the flag is default-false; the one material
activation-time risk (MAX_CONNECTIONS DoS on an internet-facing node) is correctly latent and
captured as a hard pre-activation precondition rather than silently carried.

## Signoff decision

_Appended at signoff time. Records the authorization lineage, the correct meaning of the signoff,
the consolidated gate result, the full pre-activation precondition list, and the Grader provenance
caveat — so a future reader has the whole basis in one place._

**Correction to the body's phrasing:** passages above say "dcutr.signoff MUST remain null until the
pre-activation preconditions are met." That was the assessor's view; it is SUPERSEDED here by the
organizer's gate ruling. `dcutr.signoff` is a BUILD/MERGE gate, not a runtime gate — production code
never reads it at runtime (relayEnablement.js's contract). Writing it authorizes the **inert code
merge** and flips the three dcutr guard reds green; it does **not** activate anything. Runtime
activation is `SHORESH_RELAY_ENABLED` (default false), a separate owner go-live gated on the
pre-activation preconditions below. So the signoff is written NOW, at this gate pass; the
preconditions gate the FLAG FLIP, not the signoff.

### Owner authorization lineage (not a hand-signature)

The owner did not hand-sign this. He gave a 2026-10-03 **conditional YES** — "if it is safe, secure,
and reasonable, then yes... if it exposes data or exposes the computer in a way that would be at any
level harmful, then no" — and DELEGATED the determination to this security + battle-test gate (T327
delegation). The gate PASSED for the INERT MERGE (Security-Assessment 4, Security 5, Red Hat 4,
Grader consolidated PASS; no confirmed vulnerability; inert merge proven to expose no data and no
device). The organizer independently spot-checked the branch (not just the report) and accepted. The
`dcutr` signoff `owner` field records this gate lineage, not a personal name.

**Scope:** coordination/hole-punch, code-merge-inert. Runtime activation
(`SHORESH_RELAY_ENABLED=true`) is NOT authorized by this entry; it is gated on the pre-activation
preconditions below plus a separate owner go-live.

### Grader provenance caveat (recorded, not buried)

The consolidated Grader verdict rests on gates the reviewers and Grader **re-ran themselves** (the
relay/guard suites; full `npm run verify` which fails only on the 3 expected dcutr guard reds with
705 files passing and all other steps green). The GateReport reducer's mechanical provenance-binding
step did NOT run — a subagent Grader cannot read the parent Governor session's dispatch transcript to
bind the three opinion reports to their dispatches. This is a tooling limitation, not a substantive
gap. CI full-verify on the signoff PR (which goes fully green once the signoff flips the 3 guards) is
the authoritative backstop, and the organizer reads the signoff diff and confirms CI green before
merge.

### Pre-activation go-live preconditions (gate the FLAG FLIP, not this merge/signoff)

Mandatory before `SHORESH_RELAY_ENABLED=true` in any real build; the owner decides activation
separately with this checklist:
1. **MAX_CONNECTIONS=200 distributed-source DoS mitigation** — owned as **T336-created latent
   exposure** (its reachability is gated by `relayEligible`→dcutr, which did not exist before this
   slice). Reserved-slot floor for admitted/camp peers + early-drop/priority for un-admitted sources
   + an aggregate inbound cap sized for hostile internet scale with admitted peers exempt. C4's
   64 KiB pre-auth frame cap is complementary, not a substitute.
2. **Real independently-NATed two-device cross-network dcutr punch validation** (owner hardware;
   procedure in docs/work/security/2026-10-03-t336-cross-network-punch-validation.md, marked NOT YET
   DONE — not an inert-merge blocker).
3. **Re-confirm T337's C2 (client camp-only reservation) + C4 (pre-auth sizing)** against the
   shipping code state at the activation gate (both proven now).
4. **Re-run the dcutr-subtree `npm audit` + postinstall-script check** at activation (clean now: 0
   advisories, no postinstall scripts).
5. **ADR 2026-09-14 owner-level items unchanged by this slice:** signed/integrity-checked
   auto-update; full internet-scale libp2p rate-limit review.
6. **Documentation:** `SHORESH_RELAY_ENABLED` must be the literal string `'true'` (strict
   `=== 'true'`; other truthy values fail closed to inert).
