---
title: T248-child-schedule-export
document_type: ticket
status: open
created: 2026-09-23
archive_when: a per-camper child schedule export exists, is span-aware, reads the finalize snapshot for a final run and derives live for a draft, uses T244's shared generation-visibility predicate (not a re-derived filter), surfaces finalizedAgainstStaleGeneration when reading a final run, a cross-handler fixture test proves getElectiveRunHandler and get-elective-run-outer-schedule agree on roster membership, and no new staff-reachable path was added
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T248 — per-camper (child) schedule export

Implements ADR 2026-09-23 decision (d): the export contract T197 never built and D12 flagged as a
known gap (span-unaware group export).

## Scope

- `electron/main.js`: `getElectiveRunOuterScheduleHandler({token, runId})`, read-only,
  `elective_assignment_runs.read`. For `status==='final'`, straight read of
  `elective_run_outer_snapshots`. For `status==='draft'`, derive live via existing
  `collectSpanTails`/`getActivityRowSpan` helpers against the run's assigned campers' groups.
  `electron/preload.js` exposure.
- **Import T244's shared `electiveGenerationPredicate.js` fragment and use it when reading
  `elective_assignments` for the draft-derive path — do not write a second, independent filter.**
  This is the ADR's MEDIUM-4 finding: the original version of this ticket enumerated assigned
  campers on its own, which would have let this export disagree with `getElectiveRunHandler`'s
  roster (UI correct, printed/exported roster wrong) the moment a generation went stale. Also
  surface `finalizedAgainstStaleGeneration` (T244) in this handler's response for a final run, so
  an export of a run later found to have finalized against a stale generation carries that warning
  rather than presenting as unconditionally trustworthy.
- `src/screens/elective/export/exportChildSchedule.js`: renderer-side utility, `format_version: 1`,
  per the ADR's JSON shape. Combines `getElectiveRun`'s existing assignment rows with the new outer
  schedule rows into one per-camper `schedule` array, span-collapsed (one row per span, not one per
  block).
- Verify: no `authorize()` bypass, no new nav entry reachable from a staff-only screen. The
  negative-permission test pattern D9 already established (staff hold no `elective_assignment_runs.read`)
  covers this by construction — add this ticket's IPC action name to that existing negative test
  rather than writing a new one.
- **Cross-handler roster-parity fixture test (residual of ADR MEDIUM-4).** T244's own six cases and
  this ticket's own seam each exercise one handler in isolation — nothing today would catch a future
  reader that stops importing `electiveGenerationPredicate.js` and re-derives its own filter. Build
  one fixture with a regeneration that leaves a stale-generation solver row and a `source='manual'`
  row behind, call both `getElectiveRunHandler` (T244) and this ticket's
  `getElectiveRunOuterSchedule` draft-derive path against it, and assert the two report **identical
  roster membership** — same camper set, same manual-row inclusion, same stale-row exclusion. This is
  the test that would fail the moment either handler's predicate drifts from the shared module.

## Non-goals

Any UI trigger for this export (T250 wires the button; this ticket is the contract and the data
path). Fixing `src/utils/exportSchedule.js`'s own span-unawareness for the *group* export — out of
scope, tracked as D12's separately-noted defect, not duplicated here.

## Test seam

The new IPC read touches `electron/ops/**` — **mandatory integration harness** for the handler
(final-run snapshot read path and draft-run live-derive path, both against a real db). The renderer
utility is pure JSON shaping — unit-testable directly.

## Dependencies

T243 (schema, for the snapshot table). **T244, now a hard dependency (not just for fixtures)** — this
ticket imports T244's shared `electiveGenerationPredicate.js` module directly; it cannot be built
correctly in isolation from it. A final run must also exist to test the snapshot-read branch, which
needs T244's finalize path to produce real snapshot rows. **Shares `electron/main.js`/
`electron/preload.js` with T244, T245, T249** — ordinary git merge-conflict risk, not a logic
dependency; append to the existing elective block per T244's convention note.
