---
title: "A blank limited capacity is named, and it blocks the run"
document_type: ticket
status: completed
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_runs: [docs/work/runs/2026-09-29-t316-blank-limited-capacity.md]
related_tickets: [docs/work/tickets/T245-draft-assignment-move-lock-ipc.md, docs/work/tickets/T265-minimum-headcount-to-run.md, docs/work/tickets/T302-nothing-stops-the-next-finding-printing-a-label-key.md]
archive_when: "a confirmed offering whose capacity_mode is 'limited' with a blank capacity_limit produces a director-readable finding naming that activity, the run refuses to solve and cannot be committed while one exists, and the offering never reaches the engine as capacity 0 — each asserted by a test that goes red when the production change is reverted"
---

# T316 — A blank limited capacity is named, and it blocks the run

Owner ruling, 2026-09-29, verbatim: **"blank capacities need to be filled in."**

## What a director experiences today

They set an elective offering to capacity mode *limited*, leave the number blank, and run electives.
Nobody is placed in that offering. Nothing says why.

## Why

`resolveOfferingCapacity` (`electron/ops/electiveOfferingCapacity.js`) already names the case:
`('limited', NULL)` resolves to `{ kind: 'unknownLimit' }`. Its own header records that **nothing in
this codebase surfaces that to a director today** — T245 deliberately named the case and left each
caller's behaviour alone.

Both callers then read it as something it is not:

- `src/screens/elective/assignment/buildOfferings.js` maps it through
  `resolved.kind === 'limited' ? resolved.capacity : 0`, so `unknownLimit` becomes **capacity 0**.
  `src/engine/buildElectiveAssignments.js` does `Math.max(0, o.capacity ?? 0)` in both its
  capacity reads, so 0 is a **closed** offering. The offering is silently shut, not reported.
- `getElectiveRunHandler`'s over-capacity block (`electron/main.js`) skips the row instead —
  the read path's own comment says so, and says the case is surfaced nowhere.

`INVALID_CAPACITY` exists in this repository only as a **name in comments** (`electron/main.js`,
`electron/db/schema.sql`) and in prose (`docs/adr/2026-09-17-individual-elective-scheduling.md`:
"Negative or non-integer remains INVALID_CAPACITY and blocks generation"). No code emits it.

This is the product rule in `CONSTITUTION.md` Article V being broken in the quietest possible way:
the engine absorbed a problem to look tidy.

## What must be true

1. A confirmed offering resolving to `unknownLimit` produces a finding, `kind: 'INVALID_CAPACITY'`,
   naming that activity the way the director spells it, carrying its `activity_id` and the
   `elective_set_activities` row id so the screen can act on it. One plain sentence in director
   vocabulary.
2. The run **refuses to solve** while such a finding exists: `buildElectiveAssignments` is not
   called, `commitElectiveRun` is not called, and the sentence is shown in the existing findings
   surface. No banner, no help text, no new explainer, no disabled control with a tooltip.
3. The offering never reaches the engine as capacity 0.
4. The two comments that assert the case is surfaced nowhere say what is now true instead —
   narrowed to exactly what changed, not widened past it.

## Out of scope

Minimum-to-run (`unknownMinimum`) semantics; any schema change; the dev mock's row shape; editing
capacity from the run screen (capacity is edited where it lives, on the elective set screen);
anything touching auth or security.

## Non-vacuity bar

The test that asserts each of (1)(2)(3) must go **red when the production change is reverted**, and
that revert must be recorded. A hand-built offering object asserts something about the fixture, not
about the system — these go through `buildOfferings` from a stored-row shape, which is the bar
`buildOfferings.test.js` already sets for itself.

## Known limit at close

`archive_when` is discharged: the finding exists and names the activity, the run refuses to solve and
cannot be committed while one exists, the row no longer reaches the engine at capacity 0, and each of
those goes red when the production change is reverted (re-run independently by Verifier, not taken on
Maker's word). What remains is real and outside this ticket, recorded rather than quietly inherited:

- **The write path is fixed too, by owner ruling mid-ticket.** `electron/ops/setElectiveAssignment.js`
  used to reject a director's manual move into such an offering as `OCCURRENCE_FULL` with `capacity: 0` —
  a misconfigured offering reported as a full one. The owner ruled it in scope ("a defect you find at a
  seam you are already changing is FINISHED, not recorded"), so it now refuses distinctly as
  `INVALID_CAPACITY`, naming the offering in the director's own words, and that sentence is what the
  director reads instead of the raw code. It is true for all three actions that share that write path — a
  move, the Lock checkbox, and release-lock — and it never reads `"undefined"` when the activity row is
  gone. **What that leaves:** `docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md`
  documents this channel's refusal union as three members and it now has four. An agent may not amend an
  ADR (Art. IV), so that needs the owner. The dev mock has no capacity lookup, so browser-dev cannot
  reproduce this refusal at all — its comment now says so.
- **`unknownMinimum` is untouched by design.** T265's mirror defect — `('required', NULL)` — still
  enforces nothing and says nothing. The asymmetry is now *visible* to a director who hits both in one
  set, which is a worse experience than two equally silent halves, and is the argument for doing it next.
- **A refused run has no on-screen way back.** Pre-existing: before T316 a set whose only offering was
  blank already produced a zero-assignment preview with no back control. T316 makes the reason legible
  without giving the director a way out of the state. Fixing it means adding a control — product
  judgement, deliberately not invented here.
- **No director has seen this.** No Tester ran; there was no app in this session. The sentence's wording
  and the refusal's feel are read, not observed.
