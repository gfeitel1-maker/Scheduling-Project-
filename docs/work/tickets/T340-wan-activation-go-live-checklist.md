---
ticket: T340
document_type: ticket
title: WAN relay/hole-punch activation go-live checklist (owner decision — pre-SHORESH_RELAY_ENABLED)
status: open
created: 2026-10-03
archive_when: "the owner has made the WAN activation go-live decision and, if he proceeds, every pre-activation precondition below is resolved or explicitly owner-accepted and SHORESH_RELAY_ENABLED is set true in a shipped build; or the owner declines activation and that decision is recorded"
task_class: security-auth
parent: ""
governing_docs: [docs/work/security/2026-10-03-t336-holepunch-dcutr-inert-merge-assessment.md, docs/work/security/2026-10-03-t337-standing-reservation-signoff-battletest.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/adr/2026-09-14-internet-transport-security-gate.md, electron/sync/automerge/transportCapabilities.js]
related_prs: []
---

# T340 — WAN activation go-live checklist (OWNER decision)

## Context

The owner-decided WAN discovery/transport ladder is now BUILT and entirely runtime-INERT on main:
LAN meet [prereq] → remembered-address reconnect [Slice 1] → camp-peer circuit-relay-v2 coordination
[T337, #736] → NAT hole-punch dcutr [T336, #737]. Both internet-capable rungs (`relay`, `dcutr`)
are code-merged with scoped signoffs but gated OFF at runtime: `SHORESH_RELAY_ENABLED` defaults
false and there is no auto-activation path.

**ACTIVATION** — setting `SHORESH_RELAY_ENABLED=true` so real camps use cross-network relay +
hole-punch — is a SEPARATE, owner-visible go-live decision. It is the moment the conditionally-cleared
exposure actually goes live and the device becomes internet-reachable. It is NOT an automatic
consequence of the capabilities being merged, and must not be shipped on-by-default. This ticket
tracks that decision and its hard preconditions; it is NOT a build task to start without the owner's go.

## Pre-activation preconditions (each resolved OR explicitly owner-accepted before the flag is set true)

1. **DONE (T340 DoS slice; `docs/adr/2026-10-08-max-connections-dos-mitigation.md`, implemented in
   `electron/sync/automerge/transport.js`, pinned by `transportConnectionDos.test.js`):
   MAX_CONNECTIONS=200 distributed-source DoS mitigation** — owned as a T336-created LATENT
   exposure (the flat 200-connection cap's internet reachability is gated by `relayEligible`→dcutr,
   which did not exist before T336; unreachable while inert). Once internet-reachable a distributed
   many-source-IP flood can exhaust the cap. Mitigation shape: reserved-slot floor for
   admitted/camp peers + early-drop/priority for un-admitted sources + an aggregate inbound cap sized
   for hostile scale with admitted peers exempt. (C4's 64 KiB pre-auth frame cap is complementary,
   not a substitute.)
2. **Real independently-NATed two-device cross-network dcutr punch validation** — procedure in
   `docs/work/security/2026-10-03-t336-cross-network-punch-validation.md` (marked NOT YET DONE):
   two devices on genuinely separate home networks complete a successful dcutr direct punch after a
   LAN meet, with graceful relay fallback observed when the punch fails. Owner hardware.
3. **DONE for now (2026-10-08, `docs/work/security/2026-10-08-t340-precondition-evidence.md` (a)); re-run at activation:
   Re-confirm T337 C2 (client camp-only reservation) + C4 (pre-auth sizing)** against the shipping
   code state at activation (both proven at build time; re-verify at go-live).
4. **DONE for now (2026-10-08, evidence (b): 0 prod advisories, no install hooks); re-run at activation:
   Re-run the dcutr-subtree `npm audit` + postinstall-script check** at activation (clean at build
   time: 0 advisories, no postinstall scripts).
5. **ADR 2026-09-14 owner-level items** not owned by the capability slices: ~~signed/integrity-checked
   auto-update (an internet-facing Electron app without it is an RCE vector)~~ _CLOSED: owner
   2026-10-08 will not build it; there is no update path, board item `h-signed-auto-update-closed`._
   Still open: a full internet-scale libp2p rate-limit review (includes the sizing of the 16
   pre-Noise pending slots, `MAX_INCOMING_PENDING_CONNECTIONS`; pairing itself is LAN-only per owner
   ruling 2026-10-08, see the max-connections ADR).
6. **DONE (documented, evidence (c)):** `SHORESH_RELAY_ENABLED` must be the literal string `'true'`
   (strict `=== 'true'` at `electron/sync/automerge/syncStarter.js:386`; other values fail closed to inert).

## Not in scope here

The capabilities themselves are built and signed off (inert); this ticket does not re-open them. It
is the activation gate, and the decision to proceed (and its timing) is the owner's.
