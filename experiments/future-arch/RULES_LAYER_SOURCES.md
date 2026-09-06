# The rules/validation layer above Automerge — scoping sources

**Why this file exists.** Automerge converges the *document*; it does not enforce *domain
invariants*. The op-log's single-writer ordering gave us invariants for free that a CRDT hands
back as our problem (delete-a-room + assign-to-that-room both merge cleanly → an activity pointing
at a room that no longer exists — a valid document, a wrong camp). So productionization needs an
explicit rules layer as a first-class stage, not a bolt-on. This captures the primary sources to
read before scoping it, so they survive session handoff.

## The load-bearing rule (read this first)
- `src/engine/buildSchedule.js:326-339` — a **null OR dangling `location_id` is treated as
  UNCONSTRAINED**. This is the line that makes orphaning *silent*: a broken reference doesn't
  error, it quietly removes a constraint (e.g. Flagpole stops being held at the flagpole). The
  single most important line to have in front of you when scoping the rules layer.

## Referential integrity is by CONVENTION, not enforced
- `location_id` on `anchor_activities`, `events`, `special_day_slots`, `event_slots` is
  **FK-by-convention with no database foreign key** — SQLite will not catch a dangling reference.
- `electron/ops/deleteRecord.js` — `locationReferenceRows` / `deleteOrMergeLocation`: the six
  referrer kinds, and which clear to NULL vs. row-delete on merge/delete (the #286 fix).

## Seven creation paths, two id schemes — the fan-out that makes this non-trivial
Per the "Life of a Location" lifecycle artifact (traced from merged code):
**seven creation paths with two different id schemes, only one of which ever learns a real
capacity.** Validating one write path is not enough — there are seven.
- `electron/ops/locationId.js` + `locationCreate.js` — identity is **trim-only and
  CASE-SENSITIVE by deliberate design** (Constitution Art. V accept-and-mark); includes
  rename-then-recollide handling.
- `src/ingest/textGrid.js:283,303,349-372` + `src/ingest/extractEntities.js:620-633` — the two
  places a location is *inferred* rather than declared.

## Schema note — dormant but NOT dead
- `electron/db/schema.sql:693-711` — the `locations` table, incl. `map_geometry` / `map_id`.
  These columns are dormant but a game-style map is being built against these same rows. **Do not
  clean them up** as part of productionization.

## Invariant catalogue the rules layer must hold (partial, from recent merged work)
- Referrer completeness on merge/delete — re-point/NULL all referrers (#286).
- Place capacity + contention, incl. anchors-constrain-but-are-never-flagged (#282, #290).
- The location approval gate — a declined room must not come into existence via ANY path (#283).
- Host-only never-replicate tables (see PRODUCTIONIZATION_AUDIT.md).
- Ingest's atomic all-or-nothing rollback (`electron/ops/ingest.js:1038-1042`).

## Projection repair is NOT moot — it changes source
- `docs/adr/2026-09-04-projection-failure-detection-and-recovery.md` + `projection_failures`
  table + `electron/ops/projectionRepair.js`: read as a design for **detect-and-repair
  materialization drift**, not op-log-specific machinery. Under Automerge,
  `repairProjectionForEntity` re-derives an entity *from the document* instead of *replaying its
  ops in seq order*. Portable mechanism, different source of truth.

_Source: coordination with session shoresh-54, 2026-09-06. Reconstructed from merged code, not
from prose docs._
