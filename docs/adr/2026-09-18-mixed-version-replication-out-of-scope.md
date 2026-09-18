---
title: "Mixed-version replication is out of scope: a camp's devices run one build"
document_type: adr
status: accepted
authority: normative
implementation_state: not_started
date: 2026-09-18
decided: 2026-09-18
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
related_adrs:
  - docs/adr/2026-09-14-internet-transport-security-gate.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
  - docs/adr/2026-09-17-wan-rendezvous-seam.md
related_tickets:
  - docs/work/tickets/T215-libp2p-3x-upgrade.md
  - docs/work/tickets/T217-libp2p-3x-residual-findings.md
  - docs/work/tickets/T222-update-on-open.md
program: security-hardening
---

# ADR: Mixed-version replication is out of scope: a camp's devices run one build

## Status

Accepted, 2026-09-18, product-owner. Implementation not started — see "The load-bearing gap" below;
this ADR records a product/scope decision, and the decision itself requires no code, but the
mechanism that makes it *safe in practice* (update-on-open) does not exist yet.

## Context

T215 raised a real open question while closing GHSA-vrf4-mx87-p53w by bumping libp2p 2.10.0 →
3.3.11: does Shoresh promise that two devices on the same camp, running different app versions
(and therefore different libp2p majors), can still replicate the Automerge document between them?
`docs/work/tickets/T215-libp2p-3x-upgrade.md` left this as `archive_when` condition 3, unmet, and
`docs/work/tickets/T217-libp2p-3x-residual-findings.md` names the same cross-version run as the
thing that would settle several of its own open findings.

A cross-version interop harness was partially built and run, on branch
`worktree-agent-a05ea47d10e1c405e` (unmerged, to be discarded), using
`test/integration/harnessAutomerge.js`'s injectable `startSyncNode` seam — two checkouts at
different libp2p majors, two OS processes, one machine over loopback. **Its verdict was
inconclusive, not a pass.** It is not evidence that cross-version replication works, and this ADR
does not cite it as such. Two side findings from that run are worth recording on their own terms
(see "Findings from the discarded cross-version attempt" below); neither bears on the decision
itself.

## Decision

**A — a camp's devices all run the same build.** Shoresh does not promise, does not test, and will
not engineer for replication between two devices running different app versions. The library-level
finding in T215 (protocol IDs — Noise, Yamux, multistream-select, identify — are byte-identical
across the libp2p 2→3 major) remains true and is not contradicted by this decision, but it is no
longer load-bearing: the product no longer needs mixed-version interop to work, so the residual
risk T215 flagged (Yamux's in-band window negotiation, multiaddr parsing differences) is closed by
removing the requirement, not by testing the risk away.

**The mechanism that makes this true: update-on-open.** A device that opens the app is kept current
before it is allowed to sync, so "two versions in the same camp" stops being a state the running
fleet can settle into. This ADR does not specify how; see "The load-bearing gap" below.

**Evidence this was safe to decide now, not deferred:**

- Nothing anywhere runs libp2p 2.x today. `package.json` already carries only the 3.x line (T215
  merged); there is no installed base on the old major to be compatible with.
- The product is pre-production — no camp has live data or a live fleet that this decision could
  strand mid-rollout.
- The recent Automerge genesis regeneration had already forced every device to re-pair, which means
  every device that exists today was already brought current by hand as part of that event. There
  is no silent population of stale devices this decision leaves behind.

## Why a decision instead of a demonstration

T215's own text argued that a mixed-version fleet is normal during any rollout ("a director updates
her laptop Tuesday and the office machine Friday") and that the interop test is cheap and must not
be skipped. That argument holds **if the product promises to support a rollout window where versions
differ.** This ADR removes that premise instead of satisfying it: with update-on-open as a precondition,
there is no rollout window in which two different versions of the same camp are both live and
expected to sync. The cross-version harness attempt independently confirms that satisfying the
original premise was not cheap in practice — it returned inconclusive after real engineering effort,
which is part of why a scope decision was preferred to a further demonstration attempt.

## `archive_when` condition 3 is met by this decision, not by a test

`docs/work/tickets/T215-libp2p-3x-upgrade.md`'s third `archive_when` condition reads: "mixed-version
(2.10 <-> 3.x) replication has been demonstrated or its failure surfaced to the director." This ADR
satisfies the second branch — the "or" — by removing the promise at the product level rather than by
running the demonstration. **A future reader must not mistake this for "we tested it and it
worked."** It was not tested to a pass; it was decided out of scope, for the reasons above.

## The load-bearing gap: update-on-open does not exist today

This decision's safety rests entirely on update-on-open actually happening and being unskippable.
**No such mechanism exists in this codebase today.** There is no code path that checks app version
before allowing a device onto the sync path, and no build/update pipeline wired to `electron/`.

The honest characterization of today's state is therefore: **drift-is-possible by default, not by
design.** The risk this ADR closes is currently zero only as an accident of timing — no device in
existence runs anything but the current build — not because any mechanism prevents drift. The moment
a second app version exists in the wild (the very next release), this decision's precondition either
holds because an update-on-open mechanism has been built, or it does not hold and mixed-version
devices can attempt to sync with the exact untested risk T215 described.

`docs/work/tickets/T222-update-on-open.md` files the updater as its own ticket, owned separately and
**not authorized or scoped by this ADR** — this ADR records why the updater is load-bearing
infrastructure rather than a convenience feature; it does not design or build it.

## Findings from the discarded cross-version attempt (recorded, not actioned by this ADR)

Neither finding bears on the scope decision above; both are recorded here because they were
produced by real engineering effort that would otherwise be lost when the branch is discarded.

1. **A join-approval race in the pairing flow.** Approving a join the instant `onPairingRequest`
   fires races `authGate.js`'s own `pendingPairingPeers` bookkeeping: the notification fires
   *during* request handling, before the `pairing_pending` reply is sent and the peer is recorded,
   so an immediate approval finds nothing to dial back to. Not a live defect — a human director
   approving a pairing request is far slower than this window — but any automated test that
   approves instantly will hang. Recorded here rather than as a new T217 item because it is a
   pairing-flow timing detail unrelated to the libp2p major.
2. **A same-version control hung too.** A control run with both sides at 3.3.11 (two OS processes)
   hung identically at document arrival. This is a harness/integration signal, not something the
   version question explains, and must not be read as closed by this decision — if the harness or
   the underlying sync path has a real hang, it will surface again independent of libp2p version.
   Worth a look by whoever next touches `test/integration/harnessAutomerge.js` or the document
   arrival path, but out of scope for this ADR.

## Consequences

- T215's `archive_when` condition 3 is met; T215 closes (see the ticket for the closing note).
- T217 item 3 (the "what same-version tests structurally cannot see" list, insofar as it names
  cross-version interop as the gap) closes with T215, for the same reason — the gap it named is now
  out of scope rather than untested. T217 items 1 (`authenticateWith` close race) and 2 (dead
  `it-pipe` dependency) are unrelated to this decision and stay open.
- `docs/work/tickets/T222-update-on-open.md` is filed, open, unowned, and **not authorized to be
  built** by this ADR — it exists to make the precondition this decision depends on visible as a
  tracked gap rather than an implicit assumption.
- Any future work that reintroduces a mixed-version window (e.g. a staged rollout, an opt-in beta
  build, a downgrade path) must treat this ADR as still governing: either it ships update-on-open
  first, or it reopens this decision with the owner rather than assuming interop "probably works"
  on the strength of the protocol-ID equality argument in T215 — that argument was never validated
  end-to-end, and the one attempt to validate it returned inconclusive.
- No code changes ship with this ADR. It is a scope and documentation decision only.

## Verification (when implemented)

Not applicable to this ADR directly — it authorizes no code. When `docs/work/tickets/T222-update-on-open.md`
is eventually scoped and built, its own ADR/spec should reference this document as the reason the
updater is load-bearing, and its verification should include a test that a device below the
minimum supported version is blocked from the sync path rather than allowed to attempt it.
