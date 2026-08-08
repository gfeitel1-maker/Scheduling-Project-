---
title: "Location & Camp-Map Findings"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Location & Camp-Map Findings

Synthesis of §7 (with the §2 constraint-precedence and resolved-decision inputs) of the
onboarding-reconciliation synthesis. Pre-approval; no code. This document defines the *shape*
of Location as a first-class concept and marks explicitly what is deferred, optional, or out
of scope.

## 1. Key finding: the engine already uses Location for contention

Location is **not a new engine concept**. The scheduling engine already reads `activity.location`
and uses it as a **simultaneous-use contention constraint** — two groups cannot occupy the same
space in the same day/block.

Verified in the repo:

- `src/engine/buildSchedule.js:186` — `locationUsage` map, keyed `"location|dayId|blockId"`.
- `src/engine/buildSchedule.js:202` — `locationKey(location, dayId, blockId)` builds that string key.
- `src/engine/buildSchedule.js:224-236` — `canPlace()` enforces `max_groups_per_slot` (with
  `same_tier_only` refinement) against `locationUsage` for the location string.
- `src/engine/buildSchedule.js:259-274` — `place()` records occupancy into `locationUsage`,
  including tail blocks of multi-block spans.

The location value itself is a **free-text `TEXT` column**:

- `electron/db/schema.sql:211` — `location TEXT` on `activities` (no id, no aliases, no relationships).
- `src/screens/ActivitiesScreen.jsx:56,118` — a plain text input ("e.g. Pool, Gym"); the string is
  typed by hand per activity.

**Consequence:** promoting Location to a first-class entity is *mostly an onboarding concern* —
stable identity/aliases, proposing a facility catalog, and not retyping "Pool" on 40 activities,
with safe reconciliation. It is **not** primarily an engine change.

## 2. The one engine consequence, and it is deferred

There is exactly **one** engine consequence of first-classing Location: the contention key must be
re-keyed from a **location string → a location entity id**. Today `locationKey(location, ...)`
concatenates the free-text string; once activities point at an `activity_locations` row, contention
must key on `location_id` so that two aliases of the same real place ("Pool" / "The Pool") contend
correctly.

This is a **refactor of existing behavior** — it changes *nothing* about how scheduling decides,
only what token identifies "the same space." It is **deferred to the engine slice** (S3 in the
sequence), separate from the onboarding/modeling work.

This embodies the resolved product-owner decision: **define the box shape now (cheap, reversible),
defer engine enforcement to its own tested slice.** The captured-not-enforced tradeoff is real and
must be handled honestly in the UI — until the engine slice lands, a `location_id` set during
onboarding is *captured* but the engine still contends on the TEXT fallback. The UI must not imply
the new relationship is being enforced before it is.

## 3. Soft-migrate recommendation

Recommended data shape (modeling only; no migration runs pre-approval):

- Add an `activity_locations` entity: `(id, camp_id, name, aliases[, capacity, indoor/outdoor,
  availability])`.
- Add a **nullable** `activities.location_id` foreign key.
- **Keep the existing `location TEXT` column** on `activities` as a denormalized fallback / cache.
  This is what lets the engine keep running unchanged until S3 re-keys it, and it is the graceful
  path for activities that have not yet been reconciled to a catalog entry.
- Register `activity_locations` in the projections layer; all writes go through `appendOp` (never
  raw SQL), consistent with the existing op-log commit model.

Confidence: high that soft-migrate (nullable id + retained TEXT) is the right call — it is the
minimal, reversible change that preserves current engine behavior and avoids a hard cutover.

## 4. Do NOT absorb `is_outdoor`

`is_outdoor` is a **separate boolean** and must remain so.

- `electron/db/schema.sql:212` — `is_outdoor INTEGER`, distinct from `location`.
- `src/screens/ActivitiesScreen.jsx:57,83` — edited and persisted independently of `location`.

A location entity may *optionally* carry its own indoor/outdoor attribute, but the activity's
`is_outdoor` flag (used for weather logic) must **not** be folded into or replaced by the location
entity. They answer different questions and are set independently today. Absorbing one into the
other would silently couple weather behavior to facility identity.

## 5. Activity ↔ Location relationship

Model the relationship as **preferred / allowed / default**:

- **preferred** — the space an activity is normally run in.
- **allowed** — spaces the activity *may* use (informs future feasibility/alternatives).
- **default** — the single location assumed when nothing else is specified.

This is the modeling target; enforcement of "allowed" sets is engine work and follows the same
defer-to-its-own-slice rule as the re-key.

## 6. Location-availability calendar is SEPARATE, optional, not requested

**Contention ≠ availability.** The engine's existing use of location answers "is this space already
taken *by another group* in this slot" — a simultaneous-use constraint. A **location-availability
calendar** ("pool closed Fridays") answers a different question — whether the space is open at all.

The availability calendar is:

- **Separate** from contention,
- **Optional**,
- **Not requested** in the current program scope.

Set it aside unless a specific camp needs it. Do not build it into the first-class Location shape as
a requirement; at most leave an optional `availability` attribute slot on the entity.

## 7. Map-assisted location setup (scope) and the map-label flag

Map-assisted setup (S7 in the sequence) is scoped as: **propose a Location catalog from a site-map /
facility list**; the director confirms, renames, merges, or rejects each proposed location. It goes
through the **same reviewable, non-skippable preview** as every other reconciliation path — it is not
a bypass.

**Map-label-is-an-activity flag:** when a label on the map/facility list matches an existing
*activity* name, that is a **flag for a human to resolve**, never an auto-created location. Identity
matching is always scoped to entity type (a location label must never silently become, or match, an
activity). Surface it as a reviewable question, not an automatic action.

## 8. Explicit boundary: NO GIS, NO spatial/route optimization

Hard boundary: **no GIS, no spatial or route optimization, no coordinates, no walking-distance
computation.** "Map-assisted" means *catalog proposal from a facility/map source that a human
confirms* — it does not mean geometry, pathing, or travel-time-aware scheduling. Any such request is
out of scope and becomes a ticket, not scope creep.

## 9. Decision summary

- Location contention already exists in the engine (string-keyed); first-classing is mostly
  onboarding. **[established]**
- Soft-migrate: `activity_locations` entity + nullable `activities.location_id` + retained
  `location TEXT` fallback. **[recommended, high confidence]**
- Re-key `locationKey` string → entity id: **deferred to the engine slice (S3).**
- `is_outdoor` stays a separate boolean; not absorbed. **[required]**
- Activity↔Location = preferred/allowed/default. **[modeling target]**
- Availability calendar: separate, optional, not requested. **[set aside]**
- Map-assisted setup = reviewable catalog proposal; map-label-matching-an-activity = human flag.
- No GIS / no route optimization. **[hard boundary]**
- Define shape now, defer engine enforcement; UI must label captured-not-enforced data honestly.
