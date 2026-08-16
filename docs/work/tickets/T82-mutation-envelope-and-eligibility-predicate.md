---
title: T82-mutation-envelope-and-eligibility-predicate
document_type: ticket
status: open
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
related_adrs: []
related_specs: []
related_reports: [docs/work/architecture-reports/2026-08-16-architecture-audit-summary.md]
archive_when: "the optimistic-write claim/chain/dispatch invariant in useSlotMutations.js is expressed once via a single runMutation-style envelope consumed by every forward + undo + redo path, AND the tier/group eligibility predicate exists in exactly one place consumed by both the ScheduleScreen typeahead and the useSlotMutations UNFILLABLE check; both changes are behavior-preserving under a characterization test written BEFORE the refactor; and this ticket is merged with owner sign-off"
---

# T82 — Name the mutation envelope once (F1) + unify the eligibility predicate (F2)

**Source:** architecture audit 2026-08-16, candidates F1 (high) and F2 (medium-high). See
`docs/work/architecture-reports/2026-08-16-architecture-audit-summary.md`.

**Task class:** live write-path / sync-adjacent refactor (touches the op-log write queue and the
undo/redo stack). **Risk:** medium — behavior-preserving by intent, but the code it touches is the
per-cell write-serialization queue whose race has already been reworked twice under Red Hat
(PR #52, PR #54). This is exactly the seam where a single-copy invariant miss has bitten before,
which is *why* it is worth doing — not a cosmetic cleanup.

## Why now (leverage)

F1 and F2 are the two highest-leverage items in the fresh audit, and the depth debt has *moved
into* `src/screens/schedule/useSlotMutations.js` now that the screen/IPC seams are clean. Both are
duplicated-invariant defects: the danger is not today's behavior but that a future edit fixes one
copy and not the others.

## F1 — Extract the optimistic-write + undo/redo envelope

**Current state:** `claimAndRun(keys, claimId, fn)` (the write-queue primitive, `useSlotMutations.js`
~line 156) is correct and centralized. But the *envelope around it* — claim a set of cell keys,
run the write, bail on `dropped`/write-error, then register symmetric undo/redo closures that each
re-run the SAME claim→chain→dispatch pattern with a fresh `crypto.randomUUID()` — is hand-repeated
across `replaceSlot`, `placeActivityManual`, `expandSlot`, `splitSlot` and every one of their undo
and redo closures (forward + `undo`/`redo` blocks at ~lines 257, 284, 520, 535, 622, 643, and the
matching forward bodies). Roughly eight structural copies of one safety-critical invariant.

**Goal:** introduce ONE helper — e.g. `runMutation({ keys, apply, invert })` — that names the
invariant a single time: claim the keys, run `apply`, honor drop/error semantics, and register the
undo (`invert`) / redo (`apply`) closures through the identical path. Each mutation becomes a
declaration of *what changes and how to reverse it*, not a re-implementation of *how the queue and
undo stack work*.

**Hard constraints (do NOT regress):**
- Undo/redo MUST keep synthesizing their own claim id (finding 3, preserved verbatim in the current
  comments) — an undo running after later writes must not reuse the forward claim id.
- The fresh-read snapshot seams for undo capture (Deviation A: `replaceSlot`/`expandSlot` read
  "previous" values off `slotsRef`/rebuilt-from-`activities`, NOT the stale `slots` prop) MUST be
  preserved. The envelope must not force premature capture of `invert` state.
- `dropped` and write-error short-circuits (no undo entry pushed on a dropped/failed write) MUST be
  byte-equivalent to today.

## F2 — Unify the tier/group eligibility predicate

**Current state:** the same predicate is written twice —
- `src/screens/ScheduleScreen.jsx:222–229` (`eligibleActivitiesFor`, drives the click/Enter typeahead), and
- `src/screens/schedule/useSlotMutations.js:414–417` (drives the UNFILLABLE flag / place-eligibility).

Logic in both: no eligibility lists ⇒ eligible; else eligible iff `eligible_tier_ids` includes the
group's `tier_id` OR `eligible_group_ids` includes the group id. **A comment near the second copy
falsely claims the two were already unified** — remove that false claim as part of the fix.

**Goal:** one exported pure predicate (e.g. `isActivityEligibleForGroup(activity, group)` beside the
engine/rule helpers), consumed by both call sites. The typeahead and the UNFILLABLE flag must not be
able to diverge.

## Success predicate (observable)

1. A **characterization test written BEFORE the refactor** pins current behavior of all four
   mutations including undo→redo→undo round-trips and the drop/error short-circuit, and stays green
   after. (test-first at a live write seam is mandatory per the engineering defaults.)
2. `grep` confirms the claim→chain→dispatch pattern appears once (in the envelope) — undo/redo
   closures no longer each spell out `claimAndRun(..., crypto.randomUUID(), ...)`.
3. The eligibility predicate exists in exactly one module; both call sites import it; the false
   "already unified" comment is gone.
4. Full gate green: `npm run verify` (lint + test + test:integration + check:governance).
5. Behavior-preserving: no user-observable change to placement, flags, or undo/redo.

## Review routing

Given the seam: Maker (test-first) → **Red Hat** (undo/redo + write-queue race is its home turf,
PR #52/#54 lineage) → Code Reviewer → Verifier → Grader. No new ADR — this is a behavior-preserving
extraction the audit already designed; if the envelope forces a *semantic* change, stop and escalate
to Architect instead of absorbing it.

## Non-goals

- F3 (findings-rail extraction) and F4 (sync-layer deep-read) are explicitly OUT — separate tickets.
- No change to write-queue semantics, op-log ordering, or the undo-stack data structure.
