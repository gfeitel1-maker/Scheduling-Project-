---
title: "The elective run durability pass — a partial snapshot refuses to export, a dangling placement survives a cold reopen and can be moved, and the export's eligibility and resource buckets are real"
document_type: ticket
status: completed
created: 2026-09-30
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-30-elective-run-durability.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md, docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md]
related_specs: [docs/work/specs/2026-09-30-t320-dangling-replace-picker.md, docs/work/specs/2026-09-25-t250-run-state-surface.md]
related_tickets: [docs/work/tickets/T250-draft-and-final-director-ui.md, docs/work/tickets/T246-engine-locked-seat-constraints.md, docs/work/tickets/T244-finalize-elective-run-ipc.md, docs/work/tickets/T198-machine-access-adapters.md]
archive_when: "a finalized run whose outer snapshot is only partially held reports snapshotIncomplete and every export builder refuses it with SNAPSHOT_INCOMPLETE rather than emitting a complete-looking document; a regeneration prunes the elective_occurrences rows it no longer derives through the op log without cascading into elective_assignments, so getElectiveRun derives DANGLING_MANUAL_ASSIGNMENT durably and a cold-reopened run shows it; the dangling row offers the director a picker that moves the camper onto a live occurrence (or removes the placement when the run has none) through setElectiveAssignment's replacesAssignmentId, after which the finding clears from that same derivation; and the exceptions export fills its eligibility and resource buckets from persisted findings and a live draft-run computation, shipping not_computed as empty — each asserted by a test that goes red when the production change is reverted"
---

# T320 — The elective run durability pass

Owner ruling, 2026-09-29, verbatim: **"i want the durability pass"**, **"bundle with the row
above"**, **"put the picker in to move a camper"**, and on the fold-in, **"i agree on 197"**.

One piece of work, one schema version (v83), one ADR
([docs/adr/2026-09-30-elective-run-durability.md](../../adr/2026-09-30-elective-run-durability.md)),
four coupled defects in the elective run lifecycle.

## What a director experiences today

**A printed child schedule can be silently wrong.** A director finalizes a run on one device. On a
second device that has only partially received the run's outer snapshot, the same run exports and
prints as though it were whole. The missing periods do not read as "missing" — they read as
"this child has nothing scheduled then." Nothing on screen distinguishes the two.

**A placement made by hand can vanish from view without being gone.** A director hand-places a
camper, then regenerates. If the regeneration no longer produces that period, the placement is left
pointing at a period the schedule no longer has. The director is told once, in the session that
regenerated. Close the run and reopen it and the warning is gone — the broken placement is not.

**The one offered remedy cannot work.** The dangling row's only action is "Release lock". It
genuinely releases the lock and genuinely does not fix the condition, because the finding is keyed
on the placement's source, which the release does not change.

**Two columns of the exceptions export are permanently blank.** The eligibility and resource
buckets ship as empty arrays with a `not_computed` marker, because neither finding was ever
persisted anywhere a later export could read.

## What is true when this is done

1. A finalized run records what its snapshot should contain, every reader compares that against
   what it holds, and an export of an incomplete snapshot is **refused**, not quietly emitted. The
   run's own screen says so inline, never as a banner.
2. A regeneration prunes the occurrences it no longer derives, through the op log; a hand-made
   placement pointing at a pruned occurrence stays put and is derived as
   `DANGLING_MANUAL_ASSIGNMENT` on every read, so a cold-reopened run shows it.
3. The dangling row offers a picker that moves the camper onto a period this run still has — or
   removes the placement when there is no such period — and the finding then clears from the same
   derivation that produced it.
4. The exceptions export's eligibility and resource buckets carry real rows, and `not_computed` is
   empty.

## Scope

Exactly the four items above. The ADR is the design of record; the picker's interaction is
[docs/work/specs/2026-09-30-t320-dangling-replace-picker.md](../specs/2026-09-30-t320-dangling-replace-picker.md).

## Not in scope

- ~~The tombstone-aware stub-seed at the projection choke point (a deleted or pruned row can be
  resurrected by a concurrent peer write).~~ _Prior: excluded as needing its own ADR and the human
  gate. The owner ruled otherwise on 2026-09-30 ("go for it"), folding it into this ticket's ADR as
  Part 2 rather than a new one; it shipped here, extended to the `elective_sets` stub as well._
- Broadening the persisted eligibility allowlist beyond `UNSUPPORTED_LINKED_CHOICE` — a
  product-judgement question recorded for the owner rather than guessed. Still out of scope.

## How it closed

Part 1 (PR #668, schema v83) shipped the four items above. Part 2 — designed in the same ADR after
the owner's 2026-09-30 ruling, no schema change — shipped four more in one PR:

1. **The tombstone-aware stub seed.** A peer's op on a child row no longer re-creates a parent
   whose most recent recorded act was its own deletion, for both `elective_assignment_runs` and
   `elective_sets`. The predicate is recency, not bare existence, so a legitimate re-create of the
   same id is not stranded.
2. **`RUN_IS_FINAL`.** `commitElectiveRun` refuses a commit onto a final run, surfaced at every
   door the director can reach it from.
3. **A true camper universe.** A camper the preference sheet named is in the run's universe even
   with nothing ranked, visible to a cold regenerate.
4. **The false `FINALIZED_AGAINST_STALE_GENERATION`.** Since v76 an inherited outer-snapshot row
   carries a NULL `solver_generation` by design, so every finalized run holding one read as
   finalized against a stale generation — on the device that finalized it, immediately. The
   comparison now reads elective rows only.

Three questions the ADR's Part 2 recorded for the owner remain open and were deliberately not
decided here: whether `SHEET_CAMPER_WITHOUT_PREFERENCE` should also list campers by name in
`DraftRunView`, whether the run's export needs the same widened universe, and the pre-existing
PII-erasure gap where `elective_run_outer_snapshots` carries `camper_id` but is absent from
`TOMBSTONE_DENYLISTED_ENTITIES` (confirmed real and unresolved by this work, which did not
introduce it).
