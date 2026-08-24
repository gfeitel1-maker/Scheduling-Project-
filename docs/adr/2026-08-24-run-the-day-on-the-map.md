---
title: "ADR: Run the Day on the Map (B1) — read-only spatial schedule view"
document_type: adr
status: accepted
authority: normative
implementation_state: proposed
date: 2026-08-24
deciders: [product-owner]
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_specs: []
related_adrs: [docs/adr/2026-08-16-locations-optional-map.md, docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
supersedes: []
affects: []
---

# ADR: Run the Day on the Map (B1) — read-only spatial schedule view

## Context

Three things already exist independently and B1 is purely their composition — no new schema:

1. **A built schedule's placement.** `schedule_templates` rows carry `kind` ('manual' | 'generated') and `week_id` (`src/screens/LocationsScreen.jsx:798`, `ScheduleScreen.jsx` route policy at `src/screens/ScheduleScreen.jsx:64-80`). `template_slots` rows carry `group_id, day_id, time_block_id, activity_id` (`electron/db` schema; mapped 1:1 in `src/data/scheduleRepository.js`'s `mapSlotToRow`). **`template_slots` carries no `location_id`.** A slot's place is reached only by following `activity_id → activities.location_id` (confirmed at `src/screens/LocationsScreen.jsx:799`: `boundActivityIds = activities.filter(a => a.location_id === location.id)`, then slots filtered by `boundActivityIds.has(s.activity_id)`). This exact join — `schedule_templates` (by `week_id` + `kind`) → `template_slots` (by `template_id`, then `day_id`/`time_block_id`) → `activities.location_id` → `locations` — is already used for a non-engine, read-only purpose in `LocationsScreen.jsx:792-802` (counting placed slots before allowing a location-exclusion toggle). B1 reuses this exact recipe.

2. **Contention math.** `src/engine/buildSchedule.js:198-217` builds `placeUsage`, a `Map` keyed `"locationId|dayId|blockId"` → occupant list, capped at `locationCapById` (built at `buildSchedule.js:665-677`, `capacity > 0 ? capacity : 1`). This is an **engine-internal** structure: it exists only inside a `generate()` call, is never persisted, and computing it means invoking the full engine (seeded PRNG, eligibility pass, placement pass) against the read schedule's `slots`, most of which is irrelevant to a read-only viewer that already knows the placements.

3. **Map + geometry.** `camp_maps` (`image_data/mime/w/h`, one row, non-`camp_id`-keyed per `docs/adr/2026-08-16-locations-optional-map.md`) and `locations.map_geometry` (`TEXT`, JSON `{x,y,w,h}` fractions of the map's box, absent = unplaced). Rendered today by `MapCanvas`/`LocationMarker` in `src/screens/LocationsScreen.jsx:419-460` and `src/components/locations/locationMap.css`.

## Decision 1 — derive occupancy directly, do not invoke the engine

**B1 re-derives per-block occupancy from `slots` + `activities.location_id` itself. It never calls `buildSchedule`/`scheduleCohort` and never reads `placeUsage`.**

Rationale:
- `placeUsage` is not a stored or independently reachable artifact — it lives inside one `generate()` call's closure. Reusing it would mean either (a) persisting it as new schema (rejected — the spec says no schema change, and `placeUsage` was deliberately never persisted per the buildSchedule.js "single write path" comment at line 209) or (b) re-running the full generator against the current schedule just to read this map back out, which is wrong for two reasons specific to this feature: it would silently *re-randomize/re-place* an already-built, human-edited manual schedule (the engine's job is to place; a viewer's job is to read), and it would compute eligibility/anchor passes B1 has no use for.
- The join B1 needs is strictly simpler than what the engine computes: "for day D, block B, group G is at activity A's location L" is a filter + two lookups, no scheduling logic. `LocationsScreen.jsx:792-802` already proves this join is cheap and correct for a read-only consumer.
- Capacity comparison (`occupants.length > capacity`) is one line, identical in shape to `buildSchedule.js:342-344`'s own check, but computed against the *actual persisted* `locations.capacity`, not a placement-time snapshot.

This keeps B1 genuinely read-only in the strongest sense: it cannot re-place anything, because it never invokes placement.

## Decision 2 — nav placement: new row under the existing Schedule section, route-scoped

Add `{ key: 'schedule:map', label: 'Day Map' }` to `NAV_SECTIONS`'s `schedule` section in `src/components/layout/navSections.js`, alongside `schedule:generated` / `schedule:manual` / `schedule:special` / `schedule:electives`. Register `'schedule:map'` in `src/screenKeys.js`'s `SCREEN_KEYS` set (required — `screenDestinationsExist.test.js` checks every nav `screen` value against it) and add a `DayMapScreen` entry to `SCREENS` in `src/App.jsx` alongside the existing `'schedule:manual'`/`'schedule:generated'` entries.

**Route selection:** the map view needs one route's schedule, and per `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md` neither route is canonical and the app must never pick on the director's behalf. B1 exposes an explicit **in-screen route toggle** (Manual / Generated), mirroring the toggle already present as the two separate sidebar rows — defaulting to whichever route the director last viewed in ScheduleScreen is tempting but was rejected: it would silently designate a "remembered" schedule, the exact anti-pattern the ADR forbids ("no reordering, no recency, no usage-based promotion" applies here by the same logic). Default to `'generated'` on first visit (matching `ScheduleScreen.jsx:78`'s own default when nothing else is set), switchable via two tabs/pills at the top of the screen, next to the day/block picker. This is pure screen state (`useState`), not persisted — same posture as `ScheduleScreen`'s own `route` handling before a sidebar destination pins it.

**Day/block picker:** a simple pair of selects (or day-tabs + block-list), sourced from `days_of_operation` and `time_blocks` — both already loaded by every setup screen via `localClient.list(...)`. Default to the first day/first block, or (nice-to-have, not required for B1) the current real-world day/block if it falls within camp days — leave that refinement to the Maker's judgment, non-load-bearing for the design.

## Decision 3 — marker model

**One marker per group**, positioned at `JSON.parse(activity.location_id → locations.map_geometry)` for the group's activity in the selected (day, block). Reuse `LocationMarker`'s geometry math (`src/screens/LocationsScreen.jsx:307-365`, `locationMap.css:16` fraction→pixel derivation) as the layout primitive — do not reimplement fraction-to-pixel conversion. `LocationMarker` currently renders one location; B1's marker is a **new small component** (e.g. `GroupMarker`) that reuses the same geometry hook/positioning math but renders a group's identity (color-coded by tier or a simple label chip) rather than a location's own marker chrome. The distinction: `LocationMarker` is "this place, at this spot"; B1 needs "these groups, clustered at this place's spot."

**Multiple groups at one location (the normal and the contention case):** cluster at the location's `map_geometry` box — a stacked/overlapping pile of small group chips (2-4 visible, "+N" overflow beyond that), not one marker per group scattered arbitrarily near the spot (there is no per-group sub-position to place them at; `map_geometry` belongs to the location, not the assignment). Clicking/hovering the cluster expands the full occupant list — reuse whatever disclosure pattern `LocationMarker`'s own click-to-select already uses for consistency.

**Groups with no location (`activities.location_id IS NULL`):** omit from the map canvas — they have no coordinate, and inventing one (edge tray, corner stack) implies a spatial fact that doesn't exist and risks reading as "this group is somewhere near the map," which is false. Instead, list them in a small **"Not on the map" panel** below or beside the canvas (same idiom as `LocationsScreen.jsx:1128`'s `UnplacedTray`, but naming groups + activities, not locations) — plain text rows, no map interaction. This tells the director *why* a group is missing rather than silently dropping it, without fabricating a position.

## Decision 4 — jam visualization

Per `DESIGN_STANDARD.md` §4: `--danger` (brick) is reserved for destructive/error/`UNFILLABLE`-class meaning — contention here is exactly that class ("this place cannot hold what's assigned to it," structurally analogous to `UNFILLABLE`). Use `--danger`, not `--accent` (bronze is for "needs attention/in progress," a softer register than an active capacity violation).

Concrete treatment, implementable directly from tokens already defined:
- A jammed location's cluster gets a `1px solid var(--danger)` ring around the stack (matches the "thin borders, soft corners 6-10, minimal shadow" personality in §5) plus a small filled badge showing `occupants/capacity` (e.g. "5/3") in `color-mix(in srgb, var(--danger) 8%, var(--surface))` background, `var(--danger)` text — the same tint formula §6 already prescribes for `authErrorBox`.
- Mount/entry motion for a newly-jammed cluster (e.g. after switching block): **Fade + Lift**, `--motion-base` (220ms), `--ease-out`, matching §5a's empty-state and §5c's inline-error treatment — no bounce/elastic (§8 forbids it outright).
- `@media (prefers-reduced-motion: reduce)`: render the ring/badge instantly, no fade/lift — per §5's blanket rule ("every animation ships a reduced-motion fallback: crossfade or instant"), never *no* feedback — the ring and badge themselves are the feedback and are unconditional; only their entrance animation is gated.
- Non-jammed clusters get a neutral `1px solid var(--border)` ring, no badge — so the jam ring is the only red on the screen, keeping it loud (§4's "reserve the alarm color" principle).

## Decision 5 — degenerate states

Reuse `DESIGN_STANDARD.md` §5a's empty-state spec (centered, no card/shadow, outline icon, single CTA) for all three:

- **No map uploaded:** empty state, CTA "Upload a map" → navigates to `'locations'` (existing screen, existing upload flow at `LocationsScreen.jsx:643-692`). Detect via `camp_maps` list being empty, exactly as `LocationsScreen.jsx` itself must already do to decide whether to show `MapCanvas` or its own empty state — reuse that same check.
- **No schedule built for the selected route:** empty state, CTA "Build the {route} schedule" → navigates to `'schedule:manual'` or `'schedule:generated'` per the active toggle. Detect via no `schedule_templates` row of that `kind`+`week_id`, or a row with zero `template_slots`.
- **Block with no located group (every assigned activity has `location_id: null`, or no groups assigned at all):** not a screen-level empty state — the map still renders (it may hold locations from other blocks/days), just with an empty canvas and the "Not on the map" panel doing the explaining (Decision 3), or, if literally no groups have any placement at that block, a lighter inline note ("No groups scheduled for this block") rather than the full-screen empty-state treatment, since the map/nav chrome itself is not degenerate.

No blank-crash states: every one of these three is a known, filterable precondition checked before render, not a caught exception.

## Decision 6 — B1/B2/B3 slice boundary

- **B1 (this ADR):** static per-(day, block) marker view + contention highlight. No animation between blocks, no drag. Selecting a new day/block re-renders from a fresh derive — no transition state to manage beyond the DESIGN_STANDARD-mandated fade/lift on individual marker changes.
- **B2 (later, not designed here):** scrub/animate through blocks — likely a slider driving the same day/block state B1 already exposes, interpolating marker positions/opacity between adjacent blocks' derived snapshots. B1's `deriveOccupancy(day, block)` function (Decision 1) is the natural unit B2 calls repeatedly; no B1 design choice blocks this.
- **B3 (later, not designed here):** drag-to-reschedule from the map. Requires write paths (the same `writeFields`/`bulkReplace` seam `scheduleRepository.js` already exposes) and turns the read-only marker into a draggable one — B1's `GroupMarker` component is the natural drag target, but B1 itself performs no writes and needs no drag/DnD wiring. Keeping `GroupMarker` a presentational component (props in, no internal write calls) in B1 is what makes it extendable rather than requiring a rewrite for B3.

## Consequences

- No schema change (verified: `camp_maps`, `locations.map_geometry`, `template_slots`, `activities.location_id` all pre-exist and are unmodified).
- One new screen, one new nav row, one new screen-key registration, one new small presentational component (`GroupMarker`) reusing `LocationMarker`'s geometry math. No changes to `buildSchedule.js`, `scheduleRepository.js`, or any persisted table.
- The read-only-derive decision (Decision 1) is the one non-obviously-reversible call here: it commits B1 to *not* being engine-truth (e.g. it won't show `UNFILLABLE`/`DISTRIBUTION` findings, only its own occupancy-vs-capacity check) in exchange for simplicity and honesty about being a viewer, not a re-placement. Reversing this later (routing through the engine) would require establishing `placeUsage` as a queryable/exported thing, which is a real, if small, architecture change — flagged here so it isn't rediscovered as a surprise in B2/B3.

## Alternatives considered and rejected

- **Persist `placeUsage`-equivalent as a derived table.** Rejected: no other read-only view in this app persists a derived cache (findings are recomputed on demand via `computeFindings`, `buildSchedule.js:585`), and B1's derive is cheap enough (bounded by slot count for one day/block) not to need one.
- **Reuse the engine's `computeFindings`/`recompute` pass instead of a bespoke join.** Rejected: `computeFindings` answers "is this schedule well-formed" (UNDERSERVED/DISTRIBUTION), a different question than "who is physically where right now" — no overlap in output shape, so there's nothing to reuse there.
- **Put the map view under Roots (as a sibling of the Locations setup row) instead of under Schedule.** Rejected per owner's explicit decision (task brief): this is a schedule-reading view, keyed to route + day + block, not a setup screen — belongs with `schedule:generated`/`schedule:manual`, not `roots`'s `locations` child.
