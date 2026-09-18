---
title: T195-preference-import-service
document_type: ticket
status: completed
created: 2026-09-17
archive_when: the offering-grid import ships and a real offering sheet imports cleanly
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T195 — the elective OFFERING grid import (rescoped)

**Filename kept for continuity; scope is not what round 1 built.** Round 1 (preserved in git
history, not on the tip) built a camper-preference import — ranked choices per occurrence, linked
choices declared by a director on a mapping screen, campers/preferences/assignments written through
the op-log. Real camp artifacts, examined outside this repo, contradicted that premise: camper
responses are a **global 1-25 ranked list**, or a **chosen-schedule-plus-alternates planner** — never
ranked choices per occurrence — and double-period/multi-day **linkage is a property the camp
declares on its offering catalog**, not something a camper expresses. That code was removed from the
tip in the parking commit preceding this ticket's current work; it is not lost, only retired.

T195 is now: **import a day × period grid of elective OFFERINGS.** No campers, no ranks, no identity,
no assignment — see Non-goals.

## What this imports

A camp's offering sheet is a grid: one axis is time (day or period), the other is day/period's
counterpart, and each cell is a **menu** of ~13-20 activity names sharing that day/period — not one
name per cell. This extends the existing shared grid parser rather than building a new one:

- `src/ingest/parseGridSchedule.js` gains `parseGridScheduleMenu(pages, { cellSplitter })`, reusing
  `sheetToPage` and all the existing orientation/time/canonicalization logic unchanged — only the
  innermost per-cell step changes from "one name" to "N names sharing one timeIndex/groupIndex".
- `src/ingest/electiveSetPopulate.js` gains `populateElectiveGrid(...)`, which resolves
  `timeIndex -> time_block` and `groupIndex -> day_id` by name match against the camp's existing
  entities (never inventing either silently — an unresolved axis label is reported in `unmapped` and
  that column/row is skipped), mints or reuses one `elective_sets` row per `(day_id, time_block_id,
  schedule_week_id)`, and populates each set's offerings through the existing per-row upsert
  `populateElectiveSet` already implements.

## The safety property: import never promotes

`elective_set_activities` gains a `status` column (`potential` | `confirmed`, default `confirmed` so
every existing/hand-authored row keeps today's meaning unchanged). The importer is the **only**
writer that ever says `potential`. Per activity:

- no existing row for `(set, activity)` → write `status: 'potential'`
- existing row `status: 'potential'` → rewrite the same fields (idempotent)
- existing row `status: 'confirmed'` → **skip entirely, touch no field** — import can never regress a
  director's confirmed decision, and there is no promotion logic to get wrong because import never
  promotes. Confirmation is director-driven.
- an activity that fell off a later sheet is left alone — no auto-delete, no auto-demote (owner
  ruling pending; a named limitation, not an oversight).

A `potential` offering is filtered at the three **consumption load boundaries** —
`src/data/scheduleRepository.js`, `electron/ops/scheduleInputNormalization.js`,
`scripts/mcp/tools.js` — so it is never placeable, never counted toward capacity, never exported.
It is **never** filtered at the **authoring boundary** — `src/screens/elective/ElectiveSetDetail.jsx`
and `src/screens/ScheduleElectivesScreen.jsx` must keep seeing it, since that is where a director
reviews and confirms it.

## Linkage markers — surfaced, never applied

`parseGridScheduleMenu` detects known glyph characters on a cell's raw text, strips them before
name-matching, and returns them in `linkageMarkers: [{ dayIndex, periodIndex, activityName,
markerType, sourceExcerpt }]`. `populateElectiveGrid` never reads this array — it passes it straight
through. Nothing infers a span, writes a multi-block set, or touches `activities.span_blocks` /
`is_span_head`.

**Open and unverifiable in this repo:** the exact glyph characters and the cell-delimiter convention
(literal newlines in one XLSX cell? merged cells? sub-rows?) are not known, because the real artifact
is outside this repo and off-limits. `cellSplitter` is therefore an injected, swappable unit with a
sensible default (newline/semicolon-aware) — the SEAM is tested, not the convention. Multi-day
linkage modelling is out of this slice — see T219.

## Non-goals

Campers, preferences, ranks, identity, assignment (all round-1 scope, parked — see above); the
promotion UI (a director flipping `potential` → `confirmed` from the schedule side) — a natural
follow-up, not required for this to land safely inert; multi-day linkage (T219); third-party export
adapters (T218); auto-demotion of an offering that falls off a sheet.

## Exit condition

A grid sheet imports offerings without inventing a day or time block; a director's confirmed
decision is never touched by any re-import; a potential offering is invisible to the schedule engine,
schedule conflicts, and every export, while remaining visible on both authoring screens; the
migration (`elective_set_activities.status`, schema v68) round-trips fresh vs. migrated with an
identical column set, and rolls back cleanly.
