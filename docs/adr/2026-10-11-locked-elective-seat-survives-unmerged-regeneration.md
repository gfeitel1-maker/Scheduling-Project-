---
title: "A locked elective seat is never lost silently when a regeneration runs before the lock has merged"
document_type: adr
authority: normative
status: accepted
implementation_state: implemented
date: 2026-10-11
decided: 2026-10-11
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
supersedes: []
amends: []
implements: []
related_adrs:
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
  - docs/adr/2026-09-08-crdt-conflict-reconciliation.md
---

# A locked elective seat is never lost silently when a regeneration runs before the lock has merged

Ticket: `docs/work/tickets/T264-cross-device-lock-survival.md`.

## Owner request and success predicate

A director locks a camper into an activity on one device. Another device that has not yet received that lock regenerates the run. The owner wants the lock to still mean something afterwards.

**Success predicate.** After both devices have merged, for the seat the director locked: (a) either the row holds the director's activity with `source='manual'`, `is_locked=1`, or (b) the director is shown, on the run, one plain-language item naming the camper, the locked activity and the solver's activity, with a single action that restores the lock. A seat that reads as locked but holds a solver placement, or that disappears from the run, with nothing said, is a failure.

**Non-goals.** No change to how Generate solves electives. No new table, no schema change. No backfill or compatibility for existing camps (owner rule). No attempt to make the regenerating device see a lock it has not received; that is impossible by construction.

## What the code does today (verified, not taken from the ticket)

1. **The lock.** `setElectiveAssignment` (electron/ops/setElectiveAssignment.js, the `fields` object near line 276) writes nine keys to the derived id `deriveElectiveAssignmentId(run, camper, occurrence)`: `run_id, occurrence_id, camper_id, activity_id, choice_id, preference_rank, source:'manual', is_locked, solver_generation` (the run's CURRENT marker at lock time).
2. **The regeneration.** `commitElectiveRun` (electron/ops/commitElectiveRun.js, line ~847) writes to the SAME derived id: `run_id, occurrence_id, camper_id, activity_id, choice_id, preference_rank, source:'solver', solver_generation:<new uuid>`. It never writes `is_locked`. Its only protection is the local skip at `protectedIds` (line ~424, applied at ~802), built from `is_locked = 1` rows in THIS device's projection (line ~391).
3. **Merge.** Each field is its own Automerge key (`electron/automerge/reconcile.js` header). Two devices writing the SAME key to different values produce a per-field last-write-wins projection AND a `conflicts` row per differing key (`electron/automerge/conflictStore.js`, `recordConflicts`). Equal values dedupe. Only `camps.rendezvousSecrets` is machine-resolved (reconcile.js line ~94); `elective_assignments` has no exemption.
4. **Read side.** `electiveGenerationVisibleFragment` (electron/ops/electiveGenerationPredicate.js) shows a row if `source='manual'` OR `solver_generation IS <run's current>`. `is_locked` is not consulted.

### The merged state in the concrete scenario

A locks seat X to P (writes `source=manual`, `solver_generation=G0`, `is_locked=1`); B, partitioned, regenerates (writes `activity_id=Q`, `source=solver`, `solver_generation=G1`, and the run row to G1).

- Keys written by both with different values: `activity_id`, `source`, `solver_generation` (and `choice_id` / `preference_rank` when they differ). `is_locked` was written only by A, so it stays 1 with no conflict.
- Each key is decided independently by Automerge's op-id order, so the projected row can be any mix. Three outcomes follow:
  1. All solver wins: `is_locked=1`, `source='solver'`, activity Q, generation G1. Looks locked, holds Q.
  2. `source='solver'` with `solver_generation=G0`: the row is predicate-hidden (stale) while `is_locked=1`. The seat vanishes from the run.
  3. `source='manual'` with `activity_id=Q`: a "manual" seat holding the solver's activity.
- **It is not silent.** A pending `conflicts` row exists for every differing key, on every device. But `ConflictsScreen` has no label for `elective_assignments`, so the director gets up to three or four cards reading "A change to this record", one of which compares two raw generation UUIDs. Resolving the `activity_id` card writes only that key; it does not repair `source` or `solver_generation`, so outcome 2 can survive a "resolved" conflict.

## Corrections to the ticket

- "No path writes `is_locked`, so the row ends up locked-looking with the solver's placement" is true for one of three reachable outcomes; the other two (hidden seat, manual-with-solver-activity) are not described.
- Direction 1 ("never write `source`") does not work: `activity_id` and `solver_generation` are written concurrently too, and the generation marker is what the predicate keys on. Skipping `source` alone leaves outcomes 1 and 2.
- Direction 2 (`is_locked:0` on regeneration) would add a fourth conflicting key and, where the lock HAS merged, would only be safe because of the local skip. It turns nothing silent into anything visible; the conflicts already are.
- "Silent" is wrong for the merged state: conflict rows are raised. What is missing is a readable, repairable presentation.

## Directions considered

- **A. Never write `source`** (ticket 1). Rejected: see above; does not remove the concurrent keys.
- **B. Write `is_locked:0`** (ticket 2). Rejected: adds a conflict key, changes nothing about the seat.
- **C. Post-merge detection surfaced as run-level state** (ticket 3), keyed to what the projection can prove. Recommended.
- **D. Machine-resolve the three solver-owned keys on `elective_assignments`** in reconcile (as `rendezvousSecrets` is), so the director sees exactly one card, `activity_id`. Folded into C as its presentation half.
- **E. Auto-heal: any device seeing `is_locked=1` with a solver row re-asserts the locked activity from the conflict row's values.** Converges (same values from every device) but must pick the lock's activity out of two unlabeled conflict values and is new write-on-read behavior on merge. Deferred; revisit only if C's director action proves too heavy.
- **F. A separate lock record the solver never writes.** Clean, but a new table or a new field family plus migration for a rare race. Rejected as larger than the problem (karpathy).

## Decision (recommended)

**Detect from the merged projection and surface one run-level finding, `LOCKED_SEAT_OVERWRITTEN`, the way `DANGLING_MANUAL_ASSIGNMENT` is surfaced; and stop showing the solver-owned keys as separate conflict cards.**

1. **Finding.** A seat is overwritten when `is_locked=1` AND NOT (`source='manual'` AND the row is visible under the predicate), i.e. outcomes 1 and 2, read straight from the projection with the existing predicate fragment (no second copy of the predicate text). Outcome 3 is left to the `activity_id` conflict card, which exists.
2. **Message.** Names the camper, the activity the director locked (taken from the pending `activity_id` conflict values, since the row no longer holds it) and the solver's activity. One action: restore, which calls the existing `setElectiveAssignment(..., locked:true)`. No new IPC.
3. **Conflict presentation.** `solver_generation` and `source` on `elective_assignments` are machine-resolved in reconcile (a skip identical in form to line ~94), so the director sees one card per seat, not four, and never a UUID. `activity_id` gets a plain label in `ConflictsScreen`.
4. **Local skip stays.** The T246 skip in `commitElectiveRun` remains; it still prevents the overwrite wherever the lock HAS merged.

**Confidence: medium (about 65%).** High on the diagnosis (read directly from the code paths above); medium on the finding's detection rule because the mixed-key outcomes depend on Automerge op-id ordering, which the test must pin rather than assume. Evidence to raise it: the two-device test below, run with the lock op deliberately ordered both before and after the regeneration in op-id terms so each outcome is actually produced.

## Pinning test (non-vacuous)

A new integration scenario beside `test/integration/scenarios/33-move-convergence.automerge.js` (which already uses `partitionClients`; see `test/integration/harnessAutomerge.js` line ~619). Scenario 34 is NOT this test: it commits and locks on one device, so the regenerating device always sees the lock.

1. Seed and merge a run and a solver-placed seat on both clients; confirm both hold it.
2. `partitionClients`. On clientA call `setElectiveAssignment(... locked:true)` to activity P. On clientB call `commitElectiveRun` with the same `runId` placing the camper in Q. Assert, before healing, that clientB's local `is_locked` is 0 for that seat, otherwise the test is vacuous.
3. Heal. Wait for both devices to converge. Assert the converged row, `LOCKED_SEAT_OVERWRITTEN` on both devices, and exactly one visible conflict item for the seat.
4. Run the restore action on one device; assert both devices end at `source='manual'`, activity P, `is_locked=1`, no finding.
5. Plant: remove the finding detector and confirm step 3 fails; remove the reconcile skip and confirm the one-card assertion fails.

## Blast radius

- Read/derive: one new finding kind next to `buildDanglingManualAssignmentFinding` in the run read path; one skip in `electron/automerge/reconcile.js`; one label in `src/screens/ConflictsScreen.jsx`. Run screen gains one item type (DESIGN_STANDARD applies: the item needs the same feedback and reduced-motion treatment as the dangling-assignment item).
- No write-path change, no schema change, no wire change. `npm run schema:check` is not triggered. Reversible by deleting the detector and the skip.
- Contract check (org-interface-contracts): idempotent (finding derived, not stored; restore is the existing derived-id write); concurrent retry safe (same values converge); error shape unchanged (restore returns existing `{ok:false,error}` refusals); no `authorize()` or camp-scope boundary touched.

## Open question for the owner

Is "the director is shown one item and restores with one tap" acceptable, or must a lock win automatically? Auto-win is direction E; it is more code and writes on merge. Recommendation: ship C, and only build E if directors report the item as friction.

## Decision record

2026-10-11, keeper (delegated owner authority): "GO-A: one plain item with one-tap Restore, the solver_generation/source cards stop surfacing, and the activity card is labelled." The automatic lock-wins-on-merge alternative stays deferred.
