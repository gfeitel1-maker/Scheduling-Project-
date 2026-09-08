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

**Complete for the owner's case.** Scenario 08 (concurrent-create data loss): ~80% failing → passing.
Scenario 28 (two directors disagree about one slot; both see it; one chooses; everyone converges):
~50% failing → **12/12 across three runs**.

### The rejected fix, and why it stays rejected

An earlier revision resolved a contested record by **reassigning the record key** to the union of
every version with the choice applied. It made scenario 28 green and it was wrong — caught in review
before merge, then reproduced against the real implementation:

```
resolution:      s1 = { activity_id: 'archery' }     (key reassignment)
concurrent edit: s1.flags = 'bring-sunscreen'        (ordinary field write)
merged:          { activity_id: 'archery' }          -- flags GONE
getConflicts:    0                                   -- nothing to surface, ever
```

A counselor adding a note while the director settles that cell loses it **with no trace**: the
reassignment creates a new container, so a concurrent write into the old one is discarded. Unlike the
bug it was meant to fix, this one is invisible. **Loud-and-annoying is a bad trade for
silent-and-invisible**, and that is the whole axis this ADR exists on. Pinned by a test that asserts
the reassignment loses the concurrent edit, so it cannot come back.

### The limitation this leaves, stated rather than discovered

Resolution is a field write, which cannot dominate two competing record *versions*. So a disagreement
between two devices that **concurrently created the same record** stays surfaced after a choice,
rather than clearing. It is annoying; nothing is lost.

Where this can happen in practice: a schedule's slots arrive as a bulk-replace *scope*, and the flat
per-cell record is created by the first per-cell edit. Two people editing the same never-yet-edited
cell at the same moment therefore hit the contested-record path. Everything after that first edit is
an ordinary field disagreement and resolves normally.

**This is the second independent piece of evidence for the deferred "flatten the record shape"
option.** Records-as-containers caused the original silent loss, and now bounds what resolution can
do. Still the owner's call, still not to be bundled with the cutover.

### A third option, so this is not a two-way choice

Raised in review and worth the owner seeing before they choose between "keep records, live with the
annoyance" and "flatten everything": **record the resolution instead of trying to make Automerge
clear it.**

When a human chooses, write an ordinary document field holding the sorted set of Automerge conflict
keys they settled. The reconciler then suppresses reporting when a contested record's current key set
matches a recorded resolution. It is *derived-plus-recorded*, not stored resolution state — so it
keeps this ADR's central property (every device converges on the same marker by the same mechanism,
and "both see it cleared" stays free), needs no key reassignment, and therefore cannot lose a
concurrent edit.

Preconditions, measured here rather than assumed:

| | |
|---|---|
| Conflict keys identical on both devices | ✅ `['30@265b…','30@784f…']` on each |
| Stable across `A.save`/`A.load` | ✅ |
| A genuinely new disagreement carries different keys | ✅ `36@…` then `55@…` |

The third needs stating carefully, and the reason is worth keeping. It was first demonstrated by a
test that compared **record-level** keys for the first conflict against **field-level** keys for a
later one — different levels, so "the keys differ" was guaranteed by construction and demonstrated
nothing. The claim happens to be true, which is what makes that shape dangerous: a passing check that
agrees with the conclusion while testing something else.

Measured at the level a marker would actually key on, it holds — field-level `36@…` then `55@…`.
Measured naively it appears to **fail**: compare record-level keys before and after a field-level
disagreement and they are unchanged, because the record-level contest genuinely is the same one and
is a one-time event that cannot recur once the record exists.

So `"conflict keys change for a new disagreement"` is **not safe as a one-liner**. It is true only
when the marker keys on the same level it suppresses. Someone implementing from the short version
would key at the wrong level and build a marker that either suppresses for ever or never matches —
and running the obvious check would show them a refutation of a sound design. Both measurements are
recorded here for that reason.

Open questions, none of them answered:

1. **Where the marker lives.** It must be in the document to converge, so: a new collection and a
   genesis regeneration. Cheap now, not cheap once real camps exist — the same care the subset guard
   exists to enforce.
2. **Growth and pruning.** Markers accumulate with no obvious collection point.
3. **Whether it is worth building at all**, given the limitation only bites on the first-ever edit of
   a never-yet-edited cell.

Listed as an option, deliberately not as a recommendation.

### Two things worth keeping from how this was found

- The first diagnosis was wrong (a plausible story about Automerge eliding a no-op assignment), and
  the second attempt was **worse than the bug** — it stopped over-reporting by making genuine
  disagreements go silent. Caught on one probe, on a count reading 0 where it should have read 1.
- Scenario 28's residual flakiness was a **test race, not a product fault**: it waited on the
  projected SQLite row, which a bulk-replace scope satisfies before the flat record has arrived — so
  both clients still created the record and it became a contested-record test by accident. Waiting on
  the document fixed it. Third time today that the scaffolding around the thing under test was the
  thing that mattered.
