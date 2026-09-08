---
title: "ADR: Reconciling concurrent edits under the CRDT — union what doesn't overlap, surface what does"
document_type: adr
status: accepted
authority: normative
implementation_state: in_progress
date: 2026-09-08
decided: 2026-09-08
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/plans/2026-09-07-stage6-cutover-plan.md
related_tickets: []
related_adrs:
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-09-08-libp2p-join-flow.md
supersedes: []
affects: []
program: shoresh-future-architecture
---

# ADR: Reconciling concurrent edits under the CRDT

> **Status: ACCEPTED (2026-09-08).** The product owner decided this directly, in their own words:
>
> > *"if they create the exact same record … it doesn't matter. the same idea was generated."*
> > *"[if they are different] they are not the same and need to be reconciled."*
> > *"flag it and make someone choose. if they are doing it in real time like that then they are
> > working together not separately, so just make it a choice that both need to see."*
>
> This also answers the Stage 6 plan's **6e**, which was explicitly left as "a product decision —
> ask the owner." It is answered: the conflict UI is not removed. It is repurposed.

## Context

Two defects block the op-log cutover, both found by the Stage 6a harness once it started joining
devices for real. Full measurements and reproducers:
[`docs/work/evidence/2026-09-08-concurrent-entity-creation-loses-fields.md`](../work/evidence/2026-09-08-concurrent-entity-creation-loses-fields.md).

| | Concurrent record creation | Concurrent edit of the same field |
|---|---|---|
| Trigger | Two devices reach the same *derived* entity id | Two people edit one slot |
| Frequency | Narrow (derived ids only; new records use `randomUUID`) | **Ordinary camp behaviour** |
| Result | One side's **fields** vanish | One side's **decision** vanishes |
| Under the op-log | Merged additively | Surfaced as a conflict to resolve |

Both are silent. Both devices converge on the same wrong answer and nothing is shown to anyone. In
both cases the discarded value is sitting in `A.getConflicts` — **which nothing in this codebase
reads.**

The second is the one that matters to a director, and it is a **regression against the op-log**, not
a CRDT tradeoff to absorb. That is what makes 6b/6d a correctness decision rather than a mechanism
one.

## Decision

**One rule, applied recursively to every conflicted key after every merge:**

- **Keys that do not overlap are unioned, silently.** If one device set an activity's `name` and
  another set its `location`, nobody needs to adjudicate that. Both survive. No flag, no screen, no
  interruption. This is the owner's *"the same idea was generated"* case generalised: where there is
  no disagreement, there is nothing to show a human.
- **A scalar key with two different values is surfaced to a human, and never resolved by the app.**
  Group 1 / period 2 set to archery on one device and playground on another is a real disagreement
  between two people. The app records it and shows it. It does not pick.
- **A scalar key with the *same* value on both sides is not a conflict.** Two people making the same
  move is agreement, not a collision, and must not generate a prompt.

These are genuinely two different jobs, and a design that treats them as one will get the second
wrong — which is the one with a person on the other end.

## Why both devices see it, without storing anything new

`A.getConflicts` is a **property of the merged document**, and every device converges on the same
document. So every device independently derives the *same* conflicts from the *same* bytes.

That gives the owner's "a choice that both need to see" for free, with no new synced state:

- **Detection is derived**, not stored. Nothing about a conflict is written into the CRDT, so there
  is no conflict-about-a-conflict, no resolution state to replicate, and no ordering problem.
- **Resolution is an ordinary document write.** Choosing archery writes `activity_id = archery`,
  which causally dominates both earlier values. The conflict then no longer exists in the document,
  so it disappears on every device by the same mechanism that surfaced it. Nobody has to broadcast
  "resolved."
- **A device that was offline for all of it** still sees the conflict when it syncs, because it is
  in the document it receives — and still sees the resolution if one already happened.

## What this reuses

Almost everything. This is a new *producer* for machinery that already exists and is already
designed for a non-technical reader:

- the `conflicts` table (`entity`, `entity_id`, `field`, `incoming_op`, `existing_op`, …);
- `ConflictsScreen`, including its plain-language `FIELD_LABELS` — which already carries
  `template_slots.activity_id` → *"Which activity is in a cell"*, i.e. the exact case;
- `listPendingConflicts` / `resolveConflict` on the IPC surface, and the sidebar badge.

The op-log wrote those rows on a conflicting `appendOp`. The CRDT path will write them from the
merge. The renderer does not change.

**Consequence for 6e:** `resolveConflict`/`listPendingConflicts` do *not* get removed. Their write
path changes from an op-log append to a document write.

## The structural guarantee, and why it is the hard part

The requirement is **not** "the reconciler handles conflicts." It is:

> **The system cannot be in a state where a conflict went unhandled.**

The weak version of this feature is easy and its failure is invisible — a reconciler that reads
`getConflicts` correctly at one call site, and is then bypassed by some later path that writes the
document without going through it. The symptom of that bypass is *identical to the bug it was built
to fix*: a silently discarded decision.

The shape to copy is `campDocument.js`'s module-load subset guard: its strength was never its logic,
it was that module load leaves **no path around it**. So:

1. Reconciliation hangs off the **single place a merged document becomes SQLite** — `projectAll` —
   not off each call site that merges. Every path that projects reconciles, by construction.
2. `projectAll` **asserts** that the document it was handed has no unrecorded conflicts, and throws
   if it does. A future path that merges without reconciling fails loudly at the projection it must
   perform anyway, rather than quietly losing a director's work.
3. A test asserts the invariant directly against a deliberately conflicted document, so the guard is
   pinned rather than incidental.

## Alternatives considered

**Store conflicts in the document.** Both devices would see them, which is the requirement — but it
puts resolution state into append-only CRDT history, creates the question of what happens when two
devices resolve the same conflict concurrently, and needs its own reconciliation. Deriving it is
strictly simpler and gives the same guarantee. Rejected.

**Last-writer-wins with an activity feed** ("playground replaced archery"). Cheaper, and wrong for
this product: it resolves the disagreement and then tells you about it. Article V — *the engine
surfaces conflicts; it never resolves them silently.* The director stays in control; a feed entry is
a notification, not a decision. Rejected.

**Flatten the record shape** so per-record containers are never created (the evidence doc's option
2). Removes the *creation* half by construction, and does nothing for the same-field half, which is
the common one. It remains a reasonable future cleanup on its own merits; it is not this fix, and
bundling a genesis migration into the cutover would be its own risk. Deferred.

## Migration, rollback, recovery

**Migration:** none. No schema change — `conflicts` already exists with the right shape. No document
change, since nothing new is stored in it.

**Rollback:** the reconciler sits behind the existing `SHORESH_SYNC_ENGINE` flag, which still
defaults to `oplog`. Reverting restores current behaviour exactly.

**Recovery:** a conflict recorded but never resolved is a *stable, visible* state — it sits in the
Conflicts screen and the sidebar badge until a human acts. That is the intended resting state, not a
failure. The failure this design must never produce is the opposite: a conflict that existed in the
document and was never recorded, which is what guarantee (2) above exists to make impossible.

## Implementation slices

- **R1 — the pure reconciler.** `reconcile(doc)` → `{ merged, conflicts[] }`. Recursive union rule,
  same-value-is-not-a-conflict, deterministic ordering so two devices produce identical output.
  Pure, no SQLite, no libp2p, tested against the two reproducers in the evidence doc.
- **R2 — wire it into `projectAll`,** plus the assertion that makes an unhandled conflict impossible,
  plus its test.
- **R3 — write `conflicts` rows** from the reconciler's output, idempotently (re-projecting the same
  document must not duplicate a row).
- **R4 — `resolveConflict` writes to the document** instead of appending an op, and the resolution
  clears the conflict on every device.
- **R5 — the integration scenario:** two devices disagree about one slot; both see the conflict; one
  resolves; both converge on the chosen value. This is the exit criterion, and it is scenario 08's
  successor.

R5 is what proves this ADR. Until two devices in the harness disagree and both surface it, this is a
claim.

## Implementation status (2026-09-08)

**R1–R4 built and green.** Scenario 08 — the measured concurrent-create loss — went from failing
~80% of runs to passing 5/5 over real libp2p. `npm run verify`: 358 files, 5088 passed, exit 0.

**R5 is partially proven, and the remaining gap is stated rather than smoothed over.** Scenario 28
asserts four things in order; the first three pass on every run:

1. two devices set one slot to different activities; ✅
2. **all three devices surface the disagreement** — the owner's "a choice that both need to see"; ✅
3. no device invents a third answer; ✅
4. one director chooses and everyone converges. ⚠️ **fails ~50% of runs.**

What is known about (4), so it is not re-derived:

- **Resolving is not the broken step.** Every strategy — plain re-assign, delete-then-set in one
  change, delete then set in two — clears the conflict in-process, *including* the shape that
  correlates with the failure, where the resolver's own value had already won locally. Measured
  directly rather than assumed.
- The failure correlates with the resolving device already displaying the value it chooses, which is
  also **the most likely thing a director does** ("keep what I'm looking at"). `resolveConflictInDoc`
  exists to make that write unconditional, and is correct in isolation.
- What remains is convergence *after* a resolution over the network, not the write that performs it.

Scenario 28 stays in `run.automerge.js`, red about half the time, with this written beside it. That
runner is not wired into `npm run verify`, so an honest red costs the gate nothing — and reporting
4/4 against a case a director will hit would be worse than a visible red.
