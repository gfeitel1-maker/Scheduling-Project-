---
title: "Slice 4 design — Engine location-contention for the contend-and-coexist family"
document_type: spec
status: active
authority: informative
date: 2026-08-23
created: 2026-08-23
archive_when: Slice 4 ships (merged) or is re-scoped by Governor
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
parent_spec: [docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md]
related_adrs:
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md
---

# Slice 4 design — Engine location-contention for the contend-and-coexist family

Implements ADR `2026-08-23-unified-schedule-overlay-model.md` D7: feed anchor/elective/event
location occupancy into `src/engine/buildSchedule.js`'s `placeUsage` capacity map, so a location
already consumed by a recurring event, elective, or event overlay correctly reads as full to other
placements. This is the **design**, not the implementation — a Maker builds it after this doc and
the open questions below are resolved by Governor/owner.

## Candidate approaches considered

Divergence note: the `adhd` skill's frame-based process was applied directly rather than spawned as
isolated parallel agents, given the prerequisite-schema question (§1) had to be resolved by reading
actual schema/code before any mechanism design was possible — the candidates below were generated
after that grounding, across four different angles, then converged.

- **A — Feed `placeUsage` directly from overlay lookups, reuse `occupyPlace`'s shape (chosen).**
  Assumption: capacity semantics (occupant list, `same_tier_only`, span tails) are already correct
  and should not be re-derived. `[N4 V9 F10]`
- **B — Model overlays as synthetic `activities` rows the engine "places" through the normal `place()`
  path**, so anchors/electives/events flow through the exact same code as regular activities instead
  of a parallel registration step. Rejected: an anchor/elective/event is not eligibility-scored, does
  not consume `max_per_week`/`min_per_week`, and is scoped before `openSlots` even exists — forcing it
  through `place()` would require faking eligibility, priority, and per-week counters for entities
  that structurally don't have them, a much larger and riskier surface change for the same outcome.
  `[N6 V3 F6]` — trap: looks elegant ("one code path for everything") but the two things aren't the
  same shape; false unification.
  Trap: `[N6 V3 F6]` — see rejection reason above.
- **C — Build a separate `overlayPlaceUsage` map and check both maps in `placeBlocked`.** Assumption:
  keeping overlay occupancy structurally distinct makes the audit (§4) easier to attribute. Rejected:
  the ADR (D7) is explicit that this is "not a redesign of the capacity model" — two maps for one
  physical capacity concept is the parallel-mechanism the brief explicitly warned against, and the
  before/after audit doesn't actually need two maps to be attributable (a single combined map with
  labeled occupants, per §3's `sourceLabel`, gives the same attribution for free). `[N5 V6 F5]`
- **D — Treat anchors/events as full override-and-replace (like special days), sidestepping
  contention entirely by making the location unavailable to anything else for that block by
  fiat.** Assumption drawn from ADR D2's override-vs-contend split. Rejected: this is a different,
  already-decided model — ADR D2 explicitly classifies anchors/electives/events as
  contend-and-coexist, not override-and-replace (only special days/day overrides/field trips are
  override). Reopening that classification is out of scope for Slice 4, which implements D7 under the
  existing D2 split. `[N2 V7 F1]` — trap: technically simpler, but silently reverses an already-made,
  differently-scoped product decision.

★ **A** is the non-obvious-but-viable pick in the sense that it required first resolving the
prerequisite-schema gap (§1) before it was even expressible — the "obvious" answer without that
grounding would have been to write code against fields (`anchor.location_id`) that don't exist yet.

## 0. The gap, confirmed against current code

`src/engine/buildSchedule.js`, Pass 1 (`scheduleCohort`, lines ~186-231): when a cell resolves to an
anchor (line 198), event (line 206), or elective (line 212), the engine does
`slots.push({...}); continue` and never calls `occupyPlace`. `occupyPlace` (line 329) — which pushes
`{ groupId, tierId }` into `placeUsage.get('<locationId>|<dayId>|<blockId>')`, including span tails
(line 360, called from `place()` line 365) — only runs for regular engine-placed activities via
`place()` (line 341) or the pre-placed-locked-slot loop (line 371-382, which also only walks
`preplacedSlots` entries carrying an `activityId`, not an `electiveSetId`/`eventId`/anchor). The
capacity check `placeBlocked` (line 277) and its call site `canPlace` (line 289, called at line 294
for the head block and line 315 for span tails) both correctly consult `placeUsage`, so the *read*
side is already correct — only the *write* side is missing for these three overlay types.

## 1. The prerequisite: does a location reach the engine today, per overlay type?

This is the load-bearing section — the whole shape of the change depends on it. Verified directly
against `electron/db/schema.sql` and `electron/ops/projections.js` (not inferred from the ADR prose).

### Anchors (`anchor_activities`) — location is NOT modeled. Sub-gap, must be resolved first.

`electron/db/schema.sql:477-491` — the full column set is `id, camp_id, cohort_id, day_id,
time_block_id, name, unit_id, span_blocks, is_all_groups, group_ids, notes, schedule_week_id,
recurrence_level`. **No `location_id` column, and no `activity_id` column either.** An anchor is
free-text `name` only ("Lunch") — it is not linked to any `activities` row.

`src/engine/buildSchedule.js:118` reads `anchor.activity_id` (`if (anchor.activity_id != null)
anchoredActivityIds.add(anchor.activity_id)`) — this field does not exist in the schema or in
`projections.js`'s `anchor_activities.fields` list (`electron/ops/projections.js:278`, which also
omits `unit_id` from the synced field set despite it being a schema column and being read at
`buildSchedule.js:123`). `anchor.activity_id` is therefore always `undefined` on every real row
today; that branch is dead in practice. This is a pre-existing, orthogonal gap (an anchor can never
suppress its own activity from regular placement via `anchoredActivityIds` in current data) — noted
for completeness, not in scope for Slice 4 to fix, but the Maker should not assume `activity_id`
resolves to anything real.

**Conclusion: an anchor carries zero location information today, by any path.** Lunch consuming the
dining hall cannot be expressed without a schema change.

**Minimal resolution (recommended):** add `location_id TEXT` directly to `anchor_activities`,
nullable, defaulting to the existing unconstrained behavior (NULL = no location = today's behavior
exactly, matching the `activities.location_id ?? null` unconstrained convention already documented
at `buildSchedule.js:264-272`). Do **not** resolve via a link to an `activities` row — an anchor is
frequently not "an activity" at all (Lunch has no `activities` row in a typical camp; it is younger
than the activity catalog and deliberately free-text per `2026-08-03`'s ADR). A direct column is the
same shape `events` will need (see below) and mirrors `activities.location_id` exactly. This column
needs its own screen exposure (a location picker on the Recurring Events screen) — that UI work is
out of scope for the engine change but is a hard **prerequisite migration slice** — shipped as
**Slice 4a** (the two location columns, see §6); the engine change is **Slice 4b**. (Governor's 4a/4b
split is the authoritative labelling; earlier drafts of this doc called the prerequisite "Slice 3c".)
Slice 4a must land first, or Slice 4b has nothing to feed for anchors.

### Electives (`elective_sets` / `elective_set_activities`) — location reachable per-offering. RESOLVED per owner: electives are not special.

`electron/db/schema.sql:786-799` (`elective_sets`) has no location column, and **needs none.**
`elective_set_activities` (`schema.sql:817-823`) has `id, elective_set_id, activity_id,
camper_headcount` — `activity_id` points (soft, no SQL FK, resolved by projection like the rest of
the op-log model) at an `activities` row, which **does** carry `location_id` (`schema.sql:294`). So a
location is reachable per offering, and that is exactly the granularity that matters: an elective set
is not one physical thing in one place, it is several concurrent physical things in several places
("Afternoon Chugim" = {Swim @ pool, Art @ art-shed, Archery @ range}), each drawing down its own
location's capacity for as long as the elective block runs, exactly like a normal activity would.

**Owner decision (resolves the ambiguity flagged in the prior revision of this doc): electives are
not a special case of the capacity model.** A location is a shared physical resource; anything using
it — a regular activity, an anchor, an elective offering, an event — draws down that resource's
capacity, and it becomes unavailable to others once at capacity. There is no "which option is *the*
location for the set" question to answer, because the set does not occupy one location — **each
offering occupies its own**, simultaneously, for the block's duration (campers split across the
offerings). The engine does not need to know which camper picked which offering to model this
correctly: it registers occupancy for *every* offering in the set at that (day, block), for the
elective set's placing group(s), exactly as if each offering were independently placed there.
Concretely: if "Sports" (an elective/anchor consuming the gym) is already registered and a director
tries to place `Basketball` (a regular `activities` row also pointed at the gym) in the same
(day, block), the gym's occupant list is checked exactly the same way regardless of whether the
existing occupant arrived via a regular placement, an anchor, or an elective offering — one shared
`placeUsage` ledger, one set of rules.

This **drops** the "shared-location-only, fails-safe" recommendation from the prior revision of this
doc — that recommendation solved a problem the owner has now defined out of existence (there is no
"the" elective location to derive; there are N offering locations, each real, each contending). A
mixed-location elective set is the **normal**, expected case, not a degraded/unconstrained one, and
it now contends at every one of its offerings' locations, not zero of them.

**No schema change needed for electives** — the location comes from each offering's already-existing
`activities.location_id`, joined via `elective_set_activities.activity_id`, both already loaded by
any caller that resolves an elective set's contents today. Offerings whose `activities.location_id`
is null contribute no occupancy for that offering (unconstrained, matching the existing
`activities.location_id ?? null` convention at `buildSchedule.js:264-272` — unchanged, not a new
rule).

### Events (main-grid overlay, `events` table) — location NOT modeled on the table the engine reads. Do not confuse with `event_slots`.

`electron/db/schema.sql:834-841` — `events` (the camp-scoped parent placed as an opaque cell via
`template_slots.event_id`, which is what `eventLookup` in `buildSchedule.js:172` and
`preplacedSlots[].eventId` actually resolve) has only `id, camp_id, name, sort_order, notes`. **No
location.**

`event_slots.location_id` (`schema.sql:892-899`) exists but is a different concept entirely: it is a
column on the event's **own internal sub-schedule** (v41, `docs/adr/2026-08-22-event-internal-
subschedule.md`) — per-(event_group, event_time_block) cells inside the event's private grid, keyed
by the event's own rows, not the camp's `groups`/`time_blocks`/`days_of_operation`. It says where a
sub-activity happens *inside* the event, not where the event *as a whole* sits on the camp's main
schedule grid. These must not be conflated: summing/deriving a main-grid location from
`event_slots.location_id` rows is exactly the same "which option wins" ambiguity as electives, times
however many event_groups/event_time_blocks exist, and is out of scope.

**Minimal resolution (recommended):** add `location_id TEXT` directly to `events`, nullable, same
convention as the anchor column above ("Sports Day happens on the field" — the whole event occupies
one place on the main grid for its span). Needs a location picker on the Events screen — again a
prerequisite migration slice (see §6), not Slice 4 engine work itself.

### Summary table

| Overlay type | Location reachable today? | Resolution |
|---|---|---|
| Anchor | No — no column, no activity link (dead field) | New `anchor_activities.location_id`, nullable. Prerequisite migration slice. |
| Elective | Per-offering, via `elective_set_activities.activity_id → activities.location_id` | Register EVERY offering's location as an occupant (owner-resolved). No schema change. |
| Event (main-grid cell) | No — `events` has no location column; `event_slots.location_id` is a different, internal concept | New `events.location_id`, nullable. Prerequisite migration slice. |

## 2. Engine change design

Once locations are resolvable (post-prerequisite for anchors/events; derived in-line for electives),
the feed is symmetrical with the existing `occupyPlace` mechanism — **reuse it, do not build a
parallel one.**

### 2.1 Where the feed happens

Insert a location-registration step in Pass 1 (`scheduleCohort`, `buildSchedule.js`), immediately
after each overlay type resolves and pushes its slot (i.e. right after lines 199, 208, 217), one or
more calls per resolved cell:

```
registerOverlayOccupancy(locationId, groupId, dayId, blockId, tierId)
```

where `registerOverlayOccupancy` is a small new function with the **exact same body** as the existing
`occupyPlace`'s location-half (lines 330-336) — push `{ groupId, tierId }` onto
`placeUsage.get('<locationId>|<dayId>|<blockId>')` — factored out of `occupyPlace` so both the
overlay path and the regular-activity path call one shared implementation instead of two copies.
`occupyPlace` becomes a thin wrapper: `registerOverlayOccupancy` for the place-half, plus its
existing `activityUsage` increment for activities that have one (overlays have no `activityUsage`
entry — anchors/electives/events are not `activities` rows and do not participate in
`max_groups_per_slot`/instructor-capacity accounting, which is correct and unchanged).

**Anchors and events call it once** (a single `locationId` resolved directly off the anchor/event
row's new `location_id` column, §1). **Electives call it once per DISTINCT offering location**: for
the resolved `electiveSetId`, look up its `elective_set_activities` rows (joined to `activities` for
`location_id`), collapse them to the set of distinct non-null `activities.location_id` values, and
call `registerOverlayOccupancy` once per distinct location, all at the same `(groupId, dayId,
blockId)` the elective cell occupies. This is the direct implementation of the owner's resolved
model (§1): the set doesn't have one location, its offerings each have one, and each distinct
location contends independently.

**Correction (Red Hat MEDIUM, post-implementation review): offerings sharing one location must
dedup to ONE occupant, not one per offering.** The original draft of this section reasoned "two
offerings sharing a location are each a genuine, separate occupant, exactly as two independently-
placed regular activities sharing a location would" — that analogy was wrong. Two independently-
placed regular activities sharing a location are two different GROUPS physically present. Two
offerings of the SAME elective set (e.g. a waterfront period with swim + kayak both at "Waterfront")
are one GROUP, physically present once, whose campers split by choice within that one place — the
elective cell represents one group's presence at (day, block), not one presence per offering. An
occupant in `placeUsage` means "a group is at this location," so a colocated multi-offering elective
must register exactly one occupant at that location for that group, same as it would if the elective
had only one offering there. Registering once per offering instead double-(or N-)counts a single
group's presence and phantom-blocks other groups' regular activities at that location past its real
remaining capacity. Cross-*location* contention is unchanged by this correction — an elective set
with offerings at three distinct locations still registers three occupants (one per location, per
§1's "each offering occupies its own, simultaneously" model); only two-or-more offerings sharing
*one* location collapse to that location's single occupant.

**Scope boundary (Governor decision, binding on Maker): Slice 4 is contention-*checking* only.** The
engine *respects* a location that is already set — on an activity, an anchor, an event, or an
elective offering — and flags a conflict (`UNFILLABLE`, §3) when that location is over capacity. It
does **not** auto-*assign* a location to an activity/anchor/elective offering/event that has none.
"Shoresh generates a location for it" (auto-assignment, conflict-aware placement of *new* location
values) is a separate, future capability, explicitly **out of scope for Slice 4** — a Maker must not
build any location-assignment logic under this slice; an entity with `location_id == null` stays
unconstrained (§2.4), full stop, the same as it is today.

Do this at Pass 1, not Pass 2 (`place()`), because overlay cells are resolved and locked *before*
`openSlots`/placement begins (lines 186-232 run entirely before Pass 2 at line 234) — by the time
`canPlace`/`placeBlocked` run for the first real activity, every overlay's location must already be
registered, or ordering within a single pass would make placement order-dependent on which overlay
happened to be visited first. Registering during overlay resolution (Pass 1) guarantees every overlay
in the grid is in `placeUsage` before any `canPlace` check runs, preserving determinism.

### 2.2 Multi-block spans on overlays

Anchors already support `span_blocks` (`buildSchedule.js:139` builds head + tail entries into
`anchorLookup`, both marked into `slots` at line 199 with `is_span_head`). Each tail block is a
**separate cell** in the per-(group,day,block) walk of Pass 1 (the loop at line 188 revisits
`anchorLookup` once per block), so `registerOverlayOccupancy` naturally fires once per block the
anchor spans — no special tail-handling code needed, unlike `occupyPlace`'s explicit tail loop
(lines 350-363), because the anchor lookup is already block-granular rather than span-object-granular.
Electives/events today are always `is_span_head: true` with no observed multi-block variant in the
lookup construction (`electiveLookup`/`eventLookup` are populated 1:1 from `preplacedSlots` entries,
each already at a specific `blockId`) — if a future slice adds elective/event spans, the same
per-block registration continues to work unmodified as long as each spanned block gets its own
`preplacedSlots` entry, which is the existing convention (`assertIdListShape`-adjacent contract, see
`buildSchedule.js:310`'s tail-block collision guard which already checks `electiveLookup.has(nextKey)`
per block).

### 2.3 Capacity semantics — confirm, do not change

`placeUsage` is an **occupant list, not a boolean** (`buildSchedule.js:239-246`'s own comment):
capacity is `locations.capacity` (floored to 1, `buildSchedule.js:598`), and `placeBlocked` checks
`occupants.length >= capacity`. A lunch anchor for group A in the dining hall therefore consumes
**one occupant slot**, exactly as one activity placement would — other groups can still be placed
into the same location up to capacity; only the group that would push occupancy over capacity is
blocked. This is unchanged, reused as-is. `same_tier_only` (`placeBlocked` line 283) also applies
unchanged: if a *regular activity* with `same_tier_only: true` tries to enter a location an anchor
already occupies with a different tier's group, it is correctly blocked — anchors/electives/events
contribute a real `tierId` to the occupant list (from `groupMap.get(groupId)`, same lookup
`occupyPlace` already does at line 342-345) so this interaction falls out for free, not as new logic.

### 2.4 Null-location handling

An overlay occupant whose resolved `locationId` is `null` **must not call
`registerOverlayOccupancy` for that occupant** — mirrors `occupyPlace`'s own `if (locId != null)`
guard (line 331) and `placeBlocked`'s `locId == null` early-return (line 279, "unconstrained,
identical to today's no-location behavior"). This applies per-anchor, per-event, and **per-offering**
for electives (§2.1) — an elective set with three offerings where only one has a `location_id` set
registers occupancy for that one offering only; the other two contribute nothing, same as an
`activities` row with no location today. This is the same convention already documented for
`activities.location_id`, extended verbatim to every overlay occupant — no new null-handling design
needed. Note this replaces the prior revision's set-level "mixed-location set is unconstrained"
rule, which no longer applies (§1): nullness is now evaluated per offering, not per set.

### 2.5 Determinism

The registration in §2.1 is unconditional and order-independent per-cell (every overlay cell is
visited exactly once in the fixed `groups × days × timeBlocksSorted` triple loop, same iteration
order Pass 1 already uses deterministically) — it does not consult `rand()` and runs entirely before
`runRound` (Pass 2) which is the only place `rand()` is consulted (`buildSchedule.js:416`). Because
the DJB2+Mulberry32 seed is derived from `campId + cohortId` (line 627-628) and the *inputs*
(activities, groups, days, blocks, locations, overlays) are unchanged by this slice, identical inputs
still produce identical schedules — this slice changes *what capacity looks like*, not *how
randomness is consumed*, so the existing determinism tests need no new seed-stability assertions
beyond the new fixture cases in §5.

## 3. Newly-UNFILLABLE surfacing

Closing this gap means some activities the engine previously placed by **silently double-booking a
location** now cannot be placed there. This must surface as a finding the director sees, never a
silent drop.

**Recommendation: `UNFILLABLE` (existing kind), not a new kind. Confidence: medium-high.**

Rationale: `UNFILLABLE` (`buildSchedule.js:442-444`) is already exactly "no eligible activity could
be placed in this slot," aggregated per-slot at Pass 3. A slot that becomes unfillable *because* its
only remaining eligible activities all needed a now-full location is the same experienced outcome for
the director (a blank cell needing manual attention) as any other unfillable cause — the engine
already collapses "no eligible activity" and "eligible but capacity-blocked" into one `UNFILLABLE`
flag for ordinary activity-vs-activity location contention (this is not new: two activities sharing
a `location_id` already produce `UNFILLABLE` today when the location fills, via the exact same
`placeBlocked` path Slice 4 now also feeds). Introducing a second kind exclusively for
"blocked-by-an-overlay" vs. "blocked-by-another-activity" would fragment one existing, already-
understood vocabulary into two for a distinction the director has no actionable different response
to — both cases mean "pick something else or free up the location," and `UNFILLABLE_reason` (a free
string, already present) is the right place to say *which* kind of contention caused it, not a new
`flags` key.

**Do change `UNFILLABLE_reason`'s text, not the flag/kind**: when `placeBlocked` returns true because
`occupants` include an overlay-sourced entry, the reason string should say so explicitly, e.g. `"No
eligible activity could be placed — <location name> is occupied by <anchor/elective/event name> at
this time"` rather than the current generic string, so the director isn't left guessing why a slot
that "used to" fill no longer does. This requires occupant entries to optionally carry a
`sourceLabel` (the anchor/elective/event's `name`) alongside `{ groupId, tierId }` — a small,
additive shape change to the occupant object, not a new mechanism. `UNFILLABLE_reason` composition in
Pass 3 (line 444) would need the failing activity's blocked location's occupant labels; this requires
threading a bit more information out of `placeBlocked`/`canPlace` than exists today (currently a
boolean) — Maker's call on exact plumbing, but the **outcome** (name the blocking overlay in the
reason string) is the requirement, not optional polish, because this is the single biggest source of
director confusion this slice can introduce.

## 4. Mandatory before/after audit — methodology

Required per the parent slice plan and this task's brief; a hard gate on the PR, not a nice-to-have.

**Method**: run `buildSchedule` twice on each fixture — once with the pre-Slice-4 code path (overlay
occupancy not fed into `placeUsage`; trivially reproducible by running the fixture against the
current `main` branch's `buildSchedule.js`, or by adding a feature-flag-free "before" build via git
stash of just this slice's diff) and once with the post-Slice-4 code — and diff the two `slots`
arrays plus `findings` arrays structurally (not just a line diff; parse both and compare per
`(groupId, dayId, blockId)`).

**Fixture set (both required)**:
1. The engine's own existing test fixtures in `buildSchedule.test.js` — every `describe` block that
   constructs a schedule with at least one location-bearing activity and at least one anchor/
   elective/event sharing that location.
2. A realistic camp-shape fixture — reuse or extend the largest existing integration-style fixture
   under `test/integration/` if one models a full camp week; if none does, the Maker constructs one
   new fixture (documented as new, not silently added to an existing suite) with a small number of
   shared, high-traffic locations (dining hall, pool, field) that multiple anchors/electives/
   activities are known to compete for — the shape a real Shemesh-style layout produces.

**Required report contents** (this is the artifact the owner reviews before approving merge):
- Total (group, day, block) placements whose `activityId` differs between before/after runs, per
  fixture.
- Total newly-`UNFILLABLE` cells (present as filled before, `UNFILLABLE` after), per fixture, with
  the specific (group, day, block, blocking-overlay-name) tuples listed, not just a count.
- Total newly-`UNDERSERVED` findings (an activity that dropped below `min_per_week` because a
  location it needed became contended), per fixture.
- A ranked list of "contention hotspots" — which `location_id`s are the ones actually driving the
  newly-unfillable cells, so the owner can judge whether the newly-surfaced conflicts are real capacity
  problems (correct, wanted behavior) or an artifact of a location's `capacity` being set too low by
  a stale/default import value (a data-quality problem, not an engine problem).
- **Elective-driven contention broken out separately** from anchor-driven and event-driven
  contention in the hotspot list — per §1, a multi-offering elective set now registers occupancy at
  *every* one of its offerings' locations simultaneously, so an elective is likely to be a
  disproportionate contributor to newly-unfillable cells relative to a single anchor/event (one
  elective cell can now consume N locations at once, vs. one for an anchor/event). The report should
  make this multiplier visible, not bury it inside an aggregate count, so the owner can judge whether
  the newly-surfaced conflicts reflect real, wanted capacity pressure (e.g. the gym really is booked
  by both an elective offering and a regular activity) rather than a surprising side effect of how
  many locations one elective set now touches.
- Confirmation that the determinism tests (identical inputs twice) still pass unchanged.

The report is written evidence attached to the PR (a markdown table is sufficient), not a verbal
claim — matching this repo's "deterministic evidence over agent opinion" convention.

## 5. Test seams (`buildSchedule.test.js`)

New `describe` block, e.g. `describe('overlay location contention (Slice 4)', ...)`:

1. **Located anchor blocks overflow.** A location at capacity 1; an anchor for Group A occupies it
   at (day 1, block 1); a regular activity at that same location, eligible for Group B, is attempted
   at the same (day, block) — Group B's slot must resolve `UNFILLABLE` (today it would silently
   double-book). Requires the `anchor_activities.location_id` prerequisite column (§1) — this test is
   blocked until that lands.
2. **Located elective offering blocks overflow.** A location at capacity 1; an elective set with one
   offering pointed at that location is placed for Group A; a regular activity pointed at the same
   location, eligible for Group B, is attempted at the same (day, block) — Group B's slot must
   resolve `UNFILLABLE`.
3. **Mixed-location elective registers occupancy at EVERY offering's location, simultaneously.** An
   elective set with three offerings at three distinct locations (capacity 1 each) is placed for
   Group A; three separate regular-activity attempts, each pointed at one of those three locations
   and each eligible for a different other group, must ALL resolve `UNFILLABLE` — confirms the
   owner-resolved per-offering model (§1), replacing the prior "mixed-location sets are
   unconstrained" behavior this doc previously specified.
3b. **Offering with no location contributes nothing.** An elective set with two offerings, one
   pointed at a real location and one with `activities.location_id == null`, registers occupancy for
   the located offering only — the unlocated offering must not block anything, and nothing about the
   set as a whole is treated as unconstrained just because one offering is.
4. **Located event blocks overflow.** Same shape as #1, for an `events` row via the prerequisite
   `events.location_id` column.
5. **Null-location overlay blocks nothing.** An anchor/elective/event with no resolvable location
   must not affect any other placement — regression guard for §2.4.
6. **Capacity-boundary behavior.** Location at capacity 2; one overlay occupant + one regular
   activity placement together fill it exactly; a third placement attempt is blocked. Confirms the
   occupant-list-not-boolean model (§2.3) still holds with a mixed overlay+activity occupant list.
7. **`same_tier_only` interaction.** A `same_tier_only` activity is blocked from a location an overlay
   already occupies with a different-tier group's anchor.
8. **Determinism preserved.** Running the same inputs twice (including at least one overlay-contended
   fixture) produces byte-identical `slots` output both times — extends the existing determinism
   test pattern already in the suite, not a new mechanism.
9. **Span-tail registration.** A multi-block anchor (`span_blocks: 2`) with a location registers
   occupancy at both its head and tail block — a regular activity attempted at the tail block only
   must also see the location as occupied.

## 6. Migration/prerequisite work

Two additive columns are required before Slice 4's engine change has anything real to feed for two
of the three overlay types — **confirmed unchanged by the owner's elective revision**: electives need
no schema change at all (§1), since every offering's location comes from the already-existing
`activities.location_id` via `elective_set_activities.activity_id`. No `elective_sets.location_id`
column, no migration, no new UI for electives. Per the standing migration-discipline hazard (v43/v44
gates failed on missed sibling tests/mirror-constants — see memory), the two remaining columns
(anchors, events) must land as their own preceding slice
("Slice 3c" in the companion plan's numbering, sequenced after 3a/3b and before 4) with the full
checklist:

- `electron/db/schema.sql`: `location_id TEXT` appended **last** on both `anchor_activities` and
  `events` (matching the column-order-trap convention documented throughout this schema file —
  ALTER-added columns on migrated DBs always append, so fresh-install order must match).
- `electron/db/localDb.js`: new migration version, `ALTER TABLE anchor_activities ADD COLUMN
  location_id TEXT` and `ALTER TABLE events ADD COLUMN location_id TEXT`, both nullable, no backfill
  (NULL preserves today's unconstrained behavior exactly, zero backfill logic — same pattern every
  prior additive column in this file uses).
- `electron/ops/projections.js`: add `location_id` to both `anchor_activities.fields` (line 278) and
  the `events` entry's `fields` list — a column that exists in schema but is missing from the synced
  `fields` array is exactly the class of bug already found live in this file (`unit_id` and
  `activity_id` on `anchor_activities`, §1 above) — do not repeat it.
  Consider fixing the pre-existing `anchor_activities.fields` omissions (`unit_id`, and removing the
  dead `activity_id` read at `buildSchedule.js:118` or adding it to schema+fields if it's meant to be
  real) in the same slice **only if** Governor scopes it in explicitly — otherwise flag it as a
  separate follow-up ticket, since fixing it silently inside Slice 4's diff would make Slice 4's own
  before/after audit (§4) harder to attribute (a behavior change from the `unit_id` fix would get
  conflated with the location-contention change in the diff).
- New migration test file (`electron/db/anchorLocation.migration.test.js` /
  `electron/db/eventLocation.migration.test.js`, or extend the existing
  `anchorRecurrence.migration.test.js`/`events.migration.test.js` siblings — Maker's call, but the
  existing sibling-test convention for every prior additive column in this file must be matched, not
  skipped).
- UI: a location picker on the Recurring Events screen and the Events screen (out of scope for this
  design doc's engine focus — needs its own small Designer touch per this repo's UI-significant gate,
  since it's a new form control on an existing screen, not a new screen).
- `src/engine/buildSchedule.js`'s `anchor.location_id` / `event.location_id` reads (new, added by
  Slice 4 itself per §2) depend on this column existing — Slice 4 cannot be tested end-to-end (test
  cases 1 and 4 in §5) until this prerequisite slice merges. Slice 4's PR should either depend on this
  migration slice merging first, or bundle both if Governor decides the split isn't worth the
  sequencing overhead for two small ALTER TABLEs — Governor's call, not preempted here.

## 7. Open decisions for Governor/owner

1. **RESOLVED by owner: elective location contention is per-offering, not derived at the set level.**
   Each offering in an elective set contends at its own `activities.location_id` independently and
   simultaneously — electives are not a special case of the capacity model; a location is a shared
   physical resource and anything using it (activity, anchor, elective offering, event) draws down
   its capacity (§1). This replaces the prior revision's "shared-location-only, fails-safe"
   recommendation, which is dropped. No further owner input needed on this point; see §1 for the full
   resolved design and §5 for the tests that pin it down.
2. **Migration sequencing: is the `anchor_activities.location_id` / `events.location_id` prerequisite
   (§6) its own gated slice ("Slice 3c") ahead of Slice 4, or bundled into Slice 4's own PR?**
   Recommendation: separate slice, confidence medium — keeps Slice 4's before/after audit (§4)
   attributable purely to the contention-feed change, not entangled with a schema migration's own
   review surface. Counter-consideration: two small ALTER TABLEs is genuinely tiny, and the two-PR
   split adds real sequencing overhead for a program that already has many slices in flight (memory:
   camp-setup-ingestion program). Governor should decide based on current PR-review bandwidth, not
   this doc.
3. **UNFILLABLE_reason enrichment (§3) — naming the blocking overlay by name in the reason string.**
   Recommendation: required, not optional, confidence high — without it, a director sees a
   newly-blank cell with a generic "no eligible activity" message and has no way to connect it to the
   Lunch anchor or Sports Day event that's actually the cause, undermining the whole point of
   surfacing (a director who can't act on a finding might as well not have it). Flagging because it
   adds real plumbing work (§3) beyond the mechanical `placeUsage` feed and could tempt a scoped-down
   Maker into skipping it as "polish."
4. **Should the pre-existing dead `anchor_activities.activity_id`/`unit_id` sync gaps (§1, §6) be
   fixed in the same program or ticketed separately?** Recommendation: separate ticket, confidence
   high — unrelated to this slice's actual requirement (anchors never needed `activity_id` to gain a
   location under the recommended direct-column design) and fixing it inline would contaminate
   Slice 4's audit attribution per §6's note.
5. **DECIDED by Governor, binding, not open: Slice 4's scope is contention-checking only, not
   location auto-assignment.** The engine respects a `location_id` that is already set (on an
   activity, anchor, elective offering, or event) and flags `UNFILLABLE` when contention exceeds
   capacity; it never assigns a location to something that has none. Recorded here (also stated in
   §2.1) so the Maker does not read the owner's "shoresh generates a location for it" phrasing as an
   in-scope requirement — that is a distinct, future capability.

## Recommended path

Land the two-column prerequisite migration (§6) — anchors and events only, electives need no schema
change — as its own small, fast-gated slice first (its own Red Hat schema-change review, per this
repo's standing convention for any additive column on a synced table), immediately followed by
Slice 4's engine change exactly as designed in §2: feed `placeUsage` from all three overlay lookups
via one shared `registerOverlayOccupancy` function reused from `occupyPlace`'s existing
location-half, calling it once for anchors/events and once **per offering** for electives per the
owner-resolved model (§1) — every offering's location contends independently and simultaneously,
with no set-level derivation or fail-safe unconstrained case. Surface new contention as the existing
`UNFILLABLE` kind with an enriched, overlay-naming reason string (§3), keep Slice 4 strictly to
contention-*checking* (never auto-assigning a location, open decision 5), and gate merge on the
mandatory before/after audit report (§4, with elective-driven contention broken out as its own
hotspot category) plus the ten new test cases (§5). The migration-sequencing question (open
decision 2) is the one remaining call that changes scope and should be settled before Maker starts;
the elective-derivation question (former open decision 1) is now resolved and no longer blocks
scoping.
