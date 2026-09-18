---
title: T219-multi-day-catalog-linkage
document_type: ticket
status: open
created: 2026-09-18
archive_when: multi-day/double-period offering linkage is modeled or explicitly rejected
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
---

# T219 — multi-day catalog linkage (design-stage)

Spun off from T195 (offering-grid import). T195's `parseGridScheduleMenu` detects known glyph
markers on a cell's raw activity name (e.g. a double-period marker) and surfaces them in
`linkageMarkers: [{ dayIndex, periodIndex, activityName, markerType, sourceExcerpt }]` — but
**never applies** them. Nothing infers a span, writes a multi-block elective_set, or touches
`activities.span_blocks` / `is_span_head` from a detected marker. That inference is this ticket's
job, deliberately deferred out of T195's slice.

## Why this is its own ticket, not part of T195

- The glyph set and the cell-delimiter convention that would carry a linkage marker are **unverified
  assumptions** in T195 — the real offering-sheet artifact is outside this repo and off-limits, so
  T195 could only build the injectable seam (`cellSplitter`), not confirm the convention.
- Linkage is a property the camp declares on its **offering catalog** (a chugim/activity spans two
  periods, or repeats across specific days) — modelling that correctly touches `elective_sets`
  membership across MULTIPLE (day, time_block) pairs at once, which is a materially different write
  shape than T195's per-(day, time_block) upsert.
- T195's rescoping ADR amendment (draft, `docs/work/specs/`) flags multi-day linkage as unmodeled;
  this ticket is where that gets modeled once the convention is confirmed.

## Scope

- Confirm the real glyph/delimiter convention against an owner-approved sample (never a real camp
  artifact committed to this repo).
- Design how a linked offering's membership is represented: one `elective_sets` row spanning
  multiple `(day_id, time_block_id)` pairs, or multiple rows joined by a new linkage table — TBD,
  Architect's call once the shape of the real data is known.
- Decide how a linked offering interacts with the engine's placement logic (an activity spanning two
  periods must be placed as ONE session, mirroring `buildSchedule.js`'s existing multi-block
  activity handling for anchors/activities).

## Non-goals (until scoped)

Writing any linkage-inference code before the glyph/delimiter convention is confirmed; assuming
`markerType` from T195's placeholder implementation (`asterisk`/`dagger`) matches the real
convention — it is explicitly a placeholder for the SHAPE of the feature, not a confirmed reading.

## Exit condition

Either a concrete linkage convention is confirmed and a design for representing/placing a linked
offering is written, or the owner explicitly defers this indefinitely with a recorded reason.
