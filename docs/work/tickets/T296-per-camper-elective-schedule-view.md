---
title: "A director can see one camper's elective week on screen"
document_type: ticket
status: completed
created: 2026-09-28
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-26-per-cell-elective-preferences.md]
related_tickets: [docs/work/tickets/T297-edit-a-campers-elective-preferences.md, docs/work/tickets/T265-minimum-headcount-to-run.md]
archive_when: "a director can open one camper from an elective run and see that camper's week — every occurrence, the activity placed there, and whether it was a ranked choice or a fallback — without exporting a workbook; the view is reachable from the elective screens; and a test drives the real screen and asserts the rendered week matches the assignment rows in the database for a camper with at least one unranked placement"
---

# T296 — A director can see one camper's elective week on screen

## The gap, verified 2026-09-28

Asked whether a director can look at an individual camper's schedule, the answer is **no — not in
the app.**

- `src/screens/elective/assignment/AssignmentPreview.jsx` groups by **occurrence**: for each
  (day, period) cell, which campers are in which activity. Its own header comment is explicit —
  *"per-activity camper rosters with flag chips. Never a flat table."* That is the staffing view:
  who is at archery on Monday, period 3.
- The **camper-centric** view exists in exactly one place: the exported workbook. The first sheet of
  `src/screens/elective/export/exportElectiveRunWorkbook.js` is literally *Child Schedules*, one row
  per camper per slot.
- There is no campers screen and no child detail view anywhere in `src/screens/`.

So "what does this camper's week look like?" is answerable today only by exporting to Excel and
reading it there.

## Why this is a view problem, not a model problem

The export already assembles per-child schedules from rows that are in the database
(`exportElectiveRunProjection.js`). Nothing new needs to be stored. This is a projection that exists
and has no on-screen surface.

## Non-goals

- Not a parent- or camper-facing artifact. This is the director's view. A family-facing version is a
  different question about audience and distribution and should not be smuggled in here.
- Not an edit surface. Changing a camper's preferences is T297.
- No new export. The workbook already covers the paper case.

## Notes for whoever takes this

- The occurrence-grouped preview and this view answer two different questions for two different
  moments; they should sit beside each other rather than one replacing the other.
- A placement that came from a whole-run fallback rather than a ranked cell choice is the thing a
  director most wants to see at a glance — `rank_kind` and the coordinate columns (schema v79) carry
  what is needed to say so.
- Standing design rulings apply: no banners, no explainer copy, inline styles on `S`, the one scoped
  CSS exception does not extend here.

## How it closed

`src/screens/elective/run/CamperWeekPanel.jsx`, mounted on **both** run screens below their existing
content — the occurrence-grouped preview is untouched and the two sit beside each other. A roster of
the campers the run actually placed; clicking one shows that camper's week, one row per occurrence:
when, the activity, and the ranked-or-fallback verdict. Bronze `--accent` rail and label on a
placement the camper never ranked, neutral hairline on one they did, per DESIGN_STANDARD §4 — red is
not in play, because the solver did its job.

Projection reuse, the ticket's main architectural question: **the export projection was NOT reused,
and the ticket's premise that it could be is wrong.** `exportChildSchedule.js` is built from the
run's OUTER schedule rows — the whole grid week including inherited cells, span- and
linked-choice-clustered — and carries **no rank at all**. This view needs the opposite slice (the
elective placements, each with its rank provenance) from a different source (`elective_assignments`,
which is what the archive_when names). They are two projections of two different things, so a new
pure module (`camperElectiveWeek.js`) is correct and folding them together would have meant bumping
that export's `format_version` for a screen.

## Known limits at close

The archive_when is fully discharged. These are true and were found on the way:

- **`rank_kind` is not on the assignment row.** The ticket says v79 "gives you `rank_kind` and the
  coordinate columns to say so"; v79 put `rank_kind` on `elective_preferences`, and
  `elective_assignments` carries only the bare `preference_rank` integer. Ranked-vs-fallback is
  therefore read from `preference_rank IS NULL`, which is exactly what the predicate asks for and is
  the same signal `satisfactionSummary` and `exportRunSummary` already use. What it cannot say is
  whether a camper's ranks were *ordered*: for a sheet read as an unordered set, "Second choice"
  names a position the camper never expressed. Closing that needs `rank_kind` carried onto the
  assignment row.
- **`occurrenceLabel` still labels from the wrong occurrence set.** `getElectiveRun` now returns the
  run's persisted occurrences (a run opened from the run list previously had none, so this view would
  have printed ids). The `occurrences` prop was renamed `templateOccurrences` to make the two sets
  legible, but the over-capacity rows on both run screens still label from it and so still degrade to
  a bare activity name on a reopened run. Deliberately not changed here: T250's rendered copy, with
  its own tests.
- **`occurrenceLabel` reads `days.name`, but `days_of_operation` stores it in `label`** — so a day
  never resolves there and the label silently collapses to the time block alone. Pre-existing;
  reported, not amended.
