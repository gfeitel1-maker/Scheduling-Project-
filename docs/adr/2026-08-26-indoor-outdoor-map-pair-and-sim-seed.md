---
title: "ADR: Indoor/outdoor map pair per camp + Day Simulation reads real placements as a seed"
document_type: adr
status: proposed
authority: normative
implementation_state: proposed
date: 2026-08-26
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: []
related_adrs: [docs/adr/2026-08-16-locations-optional-map.md, docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-24-run-the-day-on-the-map.md]
supersedes: []
affects: [docs/adr/2026-08-16-locations-optional-map.md]
---

# ADR: Indoor/outdoor map pair per camp + Day Simulation reads real placements as a seed

## Context

Grounded against a real facility (Gesher Jewish Day School): a single-story L-shaped building
(~27 rooms, gym, dining hall, kitchen, library, Beit Midrash, STEAM/science labs, admin) plus
outdoor grounds (athletic field, playground, court, parking, forest) with the building's roofline
also visible in the outdoor aerial. This is not a hypothetical multi-building campus — it is
**exactly two true images of one place**, and it will recur at most camps that have both a
building and grounds.

Current schema (`docs/adr/2026-08-16-locations-optional-map.md` D1): `camp_maps` is a camp-scoped
**singleton** — `UNIQUE(camp_id)`, `id = camp_id`. `locations.map_geometry` is a fractional
`{x,y,w,h}` box on that one image, with no reference to *which* image it belongs to (there is only
ever one). `locations.kind` already includes a `'building'` value (present, currently unused for
this purpose) alongside room/field/court/etc. kinds. The Day Simulation
(`electron/tileWorld/viewer.html`'s `computeLayout(n, cx, cy, r)`) ignores `map_geometry`/
`grid_x`/`grid_y` entirely and arranges every location's building sprite on a fixed ring — it does
not know indoor from outdoor, and it does not know a room is *inside* a building.

A separate, already-shipped screen (`DayMapScreen.jsx`, `docs/adr/2026-08-24-run-the-day-on-the-map.md`)
is a **different feature**: a read-only 2D occupancy overlay directly on the `camp_maps` image,
reusing `map_geometry` as-is. This ADR does not touch that screen's decisions; it only widens the
data the Day Simulation (the stylized Phaser world) can seed from, and the map storage those two
consumers share.

## Divergence (adhd, 3 parallel frames on the crux: composing one coherent campus from two coordinate spaces)

Full pool (regulator / remove-the-load-bearing-assumption / logistics frames), clustered by angle:

- **Calibration/anchor-pair plays** — require shared landmarks or a canonical third coordinate
  frame before any composite renders; refuse to render an uncalibrated composite. `[N7 V4 F6]`
  Trap: this is survey-grade rigor for a stylized cartoon world that already tolerates distortion
  everywhere else (Tiny Swords sprites are not to scale). Overbuilt for what the Phaser view needs.
- **No-persisted-composite plays** — never materialize a merged truth; recompute the composite at
  render time only, or drop pixel coordinates entirely in favor of a containment graph
  ("Room 12 is inside Building A"). `[N8 V6 F5]` Real insight (recompute-on-read prevents drift)
  but the pure containment-graph variant discards exactly the spatial fidelity ("preserve true
  relative position and adjacency") the brief requires — a trap for *this* task specifically, not
  in general.
- **Disconnected-views plays** — building is a generic sprite on the outdoor scene; clicking it
  pops a totally separate indoor board with no shared coordinate space. `[N6 V7 F3]` Trap: this is
  literally "two products," which is what the brief explicitly wants avoided — one coherent
  campus, not two screens bolted together.
- **Homography/transform plays** — store a full affine or homography matrix per (location, image)
  pair so any room can be correctly projected onto any photo. `[N5 V3 F4]` Trap: solves a problem
  Gesher doesn't have (multiple photos of the same room at different angles) — pure over-engineering
  for a two-image case.
- **Nested-scale-to-fit plays** ★ — the outdoor map is the base coordinate space; the building is
  one placed rectangle on it (already expressible today — `'building'` kind location with
  `map_geometry` on the outdoor image); indoor rooms are positioned by their own `map_geometry` on
  the indoor image, and the Day Simulation maps indoor fractional coordinates into the building's
  outdoor rectangle by two chained scale-to-fit transforms, no rotation/skew, distortion accepted.
  `[N7 V9 F9]` The only cluster that is simultaneously buildable now, requires no new geometry math
  beyond what `map_geometry`'s fraction→pixel conversion already does twice, and matches what the
  brief itself proposed as a candidate stitch.

**Converged pick: nested-scale-to-fit**, because it is the only cluster with real viability *and*
fit — it reuses the existing fraction-of-a-box primitive twice instead of inventing calibration,
graph, or matrix machinery, and it is honest about being approximate (a cartoon world composited
from two hand-drawn maps was never going to be geodetically accurate; a director does not expect
survey-grade adjacency, they expect "the gym is roughly where the gym is").

## Decision

### D1 — `camp_maps` becomes camp-scoped-pair, not a singleton: add `kind`, relax the uniqueness

```sql
-- v(next). Additive, nullable, no backfill required.
ALTER TABLE camp_maps ADD COLUMN kind TEXT;  -- 'indoor' | 'outdoor' | NULL (legacy/single-map camp)
```

Change the uniqueness constraint from `UNIQUE(camp_id)` to `UNIQUE(camp_id, kind)`. This is
**deliberately not a generic N-maps engine.** Nothing in the schema stops a third row, but the
app layer only ever offers two upload slots — "Indoor floor plan" / "Outdoor grounds" — mirroring
how `locations.kind`'s vocabulary is an app-enforced enumeration, not a DB `CHECK`. A camp that
uploads only one map (the common case — most camps are one building, no distinct outdoor identity
worth separating) leaves `kind = NULL`; every existing consumer (`LocationsScreen`'s Map tab,
`DayMapScreen`) that currently does `SELECT * FROM camp_maps WHERE camp_id = ?` and expects one
row keeps working unchanged for every camp that never opens the new "add outdoor map" control —
**this is the same optional-in-every-respect invariant the parent ADR established, extended, not
broken.**

`id` can no longer be `= camp_id` for the second row (that assumption dies the moment a camp has
two rows) — mint a UUID for any row beyond the first, same as `locations` already does. The
existing `id = camp_id` row (every camp that has ever uploaded exactly one map today) is
treated as a pre-existing, effectively-`kind = NULL` row and is **never rewritten** by this
migration — no backfill, no reclassification guess. If a director later explicitly adds a second
map, the *new* row gets a kind and a minted id; the old row's `kind` stays `NULL` unless the
director explicitly relabels it via the UI (a one-field write, not a migration concern).

### D2 — `locations` gains one nullable field: which map a location's `map_geometry` is relative to

```sql
ALTER TABLE locations ADD COLUMN map_id TEXT;  -- FK-by-convention to camp_maps.id, no DB FK
```

Same FK-by-convention discipline the rest of this schema already uses for `activities.location_id`
and `anchor_activities.location_id` (per `docs/adr/2026-08-15-camp-locations-entity.md`'s
"column-order trap" note) — no `REFERENCES` clause, checked at the application layer only.

**Back-compat is the point of this field being nullable, not an afterthought:** `map_id IS NULL`
means "this location's `map_geometry` is expressed against the camp's only map" — exactly today's
behavior, unchanged, for every camp with zero or one `camp_maps` row. `map_id` only needs a real
value once a camp has *two* rows and a location's geometry needs to say which one it was drawn on.
`LocationsScreen`'s Map tab, when rendering, resolves the target image as: the row matching
`location.map_id` if set, else the camp's single row if there is exactly one, else (two rows, no
`map_id` on the location) prompt the director to choose which map the pin belongs on before it can
be placed — this is the one new UI decision D2 introduces, and it only appears for camps that
opted into a second map.

### D3 — Registry checklist (mirrors the parent ADR's own table exactly)

| # | Registry | File | Entry |
|---|---|---|---|
| 1 | `PROJECTIONS` | `electron/ops/projections.js` | add `'kind'` to `camp_maps.fields`; add `'map_id'` to `locations.fields` |
| 2 | `DOMAIN_TABLE_COLUMNS` | `electron/sync/syncClient.js` | add `'kind'` to the `camp_maps` column array; add `'map_id'` to the `locations` column array — **do this explicitly, do not assume it follows from PROJECTIONS** (see the pre-existing gap flagged below) |
| 3 | `MOCK_WRITE_ALLOWLIST` + column list | `src/localClient.mock.js` | hand-transcribed mirror, per the standing "do not import from `electron/`" rule |
| 4 | `schema.sql` + `localDb.js` migration block | both | byte-identical DDL, bump `CURRENT_SCHEMA_VERSION`, migration test twin (fresh vs. migrated `PRAGMA table_info` equivalence) |
| 5 | `ENTITY_LABEL` (optional) | `src/screens/recordLabels.js` | no change needed — both entities already labeled |

**Pre-existing gap found during this design, not introduced by it:** `DOMAIN_TABLE_COLUMNS.locations`
in `electron/sync/syncClient.js` is currently `['id', 'camp_id', 'name', 'capacity', 'notes',
'sort_order', 'map_geometry']` — missing `kind`, `grid_x`, `grid_y`, which already exist in
`PROJECTIONS` and are used by the Phaser viewer today. A freshly-paired device's first-pairing
snapshot silently omits those three columns for every existing location; they only arrive once
each location happens to receive a fresh live op after pairing. This is an app-wide, pre-existing
platform gap (not scoped to this ADR's change) — flagged to Governor as a separate ticket, and
explicitly called out here so `map_id` and `camp_maps.kind` are not added to `PROJECTIONS` alone
and left with the same gap repeated a second time.

## D4 — Render-seam contract: Day Simulation reads placements as a seed, not a second source of truth

New pure function, `src/engine/tileWorldLayout.js` (no React/Phaser/IPC dependency, testable like
`buildSchedule.js`):

```
deriveSimLayout({ locations, campMaps, worldWidth, worldHeight })
  → { placements: Map<locationId, {x, y}>, unplaced: locationId[] }
```

Algorithm:

1. Partition `locations` by which `camp_maps` row (if any) their `map_geometry` is expressed
   against (`location.map_id`, falling back to the camp's single map when there is only one row,
   per D2). Locations with no `map_geometry`, or whose `map_id` names a map row that doesn't
   exist, go straight to `unplaced`.
2. **Outdoor-anchored locations** (including any `kind: 'building'` location, since a building
   footprint is placed on the outdoor map): scale-to-fit the outdoor map's fractional
   `map_geometry` box directly onto `(worldWidth, worldHeight)`, preserving the map's own aspect
   ratio (letterboxed, same fit-to-container math `LocationsScreen`'s `MapCanvas` already uses —
   reused, not reinvented). This yields each outdoor location's/building's `{x, y}` scene position
   directly.
3. **Indoor locations belonging to a building:** resolve the containing building by
   `kind === 'building'` **and** the same `camp_id` (there is at most one `'building'`-kind
   location expected per camp for Gesher's shape; if a camp somehow has more than one, indoor
   locations with no explicit link fall to `unplaced` rather than guessing — see Open Questions).
   If that building location has a resolved outdoor scene rectangle from step 2, an indoor
   location's own fractional `map_geometry` (expressed on the *indoor* map) is scaled into that
   rectangle: `sceneX = buildingRect.x + fracX * buildingRect.w`, `sceneY = buildingRect.y + fracY
   * buildingRect.h`. This is a second scale-to-fit, chained — no rotation, no homography,
   distortion accepted (the converged candidate's explicit tradeoff).
4. **Fallback, per location, not per camp:** any location that cannot resolve a scene position by
   steps 2-3 — no map at all, `map_geometry` present but unparseable, an indoor room whose
   building never got placed on the outdoor map — falls into `unplaced`. The viewer's existing
   `computeLayout(n, cx, cy, r)` ring is *not deleted*; it becomes the renderer for exactly the
   `unplaced` set, positioned in the same ring space the whole scene already uses today. This
   mirrors `LocationsScreen`'s own established "positioned vs. off-map, split never dropped"
   convention (`locationMap.css`/`UnplacedTray`) — a location director hasn't placed yet is not
   hidden, it just renders where it always has.

This function is called once per Day Simulation session-open (not per frame) — placements are
static seed data, matching the brief's "seed, not live re-derivation" framing. `viewer.html`'s
`CampScene.create()` calls `deriveSimLayout` in place of its current unconditional `computeLayout`
call, and only ring-positions the `unplaced` subset.

## Ranking — required now vs. deferrable

| Item | Required now | Rationale |
|---|---|---|
| `camp_maps.kind` column + `UNIQUE(camp_id, kind)` relax | **Required** | The one schema fact that unblocks a real camp having both maps at all |
| `locations.map_id` column | **Required** | Without it, a location's `map_geometry` is ambiguous the moment a camp has 2 map rows |
| `deriveSimLayout` pure function + viewer.html wiring | **Required** | This is the actual product ask (Q2/Q3) — everything else is what makes it possible without guessing |
| Two-slot upload UI ("Indoor" / "Outdoor" instead of one "Map" control) | **Required** | Directors need a way to create the second row at all |
| `'building'`-kind footprint placement as the stitch anchor | **Required** | Already expressible with existing `kind` vocabulary + `map_geometry`; no new concept, just a documented convention |
| Sync registry updates (D3) | **Required** | Skipping this repeats the exact `grid_x`/`grid_y` gap already found in the codebase |
| Fixing the pre-existing `grid_x`/`grid_y`/`kind` snapshot-sync gap | **Deferrable, spun off separately** | Real bug, but predates and is independent of this ADR — do not silently bundle an unrelated fix into this migration |
| Supporting >2 `camp_maps` rows per camp (true multi-building campuses) | **Refuse for now** | No evidence any real camp in scope needs it; `UNIQUE(camp_id, kind)` with a 2-value enum is the smallest schema that is *forward-compatible* with it (widening the `kind` enum later is additive) without building for it today |
| General affine/homography per (location, image) pair | **Refuse** | Solves a problem (multiple photos of the same room at different angles/scales) Gesher does not have; the nested scale-to-fit is sufficient and is what the divergence converged on |
| Calibrated anchor-point reconciliation (survey-grade stitching) | **Refuse** | Wrong register of precision for a stylized cartoon renderer; the brief itself asks for "abstracted/stylized," not geodetic accuracy |
| Letting `DayMapScreen` (the 2D occupancy overlay, a different feature) consume the indoor/outdoor pair | **Deferrable** | Out of scope for this ADR — that screen currently assumes one map and nothing here forces it to change; worth a follow-up once directors actually have two maps to view occupancy against |

## Consequences

- **Positive:** Gesher (and any camp with a building + distinct outdoor identity) becomes
  representable with two additive nullable columns, zero new tables, zero new op-log machinery
  (both fields ride the existing field-level LWW/conflict/sync path `map_geometry` and
  `image_data` already use). The Day Simulation stops being disconnected fiction and starts
  reflecting what the director actually placed, while degrading gracefully (per-location, not
  per-camp) to today's ring layout for anything unplaced.
- **Costs:** `LocationsScreen`'s Map tab needs a small UI addition (choose-target-map prompt when
  a camp has two rows and a location has no `map_id` yet) that does not exist today at all — this
  is new surface, not a reuse. The "must resolve to exactly one `'building'`-kind location per
  camp" assumption in D4 step 3 is a real, load-bearing constraint that needs a defined fallback
  if violated (see Open Questions).
- **Explicitly not decided here:** the exact copy/UX of the two-slot upload control (Designer's
  call, not architecture); whether `DayMapScreen` should later gain the same indoor/outdoor
  awareness.

## Open questions for Governor

1. **Zero or multiple `'building'`-kind locations on one camp.** D4 assumes exactly one. If a
   director never marks any location as `kind: 'building'`, all indoor locations fall to
   `unplaced` (safe default, no crash) — confirm that's acceptable rather than, say, auto-treating
   the first indoor location as an implicit building anchor (rejected here as a magic inference
   the brief's "director never builds this" framing argues against, but worth an explicit nod).
2. **Two-slot upload UI copy and placement** — hand to Designer once this ADR is accepted; not an
   architectural decision.
3. **Whether to also update `DayMapScreen` (B1 occupancy view) to respect indoor/outdoor** is
   deliberately left open/deferred per the ranking table — confirm that's the right sequencing
   (ship the Day Simulation change first, revisit B1 only if a real camp actually uses two maps
   and finds B1's single-map assumption limiting).
