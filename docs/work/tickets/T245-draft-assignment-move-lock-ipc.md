---
title: T245-draft-assignment-move-lock-ipc
document_type: ticket
status: completed
created: 2026-09-23
archive_when: shoresh:set-elective-assignment is callable, writes the same derived row the solver writes, refuses on a final run, is capacity/eligibility-checked using the engine's own resolution helpers, and sets solver_generation exactly once with no later re-stamp anywhere in the codebase
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T245 — draft assignment move/lock IPC

Implements ADR 2026-09-23 decision (b)'s write path: `shoresh:set-elective-assignment`.

## Scope

- `electron/main.js`: `setElectiveAssignmentHandler({token, runId, camperId, occurrenceId,
  activityId, locked})`. Writes `deriveElectiveAssignmentId(run_id, camper_id, occurrence_id)` —
  the same id the solver's write path already produces — with `source='manual'`,
  `is_locked = locked ? 1 : 0`, `solver_generation` set once, at write time, to the run's current
  marker. **Corrected 2026-09-23 (Red Hat H3): do not design or build any mechanism that re-stamps
  this field later.** The original version of this ticket had T246's regeneration path re-stamp
  every locked row's `solver_generation` on each regenerate, "carrying it forward." That is wrong:
  the re-stamp reads locked rows from whichever device is regenerating, so a lock made on one
  device that hasn't synced to the regenerating device is silently skipped and left on a stale
  marker — which then gets excluded from the read path and disappears from the screen with no
  error. The actual fix lives in the read-side predicate (T244's shared
  `electron/ops/electiveGenerationPredicate.js`): rows with `source='manual'` are visible
  regardless of `solver_generation`. This ticket's write path is simpler as a result — it sets the
  field once and never touches it again.
- Refuses `RUN_NOT_DRAFT` once `status==='final'`.
- Capacity/eligibility checks: extract (do not duplicate) the eligibility/capacity resolution
  `buildElectiveAssignments` already performs internally into a small shared helper both the engine
  and this handler call, per `codebase-design`'s "one definition of X" principle — this is the one
  piece of engine refactor this ticket owns; T246 depends on the resulting shared helper existing.
- `electron/preload.js` exposure, mirroring `commitElectiveRun`'s comment style noting this is an
  admin-only write.

## Non-goals

Engine consumption of locked seats during regeneration (T246 — this ticket only makes the row
correct; T246 makes the solver respect it). UI (T250).

## Test seam

Touches `electron/ops/**` — **mandatory integration harness**. Cases: (1) locking a camper into an
occurrence with room succeeds and the row's `source`/`is_locked`/`solver_generation` match the ADR;
(2) locking into a full occurrence returns `OCCURRENCE_FULL` with capacity/filled counts; (3)
locking an ineligible camper returns `CAMPER_INELIGIBLE`; (4) calling on a final run returns
`RUN_NOT_DRAFT`; (5) two devices concurrently moving the same camper to different activities in the
same occurrence converge to one row with a `conflicts` entry, not two rows (reuses the existing
per-field conflict test pattern from `elective_assignments`' D4 coverage).

## Dependencies

T243 (schema). Depends on T244 landing first (or in the same PR) only for the shared
`electiveGenerationPredicate.js` module this ticket's tests need to assert against — the handler
itself has no runtime dependency on T244's finalize path. Independent of T247 (parallel). T246
depends on this ticket's shared eligibility/capacity helper, **and on this ticket for the answer to
"what does a locked seat inside a linked choice do"** — T246 owns that decision (per the ADR's
ownership note); T247 must not re-decide it. **Shares `electron/main.js`/`electron/preload.js` with
T244, T248, T249** — ordinary git merge-conflict risk, not a logic dependency; append to the
existing elective block rather than reordering it, per T244's note.
