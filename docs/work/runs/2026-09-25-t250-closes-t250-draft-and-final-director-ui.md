---
task: T250: closes T250 — Draft and Final director UI
document_type: run
date: 2026-09-25
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T250-draft-and-final-director-ui.md]
related_specs: [docs/work/specs/2026-09-25-t250-run-state-surface.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
selected_agents: [maker, code-reviewer, red-hat, security, verifier, grader, governor]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no new persistent data shape and no changed contract other modules call — the one IPC edit is two additive columns on a read this UI is the only consumer of.
  - agent: designer
    reason: not-applicable
    note: a design spec for exactly this surface already existed and governed the work (docs/work/specs/2026-09-25-t250-run-state-surface.md).
  - agent: tester
    reason: not-applicable
    note: verification is component-level against the mock client — no Electron run was performed, and that gap is stated rather than papered over.
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass-with-named-residuals
completion_evidence:
  - commit 8cfc2167
  - commit cb881cf5
  - commit c9f58d7c
  - gate: CI is the gate of record — the PR run of .github/workflows/gate.yml; the local verify verdict line is quoted in the PR description rather than here, because a record citing its own verdict breaks when the record is edited and re-gated.
archive_when: never — a run record is the durable account of one pass and is not archived
---

# T250: closes T250 — Draft and Final director UI

## What shipped

- T250: closes T250 — Draft and Final director UI
- T250 round 2: an unread run must never read as a clean one
- T250: Draft and Final director UI for an elective run

## Evidence

- commit 8cfc2167
- commit cb881cf5
- commit c9f58d7c
- gate: CI is the gate of record for this change (the PR run, .github/workflows/gate.yml).
    The local `npm run verify` verdict line is quoted verbatim in the PR description; it is
    deliberately not restated here, because a record that cites its own gate verdict breaks
    the moment the record itself is edited and re-gated.

## Agents

Ran: **maker** (two rounds), **code-reviewer**, **red-hat**, **security**, **verifier**,
**grader**, under **governor**.

Omitted, with reasons recorded in the frontmatter above: **architect** (no new persistent
shape, no changed contract), **designer** (a spec for this exact surface already existed and
governed the work), **tester** (no Electron or dev-server run was performed — stated as an
unproven gap, not covered).

## What this pass actually settled

T244 computed `finalizedAgainstStaleGeneration` and rendered it nowhere. The owner's
2026-09-23 immutability ruling — a finalized run is immutable, a revision is a new run,
there is no reopen — was accepted **as a package** with that detection reaching the
director, so until it rendered, the ruling stood on one leg. It now renders inline in the
run's own run-state area, beside the single "Start a revision" control that is its remedy.

The render surface was contested inside its own ADR. Lines 312-316 say to render it "as a
finding using this repo's existing per-slot findings vocabulary"; the `## Amendment
(2026-09-24)` at lines 53-96 supersedes that, because the findings vocabulary is
week-scoped, mounts only in `FindingsRail.jsx`, and has no `groupId` for a run. Lines
735-736 confirm the correction inside the Q1/Q2 ruling. **This work followed lines 53-96.**

Round 2 closed a defect of exactly the kind the ticket exists to prevent, one layer up:
`FinalRunView` read the run state off an all-clear default with no gate on the load, so a
failed `getElectiveRun` rendered a screen that looked finalized-and-clean with Export and
"Start a revision" both live. An unknown must never read as "not stale".

## Named residuals — these are not silent

- `DANGLING_MANUAL_ASSIGNMENT` is surfaced live in the session that produces it, but not on
  a run reopened cold. It arrives on the `commitElectiveRun` result, not on
  `getElectiveRun`, and cannot be derived durably today: nothing in `electron/` ever deletes
  an `elective_occurrences` row, so the persisted set is the union of every generation's and
  a handler-side check would report a false all-clear. Pruning that table is the
  prerequisite and is outside this ticket.
- "Release lock" cannot resolve the dangling condition. `setElectiveAssignment` writes
  `source='manual'` unconditionally and the finding is keyed on `source`, never `is_locked`.
  The row therefore stays after a release instead of pretending to be fixed, and only the
  button retires. The spec chose this remedy without knowing that; a remedy that closes the
  condition needs a re-place picker nobody has designed.
- The export payload does not carry `finalizedAgainstStaleGeneration`, which the ADR's line
  317 asks for. That concerns T248's already-shipped contract and ADR decision (d), on which
  the owner has not ruled. Left untouched deliberately.
- No Electron or browser-mock run: every claim here is jsdom component-level.
