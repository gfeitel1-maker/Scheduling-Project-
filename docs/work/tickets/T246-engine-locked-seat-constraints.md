---
title: T246-engine-locked-seat-constraints
document_type: ticket
status: open
created: 2026-09-23
archive_when: buildElectiveAssignments accepts lockedAssignments, pre-consumes their capacity, never re-decides a locked seat, this ticket owns and documents the locked-seat-inside-a-linked-choice interaction, no code in this ticket re-stamps a locked row's solver_generation (that mechanism was removed after Red Hat H3), and a manual row whose occurrence_id no longer exists is reported as DANGLING_MANUAL_ASSIGNMENT during ordinary draft regeneration
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T246 — engine honors locked seats across regeneration

Implements ADR 2026-09-23 decision (b)'s engine-side half: a locked seat survives regeneration
instead of going inert under D5's generation-marker rule.

**Corrected 2026-09-23 (Red Hat H3).** The original scope had this ticket re-stamp locked rows'
`solver_generation` on every regeneration. That mechanism is **removed** — it depended on the
regenerating device's local view of which rows are locked, which a not-yet-synced lock from another
device defeats, causing the locked placement to silently vanish from the read path with no error.
The fix moved to the read side (T244's shared generation-visibility predicate: `source='manual'`
rows are always visible, regardless of `solver_generation`). This ticket's write-side scope shrinks
accordingly — the capacity-reservation half (below) is unchanged; the re-stamp half is deleted, not
replaced.

## Scope

- `src/engine/buildElectiveAssignments.js`: new parameter `lockedAssignments:
  [{camperId, occurrenceId, activityId}]`. Before constructing the flow network for an occurrence,
  subtract each locked camper's offering from remaining capacity and remove that camper from the
  free-variable set for that occurrence. Pure function, no I/O — this file's existing discipline
  (`T69 engine purity`) is preserved, not relaxed.
- `commitElectiveRun`'s generation path (`electron/ops/*`): before calling
  `buildElectiveAssignments`, query `elective_assignments WHERE run_id = ? AND is_locked = 1` and
  pass them as `lockedAssignments`. **Do not write to these rows' `solver_generation` at all** —
  they are read-only inputs to this pass, per the H3 correction above.
- **This ticket owns the locked-seat / linked-choice interaction (Red Hat's smaller finding — give
  it one owner, not two).** Decide and document: when a camper's locked seat is a member occurrence
  of a linked choice `C` another camper (or the same camper, on a different preference) might be
  placed into via T247's tier-1 solve, the locked seat's capacity must already be subtracted before
  tier 1 runs — i.e., tier 1 must consume the *same* `lockedAssignments`-adjusted capacity this
  ticket produces, not the raw offering capacity. State this explicitly in this module's header
  comment so T247 has one place to read the contract from, and add a fixture covering it: a locked
  seat inside a two-member linked choice's capacity, verified to reduce what tier 1 can place.
- **`DANGLING_MANUAL_ASSIGNMENT` finding (residual of Red Hat H3).** A manual/locked row is exempt
  from the generation-visibility filter, which says nothing about whether the occurrence it points at
  still exists after a template edit. Before calling `buildElectiveAssignments`, this ticket's
  `commitElectiveRun` wiring checks each locked row's `occurrence_id` against the live-derived
  occurrence set it already re-derives for its own solve, and reports any manual row whose occurrence
  no longer exists as `DANGLING_MANUAL_ASSIGNMENT` (same finding-vocabulary class as
  `UNSUPPORTED_LINKED_CHOICE`/`NO_CAPACITY`) rather than silently dropping or silently keeping it.
  This is a detection only — no auto-repair; a director acts on it via T245's existing move/lock IPC.
  Previously only finalize's `STALE_OUTER_SCHEDULE` diff (T244) caught this, and only at finalize
  time, not during ordinary draft regeneration — this closes that gap.
- `buildElectiveAssignments.test.js`: fixture proving a locked camper's `activity_id` is unchanged
  across two regenerations with different random/preference inputs, that the locked seat's capacity
  is correctly unavailable to other campers in the same solve, the linked-choice interaction fixture
  above, and a fixture where a locked row's `occurrence_id` has been deleted from the template between
  generations, asserting `DANGLING_MANUAL_ASSIGNMENT` fires and the solve otherwise completes normally
  around it (the dangling row is excluded from capacity accounting, not treated as an error that halts
  the regeneration).

## Non-goals

The IPC write path (T245, a dependency of this ticket). Any change to how `solver_generation` is
read — that's T244's shared predicate module, consumed here, not redefined.

## Test seam

`src/engine/**` is a pure module — unit tests via `npx vitest run
src/engine/buildElectiveAssignments.test.js` are sufficient for the engine change itself; the
`commitElectiveRun` generation-path wiring touches `electron/ops/**` and is **mandatory** for the
integration harness.

## Dependencies

T245 (shared eligibility/capacity helper, and the row shape this reads). T243 (schema, transitively
via T245).
