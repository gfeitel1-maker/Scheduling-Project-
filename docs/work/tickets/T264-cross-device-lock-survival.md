---
title: T264-cross-device-lock-survival
document_type: ticket
status: open
created: 2026-09-25
task_class: database-sync
archive_when: an ADR decides how a locked elective seat survives a regeneration run on a device that has not yet merged the lock, and that decision is implemented with a non-vacuous test in which the lock op and the regeneration commit are ordered so the regenerating device cannot see the lock locally
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
related_tickets: [docs/work/tickets/T245-draft-assignment-move-lock-ipc.md, docs/work/tickets/T246-engine-locked-seat-constraints.md]
---

# T264 — a locked elective seat survives a regeneration on a device that has not merged the lock

**ADR-GATED. Do not implement from this ticket.** The mechanism does not exist yet and the ticket
does not propose one; the first deliverable is an ADR. Filed as one line on the board for the owner
to schedule, not as authorized work.

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
