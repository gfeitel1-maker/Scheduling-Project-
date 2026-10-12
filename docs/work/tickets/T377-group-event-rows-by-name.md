---
title: "Fixed and Recurring Events show one row per event name, not one per day"
document_type: ticket
status: completed
created: 2026-10-12
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: []
archive_when: "the Fixed and Recurring Events tables group an event's days into one row, with edit-all, edit-one, delete-one and delete-all proven by tests, and stored data still one row per day"
---

# T377: group Fixed and Recurring Event rows by name

From the copy, clarity and consistency audit of 2026-10-12, finding A9
(`docs/work/evidence/ux-copy-a11y-2026-10-12/REPORT.md`, kept in the board keeper's worktree). The owner
put it in v1.

## Problem

Fixed and Recurring Events are stored one row per day. The tables showed them that way too, so a camp's
daily lineup was five identical rows (25 and 37 rows on the audited camp).

## Behaviour

- One row per event name, with its days in compact form ("Mon–Fri", "Mon, Wed, Fri", "Mon–Wed, Fri").
  Consecutive means next to each other in the camp's own list of days; runs of two are listed.
- Editing the grouped row (its name, time, location, divisions or notes) writes the same values to every
  day's row. The days themselves are shown, not edited, in that form.
- The row expands to show each day, and a day is edited alone from there.
- When the days differ, the row says so: "times vary", "varies" for divisions, "Varies" for weeks. Each day keeps its own week: the edit-all form never writes it, and the grouped Weeks select changes every day only when the director picks a week.
  In the edit-all form a varying time block starts unpicked, so one pick sets every day.
- Delete on the grouped row asks whether to delete every day or one day.
- An event on a single day keeps its plain row.

## Weeks (keeper question, 2026-10-12)

An event can be set to one week (its Weeks column). That is honoured everywhere it matters:
- Generate and Manual's fixed-event placement pass the week to the engine, which keeps an event only when
  it is every-week or that week. Pinned by `src/engine/buildSchedule.test.js` ("a fixed event set to one
  week only"); a plant that drops the engine's week filter fails both tests.
- A special day's "Also bring" offered every-week events only. It now also offers a week-only event when
  every placement of the special day is in that week, and still not when the placements span weeks (the
  special day's grid is shared by all its weeks). Red first in `copyCampTimeBlocks.test.js`.

## Not changed

Storage. There are no schema changes; this is presentation plus fan-out writes through the existing
per-row write and delete paths.

## Done

- `src/screens/setup/groupFixedEvents.js`: the grouping and the compact day label (8 tests).
- `src/screens/FixedEventsScreen.jsx`: the grouped row, expand, edit-all, and the all-or-one delete.
- `src/screens/FixedEventsScreen.grouped.test.jsx`: one row per name, times vary, edit-all, edit-one,
  delete-one, delete-all. Written red first.
- `scripts/finalAudit/steps.mjs`: the driver reads one entry per event per day from the grouped tables, so
  steps 1 and 10 still count each day.
