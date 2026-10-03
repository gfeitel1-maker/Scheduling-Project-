---
title: "T336 — real-hardware cross-network dcutr punch validation (NOT YET DONE)"
document_type: security
authority: evidence
status: active
task_class: security-auth
created: 2026-10-03
assessed_commit: 49b7ed9755a8df6df8f0e1078a2b33224b308736
governing_docs: [docs/work/specs/2026-10-03-t336-holepunch-build-design.md, docs/work/security/2026-10-03-t337-relay-capability-assessment.md, docs/work/security/2026-10-03-t336-c4-preauth-sizing.md]
archive_when: the procedure below has actually been run on real hardware and its evidence recorded, AND SHORESH_RELAY_ENABLED go-live is being decided
---

# PLACEHOLDER — real-hardware, cross-network dcutr punch validation

**STATUS: NOT YET DONE.** Nothing in this document has been executed. This is the documented
procedure for a step that can only be performed on real hardware across real, physically separate
networks — it cannot be faked, simulated, or satisfied in-process, and it is explicitly NOT part of
this build chunk's gate.

Do not treat this document, or its existence, as evidence that the validation has occurred. No
`dcutr.signoff` has been written, and this document does not write one.

## What this is, and where it sits

Per the owner's WAN discovery model (LAN meet → hole-punch → Cloudflare relay as a RARE fallback —
`docs/work/specs/2026-10-03-t336-holepunch-build-design.md`), the dcutr direct-upgrade capability's
whole purpose is: two camp devices that first meet via the camp-admitted relay (T337) attempt a
direct (hole-punched) connection, and only fall back to relaying all traffic through the relay if that
punch fails. Everything built in T336's chunks so far (dcutr wiring behind the flag-gate, the three
relay-reservation preconditions) has been proven **in-process**, on loopback, with fake or
same-machine network topology. That proves the *mechanism* is wired correctly. It does **not** prove
the punch actually succeeds between two devices behind two independent, real home-router NATs on the
public internet — NAT behavior (full-cone, restricted-cone, symmetric, CGNAT) varies by hardware and
ISP in ways no in-process test can reproduce, and a symmetric-NAT pairing is a known case where a
UDP/TCP hole punch can legitimately fail even with correct code on both sides.

This is therefore a **pre-activation, owner-hardware, one-time final-validation step** — not a build
blocker, not something Maker/Verifier/CI can run, and not a substitute for the automated gate. It sits
between "capability merged and unit/integration-tested" and "`SHORESH_RELAY_ENABLED=true` in any real
build."

## Procedure

### Prerequisites
- Two physical devices running this app's Electron build, each on a genuinely separate home network
  (two different ISP accounts / two different routers — NOT two devices on the same Wi-Fi, and NOT a
  phone hotspot sharing the same upstream connection as one of the devices).
- `SHORESH_RELAY_ENABLED=true` set for this test run only, on both devices (never as a build default
  — see `docs/work/security/2026-10-03-t336-c4-preauth-sizing.md` for why this stays gated).
- Both devices already paired into the same camp (so `authenticatedPeers`-gated admission is not
  itself the thing under test).
- A third reachable device or relay host playing the camp's relay role (per T337), on a network
  reachable from both test devices.

### Steps
1. **Cold start, LAN-absent.** Start device A and device B with no shared LAN path between them (this
   is the point of the two-separate-networks requirement — if they can reach each other via mDNS/LAN
   discovery, the hole-punch path is never exercised).
2. **Observe the LAN-meet step is skipped / inapplicable.** Confirm (via logs or the sidebar's sync
   status) that neither device found the other via LAN discovery.
3. **Observe both devices reserve on the relay.** Confirm each device's relay reservation succeeds
   (per T337's camp-only reservation gate) and each can see the other as a relay-reachable peer.
4. **Trigger the dcutr direct-upgrade attempt.** This should happen automatically once both devices
   are relay-connected to each other (per the design doc's §1: the upgrade attempt runs over a
   connection that already arrived via the admitted relay).
5. **Capture the punch outcome — both possible outcomes are useful evidence:**
   - **Success case:** confirm the connection between A and B is observed as a DIRECT connection
     (not `/p2p-circuit`) after the dcutr exchange completes. Capture the multiaddr/connection-type
     evidence (e.g. `node.getConnections()` logged on one side, or equivalent observable state) showing
     the upgrade actually took effect.
   - **Failure case (equally expected and useful):** if the punch fails (e.g. one or both devices are
     behind a symmetric NAT), confirm traffic continues to flow correctly over the **relay fallback**
     — i.e. the app keeps working, sync keeps happening, just routed through the relay rather than
     directly. A silent full failure (sync stops) would be a real bug; a graceful fallback to relay is
     the correct and expected behavior when the punch cannot succeed.
6. **Record the result** (see "Evidence to capture" below) regardless of which outcome occurred —
   both are informative, and a failed punch with a working relay fallback is NOT a failure of this
   validation step, it is the system behaving as designed under a real NAT topology.
7. **Repeat if possible with a second NAT pairing** (e.g. a different ISP/router combination) if real
   hardware access allows it — NAT behavior is heterogeneous enough that one successful pairing does
   not prove the general case, though it is a reasonable first data point.

### Evidence to capture
- Network topology of both devices (ISP/router type if knowable, NAT type if determinable via any
  existing diagnostic).
- Timestamps and log excerpts for: relay reservation success, dcutr attempt start, dcutr outcome
  (upgraded vs. failed), and — on failure — confirmation that the relay fallback kept data flowing.
- The actual connection-type evidence from step 5 (not just "it seemed to work" — the point of this
  step is confirming the DIRECT path specifically, which requires checking connection type, not just
  app-level functionality that the relay fallback could equally explain).
- Any error messages, retry behavior, or user-visible state (e.g. the "relay full" / sync-status
  labels from T336 chunk 3) observed during the test.

## What this is explicitly NOT

- **Not a build gate.** `npm run verify` does not and should not run this.
- **Not satisfied by any in-process or loopback test**, however thorough — see the NAT-heterogeneity
  argument above.
- **Not a precondition for merging this branch's code.** The code may merge with
  `SHORESH_RELAY_ENABLED` still defaulting false; this step gates turning that flag on in a real
  deployment, not the code existing.
- **Not laundered to "passed" by this document's existence.** This document records the procedure,
  not an outcome. An outcome belongs in a follow-up entry (or an update to this same file) once the
  owner actually runs it on real hardware, with the evidence from "Evidence to capture" attached.

## Current status

**NOT YET DONE.** No run of this procedure has occurred. This is a pre-`SHORESH_RELAY_ENABLED`-go-live
owner-hardware step, carried forward as an honest residual from the T336 design — not resolved, not
simulated, not waived.
