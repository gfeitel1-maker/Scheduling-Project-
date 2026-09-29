---
title: T219-multi-day-catalog-linkage
document_type: ticket
status: parked
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

- _Prior (removed 2026-09-26 — see "Reshaped" below):_ ~~Confirm the real glyph/delimiter
  convention against an owner-approved sample (never a real camp artifact committed to this
  repo).~~ The importer must accept whatever marks a camp already uses; it does not get to specify
  one.
- Design how a linked offering's membership is represented: one `elective_sets` row spanning
  multiple `(day_id, time_block_id)` pairs, or multiple rows joined by a new linkage table — TBD,
  Architect's call once the shape of the real data is known.
- Decide how a linked offering interacts with the engine's placement logic (an activity spanning two
  periods must be placed as ONE session, mirroring `buildSchedule.js`'s existing multi-block
  activity handling for anchors/activities).

## Non-goals (until scoped)

_Prior (2026-09-26): ~~Writing any linkage-inference code before the glyph/delimiter convention is
confirmed~~ — this no longer gates the work._ Still a non-goal: assuming `markerType` from T195's
placeholder implementation (`asterisk`/`dagger`) is the only reading a camp can produce. It is a
placeholder for the SHAPE of the feature, and the marker set must be open, not fixed.

## Exit condition

_Prior: ~~Either a concrete linkage convention is confirmed and a design for representing/placing a
linked offering is written, or the owner explicitly defers this indefinitely.~~_ Superseded by the
exit condition under "Reshaped" below.

## Reshaped (2026-09-26) — stays OPEN, narrowed to the ingest half

The owner's words, on what a multi-period elective *is*:

> "if its a multi span - then the time blocks on the left would show two blocks with the cells next to them spanning both."

and, on being asked to pick a source convention:

> "it shouldn't matter. we keep going over this. we are reading someone's data. we are not choosing ho they import it. i don't know why we keep going round and round about this"

**What that decides.** The model is settled and is not a new type: a multi-span occupies **two real
time blocks**, rendered as one cell spanning both. Not one block with a label, not a special
multi-period entity. And the glyph/delimiter question this ticket was built around is dead — the
source format is the camp's, so the importer accepts whatever marks arrive and normalizes them. A
ticket asking the owner to choose a third party's convention was a mis-typed question.

**Verified against the tree — the model the owner describes already exists in render and engine.**
Arbitrary-length spans shipped on both routes (the N-period work, PR #145):

- Engine emits a head plus contiguous tails: `src/engine/buildSchedule.js:270` (`span_blocks`),
  `:276-280` (tail emission), `:364` and `:652` (`is_span_head`).
- Geometry resolves head/tail into a row span:
  `src/screens/schedule/gridGeometry.js:43` `isActivityTail`, `:49-57` `getActivityRowSpan`.
- Placement writes the spanning grid track:
  `src/screens/schedule/gridPlacement.js:9` `placeCell({ rowSpan, colSpan })`.
- Render: `src/components/schedule/ManualBuildView.jsx:174-178` (tails render null, covered by the
  head), `:202` (row span applied). Pinned by
  `src/components/schedule/ManualBuildView.test.jsx:102` and `:240`, which assert `'1 / span 2'`.

So outcome (a) — "already implemented" — is true for **rendering**, and this ticket is not needed
for it.

**The remaining gap, which is why this stays open: ingest.** Nothing turns a multi-span source cell
in an *elective offering grid* into a span.

- `linkageMarkers` is produced at `src/ingest/parseGridSchedule.js:349`, `:374-380`, `:396`, and
  returned at `:409`.
- **Nothing consumes it.** `src/ingest/electiveSetPopulate.js:119-122` says so in the code itself —
  it passes straight through and is never applied. No writer of `span_blocks`/`is_span_head` reads
  it, and `src/ingest/parseGridScheduleMenu.test.js:101` asserts the menu cell shape carries no
  span field at all.
- The comparison that shows this is a gap and not a design: the **anchor/event** grid importer
  already does the whole job — it infers span candidates from merged source cells at
  `src/ingest/multiBlockCandidates.js:60-96` and `:326`, and a director confirms them in the
  "Longer Blocks" step at `src/screens/ImportScreen.jsx:747`, `:1367-1381`, `:2198-2212`. The
  elective grid has no equivalent.

**Reshaped scope**

- Consume `linkageMarkers` in the elective-grid commit path and write `span_blocks` /
  `is_span_head`, producing the same shape the engine and grid already render.
- Treat the marker set as **open**: accept whatever a camp's sheet uses (glyph, merged cell,
  repeated name across adjacent periods, delimiter) rather than matching a list we chose.
  `LINKAGE_GLYPHS` at `src/ingest/parseGridSchedule.js:315-322` is a placeholder, not a contract.
- Surface detected spans to the director for confirmation rather than applying them silently —
  mirror the existing "Longer Blocks" step rather than inventing a second pattern.
- Model the `elective_sets` membership question that follows (one row across multiple
  `(day_id, time_block_id)` pairs vs. a linkage table) — still Architect's call, but now scoped by
  a settled render model instead of an unknown source convention.

**Reshaped exit condition.** An elective offering grid containing a multi-period offering imports
as a span that renders across both time blocks, confirmed by the director at import, with the
marker detection not tied to any single camp's notation.

## Deferred indefinitely (2026-09-29)

The owner's ruling, verbatim: "defer the sample sheet". Status is `parked`, not closed: the
reshaped scope and exit condition above stand unchanged and nothing downstream reads
`linkageMarkers` today, so deferring costs nothing; the ticket resumes only when the owner chooses
to.
