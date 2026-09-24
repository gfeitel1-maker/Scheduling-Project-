---
title: T250-draft-and-final-director-ui
document_type: ticket
status: open
created: 2026-09-23
archive_when: the Draft state (move/lock, regenerate with staleness offer, run list, satisfaction summary, overCapacityOccurrences and DANGLING_MANUAL_ASSIGNMENT surfaced live) and Final state (read-only identity, export, start-a-revision, finalizedAgainstStaleGeneration and overCapacityOccurrences surfaced via the findings vocabulary) from T199's director-flow table are both built and reachable only by admin
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T250 — Draft and Final director UI

Builds the two director-flow states T199 lists as missing: "Draft" (currently read-only, no
move/lock/regenerate/run-list/reopen per this session's ground-truth audit) and "Final" (currently
absent entirely).

**BLOCKED on owner answers to the ADR's Open Questions Q1/Q2 (revision semantics, final-run
immutability) and Q5 (director-facing terminology) before this ticket's copy is written.** The
underlying IPC/data work (T244-T248) is not blocked and should proceed; only this ticket's
user-facing text and the "start a revision" control's behavior are gated.

## Scope

- **Draft state**: wire `shoresh:set-elective-assignment` (T245) to a move/lock interaction on
  `AssignmentPanel`; surface rank received, capacity remaining, unassigned reasons (existing
  findings vocabulary), and a satisfaction summary. On Generate, if `finalize`'s staleness check
  (T244) — or an equivalent pre-check run at Generate time — detects drift, offer "re-derive and
  regenerate" inline per T199, never only a block. Add a run list (uses existing `listElectiveRuns`).
  **Also surface, live in Draft, the two findings that are produced during ordinary draft work and
  are actionable only there** (Red Hat round 3): `overCapacityOccurrences` (T244) renders
  per-occurrence as soon as it is non-empty, not only after finalization — a director can fix one
  placement in Draft, whereas on the Final screen the only remedy is to discard and redo the run;
  and `DANGLING_MANUAL_ASSIGNMENT` (T246), produced by ordinary draft regeneration when a locked
  manual row points at an occurrence the run no longer has, renders on the affected camper with the
  action that resolves it (re-place or release the lock). Neither is an "unassigned camper" finding,
  so neither is covered by the "unassigned reasons" bullet above; both are named here because a
  detection nobody renders is functionally no detection.
- **Final state**: read-only run identity (source file, route/week/division, `finalized_at`,
  `finalized_by` from T244's columns), an export action calling T248's `exportChildSchedule`, and a
  "start a revision" action whose behavior is Q1's answer (default assumption per the ADR: creates
  a new run, does not reopen this one).
  **Surface T244's `finalizedAgainstStaleGeneration` and `overCapacityOccurrences` findings on this
  screen (residual of Red Hat H2/H3 — a detection nobody renders is functionally no detection).**
  When `finalizedAgainstStaleGeneration` is true, render it via the existing per-slot findings
  vocabulary (no banner) with copy naming what happened ("finalized before a later change on another
  device synced in") and pointing at the "start a revision" action already on this screen — that
  action *is* the remediation this finding calls for, so the finding and the action must appear
  together, not the finding alone. `overCapacityOccurrences`, when non-empty, renders per-occurrence
  in the same vocabulary, naming the occurrence and the over-count.
- Both states admin-only, verified not reachable from staff navigation (`src/components/layout/navSections.js`).
- No banners; state surfaces through the existing findings vocabulary per repo convention.

## Non-goals

The "No run" and "Import preview" states (already built). The encryption disclosure (T249, separate
and unblocked).

## Test seam

Touches `src/screens/**` UI plus calls into `electron/ops/**` write paths already covered by
T244/T245's own mandatory-harness tests — this ticket's own tests are component/UI-level
(Vitest + Testing Library) exercising the wired handlers against the mock client
(`src/localClient.mock.js`, which T243 already registers the new entities into).

## Dependencies

T244, T245, T246, T248 (all four IPC/engine seams this UI wires to). Not dependent on T247 or T249.
BLOCKED (copy only, not code) on ADR Open Questions Q1/Q2/Q5.
