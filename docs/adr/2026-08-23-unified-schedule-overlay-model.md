---
title: "Unified schedule-overlay model — contend-and-coexist vs override-and-replace"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-23
approved: "2026-08-23 (owner, via adhd divergence + refinement; recurrence model refined same-day after Fixed Event was renamed to Recurring Event and the weekly-detection gap was named)"
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
archive_when: Slice 2 (season-binding + level axis) and Slice 3 (electives-as-recurring re-model) both ship, or this model is superseded
---

# Unified schedule-overlay model

## Terminology note (read first)

**"Fixed Events" is the wrong concept name — the correct concept is Recurring Events.** This ADR
uses "Recurring Event" as the product-facing concept and model-language term throughout. This is a
**naming and model change, not a code change**: the table stays `anchor_activities`, the ingest
detector file stays `src/ingest/fixedEvents.js`, and no symbol in the codebase is renamed by this
ADR. Only the concept's name and the UI-facing label change — the existing "Fixed Events" nav item
and screen title become **"Recurring Events."** Anywhere this ADR or the companion slice plan says
"Recurring Event(s)," it is naming the same underlying entity `anchor_activities` has always stored;
anywhere it names a file, table, or function, that name is unchanged. The rename matters because
"fixed" describes only the daily-pinned case (same period every day) and actively hides the second
real case this ADR adds — an event that recurs **weekly**, not daily, is not "fixed" in any sense a
director would recognize, but it is exactly the same kind of thing.

## Context

Five overlapping mechanisms touch "something other than the normal weekly grid," built across
four tables, in three separate initiatives (2026-08-03 fixed-event ingest, 2026-08-20 special-days/
day-overrides, 2026-08-22 nested-schedules-electives-and-events):

| Concept | Table(s) | Binding today | Recurrence today |
|---|---|---|---|
| Recurring Events (was "Fixed Events") | `anchor_activities` | per-day fan-out row, cohort-scoped, `is_all_groups`/`group_ids` | implicit: no week binding = all-weeks; ingest infers via majority-of-operating-**days** (`src/ingest/fixedEvents.js`) — **daily recurrence only, see the confirmed gap below** |
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
out: Recurring Events (still a distinct anchor mechanism, not a `template_slots` cell field) and
the override family (`special_days` / `day_overrides` / `template_overlays` are three separate
tables that don't share vocabulary), and makes the seam explicit as product-facing IA rather than
an internal storage observation.**

Three additional, unaddressed problems motivate this ADR beyond the seam itself:

- **A real ingest bug (daily collapse).** `src/ingest/extractEntities.js`'s `stripTimes`/
  `cleanCellValue` (`~46-81`) strip time text out of a cell's activity name before
  `fixedEvents.js` ever sees it. Where a camp's row *label* itself carries the distinguishing time
  ("Lunch 12:00" / "Lunch 12:30" / "Lunch 1:00" as three period rows under one umbrella name), that
  stripping is fine — but where three separately-timed cells share one printed name and get read
  into ingest as the same `(group, activity, time_block)` key, `fixedEvents.js`'s dedup
  (`keyOf(group, block, activity)`, `occupied` map) collapses them into one all-groups recurring
  event, silently losing the stagger. Confirmed against the live parser; not yet a filed ticket.
- **`isBlockLabel`** (`fixedEvents.js:29`, `/^\d{1,2}[:.]\d{2}/`) only recognizes time-shaped row
  labels. A camp whose rows are labeled "Period 1" / "Period 2" produces **zero** recurring-event
  detection — confirmed, no recurring events survive that camp's layout today.
- **A confirmed detection gap: weekly recurrence is invisible to ingest, not just under-detected.**
  `fixedEvents.js` keys candidates on a **majority of a group's operating DAYS** within the single
  ingested week (`operatingDays`/`occupied`, `addOperatingDay`/`addTuple`). This detects exactly one
  shape: an activity pinned to the same period on most/all days — i.e. **daily** recurrence. An
  activity that occurs **once a week** (an all-camp Friday assembly; a per-division event each
  division runs on a different day and at a different time) appears on exactly **one** day out of
  the group's ~5-6 operating days in the source data — far below the majority threshold — and is
  **never emitted as a candidate at all**. This is not a confidence-tier problem (the existing
  high/low split from `2026-08-03` Decision 2 doesn't reach it); it is a structural blind spot in
  what the detector is even looking for. The owner's two motivating examples, both real and both
  currently dropped: (a) an **all-camp** activity, same time for every group, that recurs once a
  week; (b) a **per-division** event once a week, each division at a **different** time. Both
  "recur like Lunch does" from a director's point of view, but neither is "fixed" in the
  same-period-every-day sense the current detector looks for.

## Decision

### D1 — One shared lifecycle for the whole family

**Surface → populate a setup entity → director fills in the detail.** "Surface globally, build
locally":

1. **Surface**: ingest reads a candidate off the main schedule import (recurring events, electives-
   as-recurring, special-day/trip candidates all get this), OR the director adds one directly from
   the schedule grid (D8 below).
2. **Populate**: the surfaced candidate becomes a row in the relevant setup entity —
   `anchor_activities`, `elective_sets`, `events`, or `special_days` — exactly as Recurring Events
   ingest already does for anchors today. This step never writes placement data the director hasn't
   confirmed (the non-skippable preview convention `2026-08-01`/`2026-08-03` already established).
3. **Fill in**: the director completes the detail by hand on the entity's own screen, or via a
   per-container file import through the shared `parseGridSchedule` consumer already shipping for
   event/elective import (`2026-08-22-event-schedule-import.md`).

This lifecycle is not new machinery — it generalizes the recurring-events ingest pattern
(`2026-08-03`) and the event-schedule-import pattern (`2026-08-22`) to the two families that don't
have it yet: electives (currently ingested only as a contentless name stub) and special
days/field-trips (currently forbidden from ingest entirely).

### D2 — The load-bearing distinction is contend-and-coexist vs override-and-replace

Not span, not name, not which table. Two families, by how a placement interacts with the normal
grid's resources:

- **Contend-and-coexist**: Recurring Events + Electives + Events-as-overlay. All three occupy real
  recurring `(group/unit, day, block)` periods and **compete for locations** — the engine's
  `locationCapById` capacity accounting must see their location use as consuming capacity other
  placements can't also use. Mechanically, all three are (or become, per D4) `template_slots` cell
  content: `activity_id` (a normal activity), `anchor_id`/anchor pinning (a recurring event — see
  D5), `elective_set_id` (an elective), or `event_id` (an event overlay) — already a single
  precedence-ordered mutually-exclusive group in `MUTUALLY_EXCLUSIVE_FIELDS`.
- **Override-and-replace**: Special Days + Events-as-replacement (`event_slots`) + Day Overrides +
  Field-Trip stamps. All four take over their span; by design nothing else is scheduled there, so
  contention is moot — a special day owns its own time blocks and groups, a day override swaps or
  cancels a specific `(week, day, group, block)` cell, and a field-trip stamp labels a span with no
  activity at all.

An **Elective is a Recurring Event with a different interior**: same recurring-period binding
(`group/unit, day, block`, and after D3, an explicit recurrence axis set), but instead of pinning
one activity it exposes an interior the director clicks into to build offerings
(`elective_set_activities`). This is why D4 re-models electives on the Recurring-Events binding
shape rather than leaving them as bare contentless containers.

### D3 — Recurrence becomes an explicit, multi-axis model

A single "recurrence" flag is not enough — the owner's refinement (2026-08-23) separates it into
four independent axes, all attaching to the contend-and-coexist family (Recurring Events and,
per D4, Electives):

1. **Level** — `daily` | `weekly`. Does this occur every operating day (Lunch, Mifkad — the shape
   `fixedEvents.js` already detects), or once per week (a Friday assembly, a weekly division
   rotation — the shape it currently misses entirely, see below)? This is genuinely new vocabulary;
   nothing today distinguishes these two cases at all.
2. **Season binding** — `all-weeks` | `specific-week`. Does this recurring event apply for the
   whole season, or only during one named `schedule_week_id`? This is the axis the original
   (pre-refinement) draft of this ADR called "recurrence": today, no week binding at all means
   implicitly all-weeks. A **new** capability this axis unlocks: a recurring event bound to one
   specific week, which today has no representation short of building a full Special Day. Add a
   nullable `schedule_week_id` to `anchor_activities` (additive, pre-production, no backfill
   required — NULL means "all weeks," preserving current behavior exactly).
3. **Scope** — `one-group` | `division` (a unit's groups) | `all-camp`. Already representable today
   via `is_all_groups`/`group_ids`/`unit_id` on `anchor_activities`; this axis names that existing
   capability explicitly as part of the model rather than leaving it as three loosely-related
   columns a reader has to infer the relationship between.
4. **Per-group time variation ("stagger")** — `uniform` | `staggered`. Does every group in scope
   share the same block, or does each group (or sub-group) get its own block within the same
   recurring event — the Lunch 1/2/3 case, generalized beyond Lunch specifically (see D5).

These axes are independent and combine freely: a `weekly`, `all-camp`, `uniform` event (a Friday
all-camp assembly) and a `weekly`, `division`, `staggered` event (each division's weekly rotation
at its own time) are both real, both currently unrepresentable, and both handled by the same four-
axis model without inventing a fifth mechanism per combination.

`Events-as-overlay` (`template_slots.event_id`) is left out of this axis set: it is bound
implicitly to whichever week's template the cell lives in — i.e. always effectively
`specific-week` per placement, since `template_slots` rows aren't week-scoped by construction (they
belong to a `schedule_template`, and a route has one template). The axis model is additive
vocabulary for Recurring Events/Electives, not a forced re-binding of Events.

This does not touch `special_days`/`day_overrides`/`template_overlays` — the override family binds
to a specific `(week, day)` or owns its own days by construction; recurrence isn't a meaningful
question for them (a special day is inherently one-off, per `2026-08-20`'s D3b tier analysis, which
this ADR does not disturb).

#### D3.1 — The confirmed weekly-detection gap

Verified against the live detector (`src/ingest/fixedEvents.js`): candidates are keyed on a
**majority of a group's operating days** (`operatingDays` is the denominator, `occupied` the
numerator, per `(group, block, activity)`). This structurally can only ever surface `daily`-level
candidates. A `weekly`-level event — appearing on exactly one day within the single ingested week —
never crosses the majority threshold and is silently dropped, not flagged low-confidence. This is
the same class of problem as the Lunch-collapse bug in spirit (real data quietly disappearing) but
a different root cause: the Lunch bug is a **dedup** defect (over-merging); this is a **detection**
defect (the detector isn't looking for the shape at all).

#### D3.2 — The honest wrinkle: single-week data cannot distinguish "one-off" from "every week"

Even once the detector is extended to notice a once-a-week candidate, a fundamental ambiguity
remains that no amount of cleverness resolves from **one ingested week alone**: an activity that
appears on Monday of the source week is indistinguishable, from that data alone, between "this
happens every Monday, all season" (a true `weekly` recurring event) and "this happened on this one
Monday only" (a one-off that ingest should not promote to a recurring entity at all). **This is a
design constraint, not an implementation gap to eventually close with better parsing** — the
information genuinely is not present in a single week's grid. Two legitimate ways to resolve it,
neither of which this ADR forces a choice between (left to the Slice 2b design pass in the
companion plan):

- **Director confirmation**: surface every once-a-week candidate as an explicit, always-low-
  confidence, always-unticked-by-default preview item asking "does this repeat every week?" —
  mirroring the existing high/low confidence convention but going further, since low-confidence
  here means "cannot be verified from this data at all," not "verified but not universal." Ships
  with zero new ingest inputs.
- **Multi-week source data**: if the ingest surface ever accepts more than one prior-year week (it
  does not today — `2026-08-01`/`2026-08-03` scope ingest to one parsed schedule), a `weekly`
  candidate appearing on the same day/time across multiple weeks becomes genuine majority-style
  evidence, symmetric with how `daily` detection already works across days within one week. This is
  a larger ingest-surface change and is **not** in scope for this ADR's slices — flagged as an open
  question for Governor below.

### D4 — Electives re-modeled as recurring periods with an interior (owner decision)

`elective_sets` stops being a contentless container (name only, filled entirely on-screen or via
import) and gains the same period/group/recurrence binding Recurring Events carry: which
`(day, block)` it recurs at, which group(s)/unit it applies to, and the full D3 axis set (level,
season binding, scope, stagger). The interior — `elective_set_activities`, the offerings a camper
picks from — is unchanged; only the *binding* gains the shape Recurring Events already have.
Mechanically this is closer to giving `elective_sets` its own anchor-shaped binding row (mirroring
`anchor_activities`'s `day_id`/`time_block_id`/`is_all_groups`/`group_ids` columns, plus the new
`schedule_week_id` and `recurrence_level`) than to inventing new machinery — the Recurring-Events
shape is reused, not reinvented.

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
  refined model instead treats "Lunch" as **one** recurring event (D3's per-group time-variation
  axis, set to `staggered`) that carries a stagger map (which sub-groups get which block), because
  that is how a director actually thinks about and edits it — one thing named "Lunch," not three
  coincidentally-related anchors a director must keep in sync by hand when a block time changes.
  **Stated explicitly per the constitution's re-opening requirement: this reverses `2026-08-03`
  Decision 4.** The ingest inference (`fixedEvents.js`) still detects the N tuples (that logic is
  sound and unaffected by (a) or (b)) — what changes is the *commit-time* grouping: tuples sharing a
  name and group-set but differing only in block become one entity with a stagger map, not N
  entities. The stagger axis generalizes beyond Lunch to any recurring event (D3.4), Lunch is simply
  its motivating and most common case.

### D6 — Special-day/field-trip ingest, as the same lightweight lifecycle (owner decision)

`2026-08-20` §D3b forbade adding `special_days` to `INGESTIBLE_ENTITIES`, reasoning that special
days are always-authored, tier-(c) durable objects with no meaningful one-off ingest case. **This
ADR reverses that prohibition** — stated explicitly per the constitution's re-opening requirement —
but narrowly: special-day/field-trip candidates get the **same D1 surface-then-fill lifecycle**
everything else in this family gets, not a bespoke detector. Concretely: when the main-schedule
ingest sees a day whose activities don't fit the normal weekly pattern at all (a day-long deviation
from the camp's usual grid — the same signal that already distinguishes a "day override" shape from
a "recurring event" shape), it surfaces "this looks like a special day" as a lightweight candidate,
exactly the way a Recurring Event candidate is surfaced today — a name and a rough shape, ticked/
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
closing**: a recurring event, elective, or event overlay that consumes a location today does not
register in `placeUsage`, so the engine can still place a *different* activity into that same
location at capacity, unaware it's already full. Overrides (special days, day overrides, field-trip
stamps) correctly do **not** need this — by design they replace the period, so there is no "other
placement" to contend with them. Closing this gap is a Slice in the companion plan (Slice 4); it is
scoped to feeding anchor/elective/event location occupancy into `placeUsage` before the capacity
check runs, not a redesign of the capacity model itself.

### D8 — IA: the family lives with the Schedule routes, not scattered setup rows

The whole family (Recurring Events, Electives, Events, Special Days, Day Overrides, Field-Trip
stamps) becomes overlays/regions on the base schedule grid (Manual and Generated routes both),
reachable from the schedule itself — not a set of optional rows the director has to remember exist
under Setup. Creation is **grid-first** where possible: select cells → the app asks two plain
questions (how big a span / does this need choices-or-its-own-schedule-or-just-a-label) → the app
assigns the mechanism (Recurring Event vs. Elective vs. Event-overlay vs. Special Day vs. stamp) and
a recognizable name. The director is never asked to pick "Event vs. Special Day vs. Recurring Event"
by mechanism name — that vocabulary stays internal, consistent with `2026-08-20`'s own "the director
never picks a table" framing extended to the whole family.

This decision is IA direction, not a screen spec — the concrete grid-first interaction (which two
questions, exact copy, entry points) is Designer's brief, gated by
`docs/governance/standards/DESIGN_STANDARD.md` §5 (motion/feedback: creating an overlay needs a
distinct scoped transition, not a bare re-render — a new anchor/elective/event appearing on the
grid should carry the same "takes root" ≤240ms scoped transition precedent
(`2026-08-21-arbitrary-length-activity-span.md`/roots-metaphor work), with an explicit reduced-
motion equivalent — a state change, never nothing) and §8 (view transitions between "select cells"
→ "two questions" → "placed" must be an explicit sequence, not an abrupt swap). Slice 6 in the
companion plan is this IA regroup; Slice 7 is grid-first creation.

## Reused vs. new

**Reused unchanged:** the D1 lifecycle is the existing `2026-08-03` recurring-events ingest pattern
and `2026-08-22` event-schedule-import pattern, generalized, not reinvented. `template_slots`'
`MUTUALLY_EXCLUSIVE_FIELDS` precedence group (`2026-08-22-events-overlay-placement.md`) is the
mechanical seat the contend-and-coexist family already shares; this ADR extends it conceptually to
Recurring Events (D2) without requiring Recurring Events to move off `anchor_activities` (anchors
are resolved by the engine's separate anchor-pinning pass, not via `template_slots`, and that split
is left alone — see Open Questions). The override family's tables (`special_days`, `day_overrides`,
`template_overlays`) are reused as-is; only their *product-facing* grouping (D8) and, for
`special_days`, ingest eligibility (D6) change. `is_all_groups`/`group_ids`/`unit_id` on
`anchor_activities` are reused as-is for D3's scope axis — no new column, just named vocabulary.

**Genuinely new:** the D3 recurrence axis set (`schedule_week_id`, `recurrence_level`, and the
stagger map) on `anchor_activities` and whatever binding row electives gain (D4) — nothing today
expresses "daily vs. weekly," "applies to one specific week," or "each sub-group gets its own
time." The elective binding row itself (D4) — nothing today gives `elective_sets` a period/group
binding; it is filled entirely by hand or import today. The weekly-recurrence detect-or-confirm
mechanism (D3.1/D3.2) — the current detector cannot see this shape at all, not even at low
confidence; this is new detection logic, not a confidence-threshold tweak. The special-day/trip
ingest surfacing (D6) — no detector exists today; `special_days` is not in `INGESTIBLE_ENTITIES`.
The `placeUsage` feed for anchors/electives/events (D7) — `locationCapById`/`placeUsage` exist, but
nothing populates them from anchor/elective/event occupancy today.

## Consequences

- **Blast radius**: 4 tables touched (`anchor_activities` +columns for season-binding/level/
  stagger, new elective binding table/columns, `special_days` ingest-eligibility flag, no schema
  change to `events`/`template_overlays`/`day_overrides`), the engine's capacity-check block
  (`buildSchedule.js` ~254-309), the ingest layer (`fixedEvents.js` dedup fix + weekly-detection
  extension + new special-day surfacing + electives-as-recurring inference), and the
  schedule-adjacent IA (regroup under the routes, grid-first creation entry points, "Fixed Events"
  nav/screen label rename to "Recurring Events"). This is explicitly **not** a one-PR change — see
  the companion slice plan.
- **Pre-production posture**: no live camp data exists yet (`feedback_preproduction_bias_bold`).
  Both reversals (D5b, D6) and the additive schema changes (D3, D4) take the clean-cutover path —
  no dual-write, no back-compat shim for the old three-implicit-mechanisms behavior, no migration
  of existing anchors' implicit all-weeks binding (NULL `schedule_week_id` already means that; a
  missing `recurrence_level` defaults to `daily`, matching every existing anchor's actual shape).
- **Two ADRs amended, not superseded**: `2026-08-03` Decision 4 (staggered variants, no special-
  casing) and `2026-08-20` §D3b (special-days ingest prohibition) are each reversed in one specific
  clause; the rest of both ADRs (recurring-events ingest architecture; special-days record-and-print
  posture, D1-D2, D4-D5) stands unchanged and is reused by D1/D6 above.
- **Risk**: D7 (engine contention) is the highest-risk slice — it changes what the engine considers
  "full," which can newly produce `UNFILLABLE` flags on schedules that placed cleanly before because
  the engine wasn't seeing anchor/elective/event location usage. This must ship with its own
  before/after audit against existing fixtures (Red-Hat-gated per the companion slice plan), not
  bundled with the IA or recurrence work. **Second risk, newly named**: the weekly-detection
  mechanism (D3.1/D3.2) can never be fully automatic from single-week data — any implementation that
  tries to silently promote a once-a-week candidate to a confirmed recurring event without director
  confirmation or multi-week evidence is building on a false premise, and that premise must not
  quietly get relaxed under future scope pressure the way `2026-08-01`'s entities-only boundary
  nearly was.
- **Precedent fit**: D2's contend-vs-override split is not a new invention this ADR asserts alone —
  it is the same seam `2026-08-22-events-overlay-placement.md` found independently ("overlay vs.
  replacement, not event vs. elective") for two of the five concepts. This ADR's contribution is
  extending that seam to all five and making it the explicit, named, product-facing model instead
  of an internal storage observation two ADRs apart.

## Open questions for Governor

- Should Recurring Events eventually move from the separate `anchor_activities` + engine
  anchor-pinning pass onto `template_slots.anchor_id` (a fourth member of
  `MUTUALLY_EXCLUSIVE_FIELDS`), fully unifying the contend-and-coexist family's storage, or is
  "conceptually unified, mechanically distinct" (this ADR's position) the right stopping point for
  now? This ADR does not force that merge — it's a larger, separately-scoped migration with its own
  engine-anchor-pass implications, and karpathy-guidelines argues against folding it in
  speculatively. Flagging it as a real fork the next architecture pass over this family should make
  consciously, not by drift.
- D6's ingest-surfacing signal ("a day whose activities don't fit the normal weekly pattern") needs
  a product decision on threshold/false-positive tolerance before Maker can build it — this is
  product judgment (how eager should the surfacing be), not a technical one.
- D3's `schedule_week_id` on Recurring Events raises a rendering question this ADR does not resolve:
  does a week-bound anchor render on both Manual and Generated routes identically to an all-weeks
  anchor, or does it need its own per-slot flag (mirroring `day_overrides`' route-aware rendering)?
  Left to the Slice 2 design pass.
- D3.2's two resolution paths for the single-week ambiguity (director confirmation vs. multi-week
  source data) are a genuine product fork, not a technical one this ADR should pick for Governor.
  Confirmation ships with zero ingest-surface change; multi-week ingest is a larger, currently
  out-of-scope change to what `2026-08-01`/`2026-08-03` bounded ingest to accept. Recommend starting
  with confirmation (Slice 2b) since it's strictly smaller and reversible, and revisiting multi-week
  only if directors find the confirmation step too noisy in practice — but this is the owner's call,
  not architecture's.
