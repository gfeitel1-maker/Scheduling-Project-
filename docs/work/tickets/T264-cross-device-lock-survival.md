---
title: T264-cross-device-lock-survival
document_type: ticket
status: completed
created: 2026-09-25
task_class: database-sync
archive_when: an ADR decides how a locked elective seat survives a regeneration run on a device that has not yet merged the lock, and that decision is implemented with a non-vacuous test in which the lock op and the regeneration commit are ordered so the regenerating device cannot see the lock locally
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
related_tickets: [docs/work/tickets/T245-draft-assignment-move-lock-ipc.md, docs/work/tickets/T246-engine-locked-seat-constraints.md]
---

# T264 — a locked elective seat survives a regeneration on a device that has not merged the lock

_Prior: ADR-gated; the first deliverable was an ADR._ That ADR is `docs/adr/2026-10-11-locked-elective-seat-survives-unmerged-regeneration.md` (accepted, GO-A) and this ticket is its implementation.

## The gap, stated precisely

`electron/ops/commitElectiveRun.js` (T246) makes a locked seat survive a regeneration by reading
`elective_assignments WHERE run_id = ? AND is_locked = 1` before its transaction and skipping those
derived ids entirely. That decision is made from **this device's local projection**. A lock written
on another device that has not yet merged here is therefore invisible to it, and the regeneration
writes `source:'solver'` and the solver's `activity_id` over the row. `is_locked` is left at 1
because no path in `commitElectiveRun` writes that field, so the row ends up locked-looking while
holding the solver's placement.

**This state is pre-existing and was not introduced by T246.** Verified: the write set at
`63735819:electron/ops/commitElectiveRun.js` also never wrote `is_locked`, so the same
`is_locked=1` + `source='solver'` combination was reachable before T246 and is unchanged by it.
T246 fixed the merged case and narrowed its own claim in `docs/current/PLATFORM_STATE.md` rather
than overstating it. Nothing here is a regression; this ticket exists so the residual is on the
board instead of only in a code comment.

## Why it needs an ADR rather than a fix

The ADR's own Red Hat H3 correction moved lock-survival to the **read** side (T244's shared
generation-visibility predicate, `source='manual'` exempt) *precisely* to avoid depending on the
regenerating device's local view of which rows are locked. T246's write-side skip depends on exactly
that view. So the two mechanisms rest on opposite assumptions, and closing the gap is a design
question about which layer owns lock-survival — not a patch to either one.

Directions an ADR would have to weigh (none of these is a recommendation):

- Never write `source` on a regeneration at all, leaving it a field only the manual path asserts,
  so a later-merging lock wins by per-field LWW without needing local visibility.
- Make the regeneration's write set include `is_locked: 0` so the row is at least self-consistent,
  turning a silent false-lock into a visible lost lock.
- Detect the contradiction after merge (`is_locked=1` with `source='solver'`) and surface it as
  run-level state for the director, the way `DANGLING_MANUAL_ASSIGNMENT` is surfaced.

## Test seam

Whatever is decided, the pinning test must order the lock op and the regeneration commit so the
regenerating device genuinely cannot see the lock locally. `test/integration/scenarios/34-locked-seat-survives-regeneration.automerge.js`
covers only the already-merged case and is not sufficient evidence for this ticket.

## Provenance

Raised by Red Hat during T246's review as a HIGH. Its severity framing ("materially worse than the
bug being fixed") did not survive checking against the merge-base and is not carried forward; the
gap itself did.

## Resolution

Implemented per the accepted ADR (keeper ruling GO-A: one plain item with one-tap Restore, the
`solver_generation`/`source` cards stop surfacing, the activity card is labelled).

- `electron/ops/lockedSeatOverwrittenFinding.js` derives `LOCKED_SEAT_OVERWRITTEN` from the merged
  projection through the shared generation-visibility fragment; `getElectiveRun` returns it as
  `lockedSeatFindings`, and `DraftRunView` shows one row naming the camper, the locked activity and
  the solver's, with a **Restore lock** button that calls the existing `setElectiveAssignment`.
- `electron/automerge/reconcile.js` no longer reports `solver_generation` or `source` on
  `elective_assignments` as conflicts of their own; it annotates the `activity_id` conflict's sides with
  which one was the lock (`manual`) and which the solver's, and `conflictStore.js` carries that through.
  `ConflictsScreen` labels the card "Which elective a camper is placed in".
- `setElectiveAssignment` closes the seat's own pending conflict rows on the writing device (nothing
  projects a local write, so the Restore would otherwise leave stale cards there). Found by the
  integration scenario, not reasoned.
- The local skip in `commitElectiveRun` is unchanged.
- Pinned by `test/integration/scenarios/39-locked-seat-unmerged-regeneration.automerge.js` (a real
  two-device partition; B's local `is_locked` asserted 0 before the heal). Forced deterministically:
  the solver winning every key, and the lock winning every key (no false item). Not forced: the mixed
  per-key outcomes (stale-generation hidden seat; `manual` holding the solver's activity) depend on op
  counters lining up and on random actor ids, so they are pinned at the detector and reconciler unit
  tests instead.
- Not done, by scope: `choice_id` conflicts on the same row still surface as their own card, and the
  conflict card's two sides still show raw activity ids (as `template_slots.activity_id` does today).
