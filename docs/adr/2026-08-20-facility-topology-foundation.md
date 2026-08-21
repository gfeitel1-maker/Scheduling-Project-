---
title: "Facility topology foundation — authored adjacency, not pixel distance (direction ratified, build deferred)"
document_type: adr
status: accepted
authority: normative
implementation_state: deferred-build (direction ratified; build deferred per owner decision)
date: 2026-08-20
approved: 2026-08-20 (owner ratified direction after the Red Hat pre-ratification corrections; build deferred)
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-15-camp-spatial-model-assessment.md
  - docs/work/specs/2026-08-20-electives-specialdays-facility-audit.md
related_adrs:
  - docs/adr/2026-08-15-camp-locations-entity.md
  - docs/adr/2026-08-16-locations-optional-map.md
related_tickets: [docs/work/tickets/T101-locations-deterministic-id-rename-recollide.md]
gates: ["GATED on docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md (foundational) for the in-context-create rule; also T101 must be resolved before any name-derived location create path."]
archive_when: superseded by a build ADR when travel-cost is scheduled, or rejected
---

# Facility topology foundation — authored adjacency, not pixel distance

**Revision note (Red Hat, 2026-08-20, pre-ratification):** D5 corrected. The in-context location-create
flow must mint via `randomUUID` + local-name dedupe (like `createActivityFromCell`), not
`deriveLocationId` — so it is *already* safe from T101, and T101 gates only the name-derived/batch paths,
not the interactive cell flow. The earlier "T101 hard-gates the in-context flow" named the wrong lever.
(Locations are ingestible, so their tier (c) correctly lands in the census — consistent with the
corrected foundational D3.)

**Gated on the foundational durability ADR (2026-08-20).** Owner decision: **ratify the direction now,
defer the build.** This ADR locks *how* travel cost will eventually be modeled so future map work cannot
drift toward GIS/pixels — cheaply, without scheduling the travel-cost feature.

## Context

The `locations` model is genuinely deep and correct for **identity + capacity + contention**: a
first-class op-log entity, engine-consumed capacity (`locationCapById`, the order-dependent capacity bug
fixed), deterministic ids (`deriveLocationId`), per-week availability (`week_location_exclusions`). The
**map (M6) is deliberately a stub**: `locations.map_geometry` `{x,y,w,h}` fractions are read by nothing
outside `LocationsScreen`'s own render — decorative, not authoritative.

Research is decisive: the maps a director can actually upload are overwhelmingly **raster and not to
scale** (illustrated/brochure/hand-drawn/Google-screenshot), a real fraction of camps have **no map at
all**, and **travel cost cannot be reliably derived from pixels** (no scale, ignores the real foot-path —
a lake or fence between two pins). Directors know *the walk* ("waterfront connects to the field," "bunk to
gym is 5 minutes"); they do not know coordinates. **The image is the friendly UI; the authored graph is
the truth.**

## Decision

### D1 — Travel cost, when built, comes from director-authored adjacency — never from image pixels

This is the ratified architectural direction. A future travel-cost model reads a **director-authored graph
of places**, not `map_geometry`. Pixel geometry stays an orientation/communication aid only. No GIS, no
computer vision, no scale inference from uploaded images — ever, as a matter of decided architecture.

### D2 — The minimal foundation shape (defined now, built later)

The single new structure the direction implies:

- **`location_connections`** (camp-scoped, op-log-synced): `(id, camp_id, from_location_id,
  to_location_id, cost_minutes)` — director-authored adjacency. One ordinary camp entity turns "a list of
  places" into "a graph of places." Edges are authored, so there is nothing to backfill.
- **A location-level `kind`** (indoor/outdoor) — kept *separate* from `activities.is_outdoor` (a weather
  concern on the activity), per the locations findings. Additive nullable column.

Both follow the established both-places DDL + nullable-additive pattern. **This ADR does not schedule
their build** — it fixes the shape so it can't be re-litigated toward pixels later.

### D3 — The uploaded image is the authoring UI for the graph, not a metric source

When travel-cost is eventually built, the intuitive gesture is: the director drops pins on their (non-
scale) image as they already can, then **clicks two pins → "how long is this walk?"** to author a
`location_connections` edge. This makes the friendly image the *entry surface* for the authoritative
graph, and degrades gracefully for the no-map camp (author edges with no image at all).

### D4 — Do not extend map UI until something downstream reads geometry

Adding more map polish now compounds "UI without authoritative data." **No further map UI** ships until a
real consumer (the graph, or a derived-adjacency hint) reads location geometry. (Opinion, ratified as a
constraint.)

### D5 — In-context location create uses `randomUUID` + local dedupe (NOT `deriveLocationId`); T101 gates only name-derived paths

**Corrected after Red Hat.** The in-context "type a location in a cell" flow **must mint via
`crypto.randomUUID()` with a local normalized-name dedupe lookup**, exactly like `createActivityFromCell`
(`useSlotMutations.js:943-988`) — **not** `deriveLocationId`. This matters because Shoresh already decided
(`docs/adr/2026-08-15-locations-concurrent-create-collision.md`) that *interactive* creates use random
uuids specifically to avoid the rename-recollide hazard; `deriveLocationId` is confined to the two
**batch/importer** paths (`electron/ops/ingest.js`), which is what T101 is scoped to.

Consequences of getting this right:
- The interactive cell flow is **already safe** from T101 by construction — so T101 is **not** a blocker
  on it. The earlier "T101 is a hard prerequisite for the in-context flow" was wrong (it named the wrong
  lever).
- **T101 remains a hard prerequisite only for name-derived / batch create paths** (ingest, CSV import)
  and for any *topology* feature that would mint or match location ids by name.
- The ADR states the id strategy explicitly so a future Maker cannot drift toward `deriveLocationId` "for
  consistency with the rest of `locations`" and thereby *reintroduce* the hazard the owner already
  rejected.

## Durability mapping (honors the foundational ADR)

A location typed in-context is **tier (c) durable** by nature — a place is permanent camp knowledge and an
ingestible/census entity. It flows into the *same* `locations` row a director later gives capacity and
adjacency — **no duplicate setup.** There is no meaningful one-off/this-summer tier for a physical place;
locations are the area where the durable tier is the default, not the exception.

## Reuse / refactor / remove / missing

- **Reuse unchanged:** the entire `locations` entity, `deriveLocationId`, the engine capacity seam,
  `week_location_exclusions`, `camp_maps`, and the resolution-independent `{x,y,w,h}` convention (a future
  scaled plan can reinterpret it).
- **Refactor:** none required now.
- **Remove:** nothing (frozen `activities.location` is a harmless restore fallback).
- **Missing (foundation, build deferred):** `location_connections`, location `kind`, any consumer of
  `map_geometry`.
- **Migration:** additive nullable columns + one new table when built; no backfill possible or needed.

## Consequences

- **Positive:** the architecture for travel cost is locked cheaply and correctly; future map work cannot
  drift into fragile pixel-distance; the no-map camp is served.
- **Risk:** the pull toward GIS/CAD/computer-vision on uploaded images — explicitly and permanently out of
  scope by D1. Second: building `location_connections` before a consumer would be premature — hence build
  is deferred until travel cost is actually wanted.
- **What this ADR deliberately does NOT do:** schedule the travel-cost build, add an engine "too far to
  reach next period" flag, or ship any new map UI. Those need their own build ADR when prioritized.

## Gate

Gated on the foundational ADR (for the in-context location-create rule) **and** on T101 being resolved
before any name-derived location create path. No Maker work is authorized by this ADR beyond, at most,
introducing the two dormant shapes (`location_connections`, `kind`) if the owner wants the schema locked
ahead of the feature — otherwise this stays a direction-only record until a build ADR supersedes it.
