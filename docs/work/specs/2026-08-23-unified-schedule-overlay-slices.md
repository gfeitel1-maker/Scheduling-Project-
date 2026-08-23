---
title: "Unified schedule-overlay model — phased slice plan"
document_type: spec
status: planned
authority: informative
date: 2026-08-23
related_adrs:
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md
---

# Unified schedule-overlay model — phased slice plan

Companion to `docs/adr/2026-08-23-unified-schedule-overlay-model.md`. The ADR's model is too big
for one PR; this sequences it into independently shippable, independently reversible slices, each
through the normal Governor → Maker → review-loop → Verifier → Grader gate. Slices are ordered so
each one is safe to ship alone if a later slice stalls or gets re-scoped — none of Slices 1-6
depends on a later slice existing.

## Slice 0 — Fix the Lunch silent-collapse bug

**Standalone. No dependency on any other slice. Ships first, ships alone.**

- **What**: `src/ingest/fixedEvents.js`'s `keyOf(group, block, activity)` dedup + `occupied` map
  must not merge two source cells that share a printed activity name but occupy different
  `time_block_id`s. Today a staggered "Lunch 12:00 / 12:30 / 1:00" read from one row label
  collapses into one all-groups fixed event at a single block, silently losing the stagger.
- **Which ADR clause**: implements ADR D5(a) only — the bug fix, not the "one recurring event with
  a stagger map" re-model (that's Slice 3b). This slice keeps `2026-08-03` Decision 4's "separate
  events, no special-casing" behavior — it just makes the separation actually happen instead of
  silently collapsing.
- **Files**: `src/ingest/fixedEvents.js` (dedup key/logic), `src/ingest/fixedEvents.test.js` (new
  fixture: same-name cells at distinct time blocks must produce distinct proposed fixed events).
- **Also in scope**: `isBlockLabel` (`fixedEvents.js:29`, `/^\d{1,2}[:.]\d{2}/`) fails on non-time
  row labels ("Period 1"), producing zero fixed-event detection for that camp's layout. Fix in the
  same slice since it's the same file and the same class of detection-failure bug — extend the
  label recognition to accept a period-number pattern in addition to a time pattern, sourced from
  the camp's actual `time_blocks` row shape rather than a hardcoded regex, so a camp whose blocks
  are named anything still matches.
- **Reverses**: nothing.
- **Gate**: Maker (test-first) → Code Reviewer → Verifier → Grader. No Red Hat needed — pure ingest
  inference bug fix, no stored-data-shape or sync change.

## Slice 1 — `schedule_week_id` on `anchor_activities` (recurrence axis, storage only)

- **What**: additive nullable `schedule_week_id TEXT REFERENCES schedule_weeks(id)` column on
  `anchor_activities`. NULL preserves today's implicit all-weeks meaning exactly — no backfill, no
  behavior change for any existing anchor. This slice is schema + projection only; no UI surfaces
  it yet (that's Slice 2).
- **Which ADR clause**: implements ADR D3's Fixed-Events half.
- **Files**: `electron/db/schema.sql` (new migration version, additive column per the drifted-table
  convention already used for `elective_sets.is_reusable`/`elective_set_activities.camper_headcount`
  — appended last), `electron/db/localDb.js` (new migration), `electron/ops/projections.js` (anchor
  projection picks up the new field).
- **Reverses**: nothing — pure addition.
- **Gate**: Maker (test-first, migration up/down + projection round-trip) → Red Hat (schema-change
  gate — new column on a synced table) → Code Reviewer → Verifier → Grader.

## Slice 2 — Week-bound anchor rendering (recurrence axis, UI)

- **What**: the Fixed Events screen gains a "which weeks" control (default: all weeks, matching
  today's implicit behavior) writing `schedule_week_id`. The schedule grid renders a week-bound
  anchor only on weeks it applies to. Resolves the ADR's open question on route-aware rendering
  before building it — needs its own small design pass (Manual vs. Generated route parity, mirroring
  how `day_overrides` handles per-route flags) before Maker starts.
- **Depends on**: Slice 1 (needs the column to exist).
- **Files**: `src/screens/AnchorsScreen.jsx` (or equivalent — verify current filename before
  starting), `src/screens/ScheduleScreen.jsx` (render filter by week), `src/engine/buildSchedule.js`
  (anchor lookup must filter by the active week when placing).
- **Reverses**: nothing.
- **Gate**: Designer (small — the rendering rule, not a full visual pass) → Maker → Red Hat (engine
  behavior change — a week-bound anchor must never leak into a week it doesn't apply to) → Code
  Reviewer → Verifier → Grader.

## Slice 3a — Electives binding row (period/group/recurrence)

- **What**: `elective_sets` gains a binding shape mirroring `anchor_activities`
  (`day_id`/`time_block_id`/`is_all_groups`/`group_ids`/`schedule_week_id`) — either new columns on
  `elective_sets` or a new one-to-one child table, Maker's call at implementation time provided the
  binding is queryable the same way an anchor's binding is. The elective's interior
  (`elective_set_activities`) is untouched.
- **Which ADR clause**: implements ADR D4.
- **Depends on**: nothing (independent of Slices 1-2; reuses the *shape*, not the column, so no
  hard dependency on `anchor_activities` itself).
- **Files**: `electron/db/schema.sql` (new table or additive columns), `electron/db/localDb.js`,
  `electron/ops/projections.js`, `src/screens/ElectivesScreen.jsx` (or current filename — verify).
- **Reverses**: nothing — additive, and the existing contentless-container electives keep working
  (binding fields nullable, matching today's "filled entirely by hand" case).
- **Gate**: Maker (test-first) → Red Hat (schema-change gate) → Code Reviewer → Verifier → Grader.

## Slice 3b — Lunch-as-one-recurring-event-with-stagger (the actual model reversal)

- **What**: implements ADR D5(b) — the conceptual reversal of `2026-08-03` Decision 4. At
  ingest-commit time (not detection time — Slice 0's detection fix is unaffected), tuples that share
  a name and group-set but differ only in time block become **one** Fixed Event/Elective-family
  entity carrying a per-unit stagger map, instead of N separate anchors.
- **Depends on**: Slice 0 (needs correct detection first) and, if the staggered entity is modeled as
  an elective-family object rather than a plain anchor, Slice 3a (needs the binding shape to attach
  a stagger map to).
- **Files**: `src/ingest/fixedEvents.js` (commit-time grouping), the anchor/elective commit path in
  `electron/main.js` or wherever `commitIngest`'s fixed-events branch lives (verify exact file at
  implementation time — `2026-08-03` ADR names it "a `fixedEvents` payload on `commitIngest`").
- **Reverses**: `docs/adr/2026-08-03-ingesting-recurring-fixed-events.md` Decision 4, explicitly.
- **Gate**: Maker (test-first, fixture: three staggered Lunch cells commit as one entity with a
  3-way stagger, not three anchors) → Red Hat (this changes committed-data shape for a whole class
  of returning-camp imports — needs adversarial review of what happens when a stagger doesn't
  cleanly resolve, e.g. two groups share a stagger slot) → Code Reviewer → Verifier → Grader.

## Slice 4 — Engine: contend-and-coexist family consumes location capacity

**Highest risk in the plan. Ships alone, with its own before/after audit.**

- **What**: implements ADR D7. Feed anchor/elective/event location occupancy into `placeUsage`
  (`src/engine/buildSchedule.js`, the map the capacity check at ~271 consults) before the capacity
  check runs, so a location already consumed by a fixed event/elective/event-overlay correctly
  reads as full to other placements.
- **Depends on**: nothing structurally (electives/events already place via `template_slots` today;
  anchors already exist) — but should ship after Slices 0-3b so the audit fixture set reflects the
  corrected Lunch-stagger behavior rather than the old collapsed-bug behavior.
- **Files**: `src/engine/buildSchedule.js` (~254-309, ~578-588 — populate `placeUsage` from
  `anchorLookup`/`electiveLookup`/`eventLookup` occupants), `src/engine/buildSchedule.test.js` (new
  fixtures: a location at capacity 1 with a fixed event already in it must reject a second
  placement).
- **Reverses**: nothing textually, but **behaviorally** this can newly produce `UNFILLABLE` flags on
  schedules that previously placed cleanly, because the engine wasn't seeing anchor/elective/event
  location usage before. That is the risk this slice exists to name and test for, not a silent
  regression — run the full existing `buildSchedule.test.js` fixture set before/after and diff the
  flag output explicitly as part of this slice's evidence.
- **Gate**: Maker (test-first) → Red Hat (mandatory — engine behavior change, per
  `docs/governance/standards/ARCHITECTURE_STANDARD.md`'s engine gate) → Code Reviewer → Verifier →
  Grader. Do not merge without the before/after fixture diff in the PR evidence.

## Slice 5 — Special-day/field-trip ingest surfacing

- **What**: implements ADR D6. Main-schedule ingest detects a day that doesn't fit the normal weekly
  pattern and surfaces a lightweight "this looks like a special day" candidate in the preview
  (ticked/unticked, same convention as Fixed Events), populating a `special_days` row the director
  fills in on the existing `2026-08-20` Special Days author UI. No roster/points/staffing parsing.
- **Depends on**: the `2026-08-20` Special Days author UI existing and being reachable (verify its
  implementation status before starting this slice — its own ADR listed `implementation_state:
  not-started` as of `2026-08-20`; check current state, since the surfacing has nothing to populate
  into if the author UI itself hasn't shipped).
- **Governor gate before Maker starts**: the detection threshold (how eager the surfacing should be)
  is a product decision per the parent ADR's Open Questions — get that from the owner before
  scoping Maker's work, not during it.
- **Files**: new detection module in `src/ingest/` (mirrors `fixedEvents.js`'s shape — pure
  inference, no I/O), `electron/db/schema.sql`/`localDb.js` if `INGESTIBLE_ENTITIES`-adjacent
  wiring needs a flag (verify against `2026-08-20`'s "must not be added to `INGESTIBLE_ENTITIES`"
  constraint — this is a *dedicated* commit branch like fixed events got, not the generic path),
  preview screen (new Special Days section, tick/untick only, same posture `2026-08-03` used for
  Fixed Events).
- **Reverses**: `docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md` §D3b,
  explicitly — narrowly, only "may ingest propose a candidate," not D2's record-and-print posture.
- **Gate**: Maker (test-first) → Red Hat (a wrong special-day surfacing that a director tick-accepts
  writes a real `special_days` row — false-positive cost) → Code Reviewer → Verifier → Grader.

## Slice 6 — IA regroup: family lives with the Schedule routes

- **What**: implements ADR D8's IA half. Fixed Events, Electives, Events, Special Days, Day
  Overrides, and Field-Trip stamps become reachable/visible as overlays on the schedule grid itself
  (both routes), not scattered as separate Setup rows.
- **Depends on**: nothing structurally — this is a navigation/entry-point change, not a data change.
  Can ship independent of Slices 1-5, though it's more useful once electives/special-days have real
  content (natural sequencing, not a hard gate).
- **Governor gate before Maker starts**: needs a Designer pass first (this is UI-significant per
  the constitution's design gate) — entry points, overlay affordances on the grid, how the existing
  per-slot flag system (`UNFILLABLE`, `OVERLAP`, etc.) coexists visually with the new overlay
  regions.
- **Files**: `src/screens/ScheduleScreen.jsx` (entry points), `src/components/layout/Sidebar` (setup
  rows removed/demoted), `src/components/schedule/scheduleGrid.css` (new overlay visual states, per
  the CSS-exception boundary already scoped to this directory).
- **Reverses**: nothing textually — a navigation change, not a data-model change.
- **Gate**: Designer → Maker → Tester (director's-eye — can a non-technical user find where to
  create a special day now that it's not under Setup?) → Code Reviewer → Verifier → Grader.

## Slice 7 — Grid-first creation ("select cells → what happens here?")

- **What**: implements ADR D8's creation-flow half. Selecting cells on the grid and choosing "what
  happens here?" asks two plain questions (span size; label-only vs. choices vs. own-schedule) and
  the app assigns the underlying mechanism (Fixed Event / Elective / Event-overlay / Special Day /
  stamp) without the director naming it.
- **Depends on**: Slice 6 (needs the grid-level entry points to exist first) and, functionally, on
  whichever of Slices 1-3a have shipped (the mechanisms being assigned need to already support the
  binding shapes this flow writes into).
- **Governor gate before Maker starts**: full Designer spec — this is the most user-facing piece of
  the whole model and needs a prototype (per `prototype` skill precedent used elsewhere in this
  program) before Maker commits to an interaction shape.
- **Files**: new component(s) under `src/components/schedule/` for the two-question flow; wiring
  into whichever mechanism's create path each answer maps to.
- **Reverses**: nothing.
- **Gate**: Designer (prototype-gated) → Maker → Tester → Code Reviewer → Verifier → Grader.

## Sequencing summary

```
Slice 0 (bug fix, standalone) ─────────────────────────────────────► ship independently, first
Slice 1 (anchor week column) ──► Slice 2 (week-bound anchor render)
Slice 3a (elective binding) ───► Slice 3b (Lunch-as-one-event, needs Slice 0 + 3a)
Slice 4 (engine contention) ───────────────────────────────────────► after 0-3b, own audit
Slice 5 (special-day ingest) ──────────────────────────────────────► independent, needs D2020-08-20 UI to exist
Slice 6 (IA regroup) ──► Slice 7 (grid-first creation)
```

Slices 0, 1→2, 3a→3b, 4, 5, and 6→7 are six independent tracks. None blocks another except where
stated. Ship in whatever order Governor prioritizes; Slice 0 should go first regardless (it is a
live bug fix with no design dependency) and Slice 4 should not go before 0-3b (its audit fixtures
need the corrected Lunch behavior to be meaningful).
