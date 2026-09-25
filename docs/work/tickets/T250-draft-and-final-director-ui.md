---
title: T250-draft-and-final-director-ui
document_type: ticket
status: completed
created: 2026-09-23
archive_when: the Draft state (move/lock, regenerate with staleness offer, run list, satisfaction summary, overCapacityOccurrences and DANGLING_MANUAL_ASSIGNMENT surfaced live) and Final state (read-only identity, export, start-a-revision, finalizedAgainstStaleGeneration and overCapacityOccurrences surfaced inline in the run's own displayed run-state area on this screen, not via the schedule findings vocabulary) from T199's director-flow table are both built and reachable only by admin
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


> **Owner ruling, 2026-09-23 — binding condition.** Q1/Q2 (a finalized run is immutable; a revision
> is a new run, there is no reopen) was accepted **as a package** with the
> `FINALIZED_AGAINST_STALE_GENERATION` detection and its rendering to the director. If the detection
> does not ship inside T244 alongside finalize, and T250 does not render it, **the immutability
> ruling does not hold and the question returns to the owner.** Neither piece may be deferred out of
> these two tickets to unblock a release.
>
> **Surface corrected 2026-09-24 (owner) — the condition is unchanged, only the surface.** The ADR
> originally said "as a finding using this repo's existing per-slot findings vocabulary". That is
> not buildable: the findings vocabulary is schedule-week-scoped, its only mount in the app is
> `src/components/schedule/FindingsRail.jsx` at `src/screens/ScheduleScreen.jsx:1142`, its only
> actions are Accept and Locate (Locate gated on `row.groupId != null`), and an elective run has no
> `groupId`. Run-level state therefore renders **on this screen, inline, as part of the run's own
> displayed state** (the same place the screen already says Draft vs Final) — not as a schedule
> finding and not as a banner. The director must still be told; that requirement is not softened.
> See the ADR's "Amendment (2026-09-24)".

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
  **Surface T244's `finalizedAgainstStaleGeneration` and `overCapacityOccurrences` on this
  screen (residual of Red Hat H2/H3 — a detection nobody renders is functionally no detection).**
  When `finalizedAgainstStaleGeneration` is true, render it **inline in the run's own run-state
  area** — the same part of this screen that already states Draft vs Final — not in the schedule
  findings vocabulary and not as a banner (see the ruling note above and the ADR's
  "Amendment (2026-09-24)"). Copy names what happened ("finalized before a later change on another
  device synced in; it is out of date") and it must sit with the "start a revision" action already
  on this screen — that action *is* the remediation, so the two appear together, not the state
  alone. `overCapacityOccurrences`, when non-empty, renders per-occurrence in that same inline
  run-state area, naming the occurrence and the over-count. This ticket names the surface; it does
  not inherit any design beyond that.
- Both states admin-only, verified not reachable from staff navigation (`src/components/layout/navSections.js`).
- No banners. Slot-level state (unassigned reasons and anything else genuinely scoped to a schedule
  slot) uses the existing findings vocabulary; **run-level state uses the run's own inline displayed
  state on this screen.** Do not route run-level state through the findings vocabulary — it cannot
  express it (no `groupId`, no locator, no per-row action slot).

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

## Known limits at close (2026-09-25)

Recorded here so `status: completed` cannot be read as claiming more than shipped. Neither limit was
fixable inside this ticket, and both are on the owner's board for a ruling.

**`DANGLING_MANUAL_ASSIGNMENT` is surfaced live but is not durable.** The `archive_when` clause asks
for it "surfaced live", and it is — in the session that produces it, during ordinary draft work.
It is **invisible on a run reopened cold**: the finding rides the `commitElectiveRun` result, not
`getElectiveRun`. It cannot be derived durably either, because nothing in `electron/` ever deletes an
`elective_occurrences` row, so a handler-side "does this occurrence still exist?" check would find
the row present and report a false all-clear — an affirmative wrong answer, worse than a known gap.
Pruning `elective_occurrences` on regeneration is the prerequisite, and it is a data-lifecycle change
with migration and sync implications (T243/T244 territory), not a UI change.
Note `src/localClient.mock.js` *does* prune by `run_id`, so the mock is strictly more correct than
production and mock-backed tests cannot see this.

**"Release lock" does not resolve the dangling condition.** `setElectiveAssignment` writes
`source='manual'` unconditionally, while the finding is keyed on `source` and never on `is_locked`,
so releasing the lock changes a field the finding does not read. This is a defect in the design spec's
choice of remedy, not in its implementation. Round 2 stopped the row from vanishing on release, so the
screen no longer claims a fix it did not make — but the condition is surfaced with no working in-screen
remedy. The real remedy is a re-place picker, which nobody has designed.

The immutability condition this ticket exists to discharge is **not** affected by either limit: it
rests on `finalizedAgainstStaleGeneration`, which is rendered, paired with its remedy, and proven
load-bearing by a non-vacuity plant.
