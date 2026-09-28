---
title: "A director can see one camper's elective week on screen"
document_type: ticket
status: open
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
