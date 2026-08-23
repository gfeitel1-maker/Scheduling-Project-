---
title: "Unified schedule-overlay model — contend-and-coexist vs override-and-replace"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-23
approved: 2026-08-23 (owner, via adhd divergence + refinement prior to this session)
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md
  - docs/work/specs/camp-setup-ingestion-program.md
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
  - docs/adr/2026-08-22-events-overlay-placement.md
  - docs/adr/2026-08-22-event-internal-subschedule.md
related_adrs:
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
  - docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md
  - docs/adr/2026-08-21-day-overrides-repoint-shape.md
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
  - docs/adr/2026-08-22-events-overlay-placement.md
amends:
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md (Decision 4 — staggered variants)
  - docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md (§D3b — ingest prohibition)
archive_when: Slice 2 (recurrence axis) and Slice 3 (electives-as-recurring re-model) both ship, or this model is superseded
---

# Unified schedule-overlay model

## Context

Five overlapping mechanisms touch "something other than the normal weekly grid," built across
four tables, in three separate initiatives (2026-08-03 fixed-event ingest, 2026-08-20 special-days/
day-overrides, 2026-08-22 nested-schedules-electives-and-events):

| Concept | Table(s) | Binding today | Recurrence today |
|---|---|---|---|
| Fixed Events | `anchor_activities` | per-day fan-out row, cohort-scoped, `is_all_groups`/`group_ids` | implicit: no week binding = all-weeks; ingest infers via majority-of-operating-days (`src/ingest/fixedEvents.js`) |
| Electives | `elective_sets` / `elective_set_activities`, placed via `template_slots.elective_set_id` (v35) | one `template_slots` cell per (group, day, block) | whatever the grid cell's own day/week is — no explicit recurrence field |
| Events (overlay) | `events`, placed via `template_slots.event_id` (v40) | one `template_slots` cell, opaque, mutually exclusive with `activity_id`/`elective_set_id` (`MUTUALLY_EXCLUSIVE_FIELDS`, `electron/ops/projections.js`) | same as Electives — grid-cell-implicit |
| Events (replacement) | `event_time_blocks`/`event_groups`/`event_slots` (v41) | event owns its own blocks/groups, mirrors `special_days` | one-off by construction (an event is a dated occurrence, no recurrence concept) |
| Special Days | `special_days` family (v34) | fully owns its own day/time_blocks/grid, no binding to any week | one-off by construction; deliberately **author-only** — `2026-08-20` §D3b forbids adding it to `INGESTIBLE_ENTITIES` |
| Field-Trip stamp | `template_overlays` | `(template_id, unit_id, day_id, from_block_order, to_block_order, label)` — a label over a span, no activity | implicit in whichever week's template it's drawn on |

The `2026-08-22` ADR chain (`nested-schedules-electives-and-events`, `events-overlay-placement`)
already found half of this seam on its own: *"the sharpest seam is overlay vs. replacement, not
event vs. elective."* That already unified Electives and Events-as-overlay onto one mechanism —
`template_slots` with a precedence-ordered mutually-exclusive field group
(`activity_id`/`elective_set_id`/`event_id`) — and separately built Events-as-replacement to
mirror Special Days. **This ADR extends that seam to cover the two pieces the Aug-22 work left
out: Fixed Events (still a distinct anchor mechanism, not a `template_slots` cell field) and the
override family (`special_days` / `day_overrides` / `template_overlays` are three separate tables
that don't share vocabulary), and makes the seam explicit as product-facing IA rather than an
internal storage observation.**

Two additional, unaddressed problems motivate this ADR beyond the seam itself:

- **A real ingest bug.** `src/ingest/extractEntities.js`'s `stripTimes`/`cleanCellValue`
  (`~46-81`) strip time text out of a cell's activity name before `fixedEvents.js` ever sees it.
  Where a camp's row *label* itself carries the distinguishing time ("Lunch 12:00" / "Lunch 12:30"
  / "Lunch 1:00" as three period rows under one umbrella name), that stripping is fine — but where
  three separately-timed cells share one printed name and get read into ingest as the same
  `(group, activity, time_block)` key, `fixedEvents.js`'s dedup (`keyOf(group, block, activity)`,
  `occupied` map) collapses them into one all-groups fixed event, silently losing the stagger.
  Confirmed against the live parser; not yet a filed ticket.
- **`isBlockLabel`** (`fixedEvents.js:29`, `/^\d{1,2}[:.]\d{2}/`) only recognizes time-shaped row
  labels. A camp whose rows are labeled "Period 1" / "Period 2" produces **zero** fixed-event
  detection — confirmed, no fixed events survive that camp's layout today.

## Decision

### D1 — One shared lifecycle for the whole family

**Surface → populate a setup entity → director fills in the detail.** "Surface globally, build
locally":

1. **Surface**: ingest reads a candidate off the main schedule import (fixed events, electives-as-
   recurring, special-day/trip candidates all get this), OR the director adds one directly from the
   schedule grid (D6 below).
2. **Populate**: the surfaced candidate becomes a row in the relevant setup entity —
   `anchor_activities`, `elective_sets`, `events`, or `special_days` — exactly as Fixed Events
   ingest already does for anchors today. This step never writes placement data the director hasn't
   confirmed (the non-skippable preview convention `2026-08-01`/`2026-08-03` already established).
3. **Fill in**: the director completes the detail by hand on the entity's own screen, or via a
   per-container file import through the shared `parseGridSchedule` consumer already shipping for
   event/elective import (`2026-08-22-event-schedule-import.md`).

This lifecycle is not new machinery — it generalizes the fixed-events ingest pattern
(`2026-08-03`) and the event-schedule-import pattern (`2026-08-22`) to the two families that don't
have it yet: electives (currently ingested only as a contentless name stub) and special
days/field-trips (currently forbidden from ingest entirely).

### D2 — The load-bearing distinction is contend-and-coexist vs override-and-replace

Not span, not name, not which table. Two families, by how a placement interacts with the normal
grid's resources:

- **Contend-and-coexist**: Fixed Events + Electives + Events-as-overlay. All three occupy real
  recurring `(group/unit, day, block)` periods and **compete for locations** — the engine's
  `locationCapById` capacity accounting must see their location use as consuming capacity other
  placements can't also use. Mechanically, all three are (or become, per D4) `template_slots` cell
  content: `activity_id` (a normal activity), `anchor_id`/anchor pinning (a fixed event — see D5),
  `elective_set_id` (an elective), or `event_id` (an event overlay) — already a single
  precedence-ordered mutually-exclusive group in `MUTUALLY_EXCLUSIVE_FIELDS`.
- **Override-and-replace**: Special Days + Events-as-replacement (`event_slots`) + Day Overrides +
  Field-Trip stamps. All four take over their span; by design nothing else is scheduled there, so
  contention is moot — a special day owns its own time blocks and groups, a day override swaps or
  cancels a specific `(week, day, group, block)` cell, and a field-trip stamp labels a span with no
  activity at all.

An **Elective is a Fixed Event with a different interior**: same recurring-period binding
(`group/unit, day, block`, and after D3, an explicit recurrence level), but instead of pinning one
activity it exposes an interior the director clicks into to build offerings
(`elective_set_activities`). This is why D4 re-models electives on the Fixed-Events binding shape
rather than leaving them as bare contentless containers.

### D3 — Recurrence + level becomes an explicit axis

Add an explicit `recurrence` concept — `recurring-all-weeks` | `one-off-weekly` | `either` — to the
contend-and-coexist family, replacing today's three *implicit* binding mechanisms where feasible:

- **Fixed Events** (`anchor_activities`): today, no week binding at all means implicitly
  all-weeks. This is compatible with `recurring-all-weeks` as the default reading of an existing
  anchor — no migration needed for that case. A **new** capability this axis unlocks: a fixed event
  bound to one specific week (`one-off-weekly`), which today has no representation at all short of
  building a full Special Day. Add a nullable `schedule_week_id` to `anchor_activities` (additive,
  pre-production, no backfill required — NULL means "all weeks," preserving current behavior
  exactly).
- **Electives** (post-D4, bound like Fixed Events): same nullable `schedule_week_id` on whatever
  binding row electives gain.
- **Events-as-overlay** (`template_slots.event_id`): today bound implicitly to whichever week's
  template the cell lives in — i.e. always effectively `one-off-weekly` per placement, since
  `template_slots` rows aren't week-scoped by construction (they belong to a `schedule_template`,
  and a route has one template). This is left as-is; the recurrence axis is additive vocabulary for
  Fixed Events/Electives, not a forced re-binding of Events.

This does not touch `special_days`/`day_overrides`/`template_overlays` — the override family binds
to a specific `(week, day)` or owns its own days by construction; recurrence isn't a meaningful
question for them (a special day is inherently one-off, per `2026-08-20`'s D3b tier analysis, which
this ADR does not disturb).

### D4 — Electives re-modeled as recurring periods with an interior (owner decision)

`elective_sets` stops being a contentless container (name only, filled entirely on-screen or via
import) and gains the same period/group/recurrence binding Fixed Events carry: which
`(day, block)` it recurs at, which group(s)/unit it applies to, and the D3 recurrence level. The
interior — `elective_set_activities`, the offerings a camper picks from — is unchanged; only the
*binding* gains the shape Fixed Events already have. Mechanically this is closer to giving
`elective_sets` its own anchor-shaped binding row (mirroring `anchor_activities`'s
`day_id`/`time_block_id`/`is_all_groups`/`group_ids` columns, plus the new `schedule_week_id`) than
to inventing new machinery — the Fixed-Events shape is reused, not reinvented.

### D5 — Lunch stagger: fix now, model as one recurring event, staggered per unit (owner decision)

Two independent pieces:

- **(a) Fix the silent-collapse bug now**, standalone, no dependency on the rest of this ADR. In
  `fixedEvents.js`, the `keyOf(group, block, activity)` dedup must not merge two cells that share a
  printed name but occupy *different* `time_block_id`s — the bug is that a staggered "Lunch 1/2/3"
  read from a camp's layout collapses into one all-groups event at a single block. The fix is in
  the ingest inference layer only; ships independently of the rest of this ADR (Slice 0 in the
  companion slice plan).
- **(b) Model the *concept* as one recurring event, staggered per unit** — this is a genuine
  reversal of `2026-08-03` Decision 4, which explicitly chose "staggered variants fall out
  naturally as separate fixed events... no special-casing." That decision optimized for ingest
  simplicity (N distinct `(name, block, group-set)` tuples need no special code). The owner's
  refined model instead treats "Lunch" as **one** recurring Fixed Event/Elective-family entity that
  carries a **per-unit stagger** (which sub-groups get which block), because that is how a director
  actually thinks about and edits it — one thing named "Lunch," not three coincidentally-related
  anchors a director must keep in sync by hand when a block time changes. **Stated explicitly per
  the constitution's re-opening requirement: this reverses `2026-08-03` Decision 4.** The ingest
  inference (fixedEvents.js) still detects the N tuples (that logic is sound and unaffected by (a)
  or (b)) — what changes is the *commit-time* grouping: tuples sharing a name and group-set but
  differing only in block become one entity with a stagger map, not N entities.

### D6 — Special-day/field-trip ingest, as the same lightweight lifecycle (owner decision)

`2026-08-20` §D3b forbade adding `special_days` to `INGESTIBLE_ENTITIES`, reasoning that special
days are always-authored, tier-(c) durable objects with no meaningful one-off ingest case. **This
ADR reverses that prohibition** — stated explicitly per the constitution's re-opening requirement —
but narrowly: special-day/field-trip candidates get the **same D1 surface-then-fill lifecycle**
everything else in this family gets, not a bespoke detector. Concretely: when the main-schedule
ingest sees a day whose activities don't fit the normal weekly pattern at all (a day-long deviation
from the camp's usual grid — the same signal that already distinguishes a "day override" shape from
a "fixed event" shape), it surfaces "this looks like a special day" as a lightweight candidate,
exactly the way a Fixed Event candidate is surfaced today — a name and a rough shape, ticked/
unticked in the preview, populating a `special_days` row the director then fills in on the Special
Days screen (D1's "fill in" stage, reusing the `2026-08-20` D1 author-UI unchanged). **No new
detector, no parsing of rosters/points/staffing** — `2026-08-20`'s D2 (record-and-print, free text,
never parsed) is untouched. The reversal is scoped to *whether ingest may propose a candidate at
all*, not to what it's allowed to propose.

### D7 — Engine: contend-and-coexist family must consume location capacity

The engine already models location contention (`locationCapById`, `src/engine/buildSchedule.js`
~578-588; occupancy check ~254-309) for ordinary activities. Verified against the live code:
`electiveLookup` (built from `preplacedSlots`, ~157-165) is consulted to avoid *re-placing* into an
elective/event/anchor cell (`assigned.has(nextKey) || anchorLookup.has(nextKey) ||
electiveLookup.has(nextKey) || eventLookup.has(nextKey)`, ~300, ~368) — but nothing in the capacity
block (~254-309) reads `electiveLookup`/`eventLookup`/`anchorLookup` occupants into `placeUsage`,
the map the capacity check (~271) actually consults. **This is the named gap this model requires
closing**: an elective or fixed event that consumes a location today does not register in
`placeUsage`, so the engine can still place a *different* activity into that same location at
capacity, unaware it's already full. Overrides (special days, day overrides, field-trip stamps)
correctly do **not** need this — by design they replace the period, so there is no "other
placement" to contend with them. Closing this gap is a Slice in the companion plan (Slice 4); it is
scoped to feeding anchor/elective/event location occupancy into `placeUsage` before the capacity
check runs, not a redesign of the capacity model itself.

### D8 — IA: the family lives with the Schedule routes, not scattered setup rows

The whole family (Fixed Events, Electives, Events, Special Days, Day Overrides, Field-Trip stamps)
becomes overlays/regions on the base schedule grid (Manual and Generated routes both), reachable
from the schedule itself — not a set of optional rows the director has to remember exist under
Setup. Creation is **grid-first** where possible: select cells → the app asks two plain questions
(how big a span / does this need choices-or-its-own-schedule-or-just-a-label) → the app assigns the
mechanism (Fixed Event vs. Elective vs. Event-overlay vs. Special Day vs. stamp) and a recognizable
name. The director is never asked to pick "Event vs. Special Day vs. Fixed Event" by mechanism
name — that vocabulary stays internal, consistent with `2026-08-20`'s own "the director never picks
a table" framing extended to the whole family.

This decision is IA direction, not a screen spec — the concrete grid-first interaction (which two
questions, exact copy, entry points) is Designer's brief, gated by
`docs/governance/standards/DESIGN_STANDARD.md` §5 (motion/feedback: creating an overlay needs a
distinct scoped transition, not a bare re-render — a new anchor/elective/event appearing on the
grid should carry the same "takes root" ≤240ms scoped transition precedent
(`2026-08-21-arbitrary-length-activity-span.md`/roots-metaphor work), with an explicit reduced-
motion equivalent — a state change, never nothing) and §8 (view transitions between "select cells"
→ "two questions" → "placed" must be an explicit sequence, not an abrupt swap). Slice 5 in the
companion plan is this IA regroup; Slice 6 is grid-first creation.

## Reused vs. new

**Reused unchanged:** the D1 lifecycle is the existing `2026-08-03` fixed-events ingest pattern and
`2026-08-22` event-schedule-import pattern, generalized, not reinvented. `template_slots`'
`MUTUALLY_EXCLUSIVE_FIELDS` precedence group (`2026-08-22-events-overlay-placement.md`) is the
mechanical seat the contend-and-coexist family already shares; this ADR extends it conceptually to
Fixed Events (D2) without requiring Fixed Events to move off `anchor_activities` (anchors are
resolved by the engine's separate anchor-pinning pass, not via `template_slots`, and that split is
left alone — see Open Questions). The override family's tables (`special_days`, `day_overrides`,
`template_overlays`) are reused as-is; only their *product-facing* grouping (D8) and, for
`special_days`, ingest eligibility (D6) change.

**Genuinely new:** the `recurrence`/`schedule_week_id` axis (D3) on `anchor_activities` and
whatever binding row electives gain (D4) — nothing today expresses "this fixed thing applies to one
specific week." The elective binding row itself (D4) — nothing today gives `elective_sets` a
period/group binding; it is filled entirely by hand or import today. The special-day/trip ingest
surfacing (D6) — no detector exists today; `special_days` is not in `INGESTIBLE_ENTITIES`. The
`placeUsage` feed for anchors/electives/events (D7) — `locationCapById`/`placeUsage` exist, but
nothing populates them from anchor/elective/event occupancy today.

## Consequences

- **Blast radius**: 4 tables touched (`anchor_activities` +column, new elective binding table/
  columns, `special_days` ingest-eligibility flag, no schema change to `events`/`template_overlays`/
  `day_overrides`), the engine's capacity-check block (`buildSchedule.js` ~254-309), the ingest
  layer (`fixedEvents.js` dedup fix + new special-day surfacing + electives-as-recurring
  inference), and the schedule-adjacent IA (regroup under the routes, grid-first creation entry
  points). This is explicitly **not** a one-PR change — see the companion slice plan.
- **Pre-production posture**: no live camp data exists yet (`feedback_preproduction_bias_bold`).
  Both reversals (D5b, D6) and the additive schema changes (D3, D4) take the clean-cutover path —
  no dual-write, no back-compat shim for the old three-implicit-mechanisms behavior, no migration
  of existing anchors' implicit all-weeks binding (NULL `schedule_week_id` already means that).
- **Two ADRs amended, not superseded**: `2026-08-03` Decision 4 (staggered variants, no special-
  casing) and `2026-08-20` §D3b (special-days ingest prohibition) are each reversed in one specific
  clause; the rest of both ADRs (fixed-events ingest architecture; special-days record-and-print
  posture, D1-D2, D4-D5) stands unchanged and is reused by D1/D6 above.
- **Risk**: D7 (engine contention) is the highest-risk slice — it changes what the engine considers
  "full," which can newly produce `UNFILLABLE` flags on schedules that placed cleanly before because
  the engine wasn't seeing anchor/elective/event location usage. This must ship with its own
  before/after audit against existing fixtures (Red-Hat-gated per the companion slice plan), not
  bundled with the IA or recurrence work.
- **Precedent fit**: D2's contend-vs-override split is not a new invention this ADR asserts alone —
  it is the same seam `2026-08-22-events-overlay-placement.md` found independently ("overlay vs.
  replacement, not event vs. elective") for two of the five concepts. This ADR's contribution is
  extending that seam to all five and making it the explicit, named, product-facing model instead
  of an internal storage observation two ADRs apart.

## Open questions for Governor

- Should Fixed Events eventually move from the separate `anchor_activities` + engine anchor-pinning
  pass onto `template_slots.anchor_id` (a fourth member of `MUTUALLY_EXCLUSIVE_FIELDS`), fully
  unifying the contend-and-coexist family's storage, or is "conceptually unified, mechanically
  distinct" (this ADR's position) the right stopping point for now? This ADR does not force that
  merge — it's a larger, separately-scoped migration with its own engine-anchor-pass implications,
  and karpathy-guidelines argues against folding it in speculatively. Flagging it as a real fork the
  next architecture pass over this family should make consciously, not by drift.
- D6's ingest-surfacing signal ("a day whose activities don't fit the normal weekly pattern") needs
  a product decision on threshold/false-positive tolerance before Maker can build it — this is
  product judgment (how eager should the surfacing be), not a technical one.
- D3's `schedule_week_id` on Fixed Events raises a rendering question this ADR does not resolve:
  does a week-bound anchor render on both Manual and Generated routes identically to an all-weeks
  anchor, or does it need its own per-slot flag (mirroring `day_overrides`' route-aware rendering)?
  Left to the Slice 2 design pass.
