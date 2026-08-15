---
title: "ADR: Camp Locations become a first-class entity (schema v32)"
document_type: adr
status: accepted
authority: normative
implementation_state: in-progress
date: 2026-08-15
deciders: [product-owner]
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md, docs/adr/2026-08-02-schedule-weeks-first-class.md, docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-08-09-s1b-host-local-aliases.md, docs/adr/2026-08-10-ingestion-evidence-persistence.md, docs/adr/2026-08-08-s5-readiness-six-state-model.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md, docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md, docs/adr/2026-08-08-export-formula-injection-sanitizer.md, docs/adr/2026-08-08-t72-fixed-event-reimport-idempotency.md, docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md]
supersedes: []
affects: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md]
---

# ADR: Camp Locations become a first-class entity (schema v32)

**Status: ACCEPTED — approved by the product owner 2026-08-15; M1 in progress.** This ADR encodes
decisions the owner has already settled (recorded here, not reopened) plus three engineering
invariants (INV-1/2/3) that are not owner questions. The human gate is ADR approval. No production code is written this round. The
supporting evidence is the read-only architecture audit
`docs/work/specs/2026-08-15-camp-spatial-model-assessment.md`; section references below (§N) point
into it.

**Task class:** `architecture` + `database-sync`. Per `WORK_RECORD_STANDARD.md` §4 a task spanning two
classes is held to the **stricter combined gate list** of both; the frontmatter records `architecture`
as the scalar class. Red Hat is mandatory on every stored-shape/op-log/migration slice.

## Context

There is no location entity in Shoresh and there never has been. `activities.location` is a nullable
free-text `TEXT` column (`electron/db/schema.sql:267`), used by the schedule engine as a room key by
raw string equality (`buildSchedule.js:202`) and cosmetic everywhere else (§1). `"Pool"`, `"pool"`,
and `"Pool Deck"` are three unrelated places to this system, and nothing can tell a director that.

Two facts make this work well-timed (§0):

1. The repository already left a named, wired seam open for it: `location` is one of two
   `FORWARD_AREAS` in `src/engine/readiness.js:137-140`, with a label, a screen target, a readiness
   row, and a reconciliation chip — but its "Review" button is a dead end today (gap 14).
2. The free-text column carries a **live, director-visible scheduling defect**: because capacity is
   stored on the activity and checked per-activity against a shared per-place occupancy pool, the
   effective capacity of a place is a function of activity placement order, not of anything the
   director stated. A deterministic engine probe (§3.2) confirmed three distinct defects: (i)
   asymmetric order-dependent enforcement — three groups placed at a Pool one activity explicitly
   capped at one; (ii) a NULL cap silently means "unlimited," reachable on every migrated and
   imported camp; (iii) a `0` cap also means "unlimited." No test covers any of it.

This is a **create, not a correction**, and it **amends a standing ADR**: the most recent decision on
this exact question, `docs/adr/2026-08-10-ingestion-reconciliation-semantics.md` D7, deliberately
deferred a locations table. The owner has now decided to build it. This ADR records the amendment
(see "Amendment to D7" below) and encodes the settled design.

## Decision

### D1 — One `locations` entity, camp-scoped, named `locations` (Approach A)

A single camp-scoped `locations` table. A physical place and a schedulable location are the same
thing in a summer camp; the seasonal cases are handled by primitives the app already has (D3, D4) or
by re-pointing activities, not by a second entity. The divergent-ideation record and the rejected
alternatives are in "Candidates considered" below.

**Schema (v32), exactly as assessment §8.1:**

```sql
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,   -- how many GROUPS fit here at once
  notes TEXT,
  sort_order INTEGER,
  map_geometry TEXT,                     -- nullable JSON {x,y,w,h}, fractions 0..1; NULL = not placed on a map
  UNIQUE(camp_id, name)
);

ALTER TABLE activities ADD COLUMN location_id TEXT;   -- nullable, NO DB-level FK (matches weather_alternative_id)

CREATE TABLE IF NOT EXISTS week_location_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  location_id TEXT NOT NULL
);
```

`activities.location_id` is nullable with **no DB-level foreign key**, matching the
`weather_alternative_id` precedent (`schema.sql:277`). Indexes on ALTER-added columns go in
`localDb.js`, not `schema.sql` (`schema.sql:21-33`). DDL follows the v30/v31 both-places pattern: a
byte-identical exported constant in `localDb.js` plus the same text in `schema.sql`.

**Naming deviation from the D7 sketch — recorded per assessment §8.1.** D7 sketched the table as
`activity_locations`. This ADR names it `locations`. `activity_locations` reads as a join table
between activities and locations; the entity is a **place**, and places will later be referenced by
things that are not activities (fixed events, and eventually staffing). Naming the entity for its
first consumer would force a rename at the second. The name is `locations`.

### D2 — Capacity is a property of the place; the two questions are split

> **One column (`activities.max_groups_per_slot`) was trying to answer two different questions at one
> key. Split the questions; give each its own home and its own key.** (Assessment §8.2.)

- **"How many groups fit in this place at once?"** → **`locations.capacity`**, checked against the
  shared per-`(location, day, block)` occupancy pool. `NOT NULL DEFAULT 1` closes the NULL and `0`
  holes (defects (ii) and (iii)); the shared key makes enforcement independent of activity placement
  order (defect (i)).
- **"How many groups can do this activity at once?"** → **`activities.max_groups_per_slot`**, checked
  per-`(activity, day, block)` — exactly what `computeOverlaps.js:23` already does. It stays where it
  is; it is an instructor/equipment cap, not a place cap.

These are **not competing caps requiring a `min()`** — they are different constraints at different
keys, and the engine checks both. `activities.max_groups_per_slot` stops being dead when no location
is set (today it does nothing at all unless `act.location` is truthy).

`same_tier_only` **stays on `activities`** and continues to be evaluated against location occupants,
as today — it is the activity's own rule about whom it will share a space with. **Do not add a
location-level twin.** Two flags answering one question is the shape this ADR exists to remove. Known
wrinkle, recorded: `same_tier_only` is only meaningful during shared occupancy and is untested (gap 5);
M2's characterization tests must cover it.

### D3 — Availability is per-week, reusing the v28 exclusion primitive

`week_location_exclusions (id, week_id, location_id)` is the **third instance** of the v28
`week_*_exclusions` pattern (`week_activity_exclusions`, `week_group_exclusions`,
`schema.sql:550-561`, `projections.js:205-226`). "The lake is closed weeks 1 and 2" needs **no dates,
no calendar, no season entity, and no second location entity** — it is the vocabulary a director
already uses. The smallest unit of closure is a week; per-date closure is explicitly out of scope
(Q4, non-goal 7).

### D4 — Outdoor stays on the activity (no `locations.is_outdoor` in v32)

Per owner Q5, `is_outdoor` remains on `activities` where it drives Weather Mode's highlight
(`SlotCell.jsx:204-206`). v32 adds no `locations.is_outdoor`. Recorded ontological note: "outdoor" is
arguably a property of a place, and moving it later is a one-column nullable migration — this ADR
deliberately does not do that now.

### D5 — The frozen `activities.location` column is retained, never written after v32

`activities.location` is kept in `PROJECTIONS.activities.fields` and **stops being written** at v32.
Three load-bearing reasons (§9.3):

1. **Op-log replay must not break.** Historical ops carry `entity='activities', field='location'`.
   Removing the field from the projection allowlist would make `applyProjection` silently skip them
   (`projections.js:461`), so a full replay would reconstruct a *different* database than the one it
   replayed from — the worst outcome in this architecture.
2. **It is the rollback anchor** (§9.4 / "Rollback" below).
3. **It costs nothing.** A frozen column nothing *reads* is not a second source of truth; a column
   something *writes* would be.

**Enforcement (required), phased across M1 and M3 — clarified 2026-08-15 after Code Reviewer flagged
that the full freeze cannot land in M1.** The column cannot be globally frozen while the activity
form still writes free-text `location`; the picker that replaces that input is M3, not M1. So:
- **M1 lands:** the `schema.sql` header comment recording the column is frozen, **and** a test
  asserting the v32 migration/backfill path itself writes no `location` value and emits no `location`
  op. The migration path is genuinely frozen at M1.
- **M3 lands (pinned into M3's definition of done, see ticket table):** the app-wide test asserting
  **no** code path writes `activities.location`, once `ActivitiesScreen`'s free-text input is
  replaced by the `location_id` picker. Until M3, `ActivitiesScreen.jsx` and `ingest/fieldUpdate.js`
  still write `location` by design — the engine reads it until M2 re-points, so the column stays live,
  not frozen, on the write side through M2.

This phasing changes no product decision; it corrects an M1-vs-M3 scope overstatement in the original
draft. Recorded per rule 8 (Code Reviewer challenge accepted).

## Invariants — each is a normative MUST with a required test

These three are **engineering invariants, not product questions**. The owner is not asked about them.
They must be written into the design before any code (M1).

### INV-1 (blocks the ADR) — the backfill `locations.id` MUST be deterministic and device-identical

Each device runs its own local v32 migration. The backfill (§9.1) is a **DDL-time side effect that
emits no op**, exactly like v30/v31. Therefore the id it mints for each backfilled place must be
computed identically on every device from **replicated inputs only**.

- If `locations.id` were `randomUUID()` (the codebase's default instinct, `operations.js:100`) or
  `${deviceId}`-scoped (the only row-creating precedent, v26 at `localDb.js:1161`), an already-paired
  Host and its tablets would mint **different ids for the same "Pool."** A later `capacity`/rename/
  `week_location_exclusions` op targets the Host's id; on every other device it matches **zero rows**
  or spawns an **orphan**, and the capacity is silently unenforced everywhere but the Host — the exact
  double-booking defect this initiative exists to remove, now invisible.

**MUST:** `locations.id` is derived **only** from replicated inputs — `camp_id` + normalized `name` —
and the backfill **MUST emit no op**. `activities.location_id` is likewise set by the migration to the
derived id (a side effect, no op).

**Normalization for the id derivation — specified precisely.** The id key **MUST use `TRIM` only,
case-sensitive**, byte-for-byte identical to the dedupe key in §9.1. This consistency is mandatory:
dedupe is `TRIM`-only/case-sensitive, so `"Pool"` and `"pool"` remain two distinct rows. If the id
derivation folded case while dedupe did not, `"Pool"` and `"pool"` would collide into one id but two
dedupe rows — a contradiction. The id key and the dedupe key are the **same key**. (Recommended
concrete form for M1, not a new primitive: a deterministic hash such as
`location:${campId}:${trimmedName}`, mirroring the `schedule-week:${campId}:1` precedent in
`docs/adr/2026-08-02-schedule-weeks-first-class.md`. The exact string format is Maker's, but it MUST
be a pure function of `camp_id` and the `TRIM`-only, case-sensitive name.)

**Required guard:** a **two-db cross-device migration test** — construct two independent databases
with identical pre-v32 state, run the v32 migration on each independently, and assert the resulting
`locations.id` **and** `activities.location_id` are **byte-identical** across the two. This is the
single most important addition in this ADR.

### INV-2 (ADR note + M1) — restore MUST re-resolve `location_id` from the frozen `location` string

`location_id` is a migration side effect that exists **nowhere in the op log**. Restoring a pre-v32
activity from Trash re-emits `lastKnownFields` (`restore.js:84-96`), which carries the frozen
`location` string but **not** `location_id` — so a naive restore leaves `location_id` NULL and
**silently un-binds** the activity from its place.

Keeping the frozen column (D5) is necessary but **not sufficient**. **MUST:** the restore path
additionally **resolves the restored `location` string back to a `locations` row** (by the same
`TRIM`-only, case-sensitive key as INV-1/§9.1) and sets `location_id` accordingly; if no row matches,
`location_id` is left NULL and the string is preserved (the location was deleted — that is the
frozen-column-only state, which is coherent). Required test: restore a pre-v32 activity from Trash and
assert `location_id` is re-bound. (Assessment's own framing mislocated this via fresh-client
`full_sync`, which is a **snapshot** and never replays these ops — **restore** is the path that does.)

### INV-3 (ADR note + M1) — both new entities MUST enter `permissions.ENTITIES`; fix gap 16 first

`permissions.ENTITIES` (`electron/auth/permissions.js:15-29`) claims to be `DIRECT_CAMP_ENTITIES ∪
PARENT_SCOPED_ENTITIES` but no longer is: `schedule_weeks`, `week_activity_exclusions`, and
`week_group_exclusions` are **missing from it, silently making them admin-only**, with no drift test
(gap 16). The natural template to copy for `week_location_exclusions` — `week_activity_exclusions` —
is itself missing.

**MUST:** M1 adds **both** `locations` **and** `week_location_exclusions` to `permissions.ENTITIES`.
**Gap 16 SHOULD be fixed first**, as its own prerequisite ticket (below), so that the copied
`week_activity_exclusions` template is correct rather than reproducing the silent admin-only defect for
`week_location_exclusions`. Gap 16 is a **separate pre-existing defect**, out of scope for this
initiative's feature work but a prerequisite for M1's correctness.

## Registry checklist — all nine, ordered by failure mode (four fail silently)

Every one is required for M1 (row 9 is M4). Assessment §8.4.

| # | Registry | File | Failure if omitted |
|---|---|---|---|
| 1 | `PROJECTIONS` | `electron/ops/projections.js` | **Writes append to the op log and are silently discarded** (`:453-454`). Has cost real debugging time twice |
| 2 | `DIRECT_CAMP_ENTITIES` | `electron/ops/campScopedEntities.js:16` | `list()` throws `Unrecognized entity`; rows absent from first-pairing `full_sync` |
| 3 | `DOMAIN_SNAPSHOT_TABLES` + `DOMAIN_TABLE_COLUMNS` | `electron/sync/syncClient.js:32,52` | **First-pairing clients never receive the rows** (FK-safe order matters — `locations` before `week_location_exclusions`, and after `activities`/`schedule_weeks`) |
| 4 | `ENTITIES` | `electron/auth/permissions.js:15` | **Silently admin-only** — staff cannot read/write locations. Not caught by any test (INV-3, gap 16) |
| 5 | `RESTORE_DECISIONS` | `electron/ops/restore.js:18` | `restore.test.js:109` fails the build |
| 6 | `MOCK_WRITE_ALLOWLIST` + `UNIQUE_KEYS` | `src/localClient.mock.js:249,204` | `ipcSurfaceParity.test.js:280-315` fails; dev-mock diverges. **Hand-transcribed by design — do not import from `electron/`** |
| 7 | `PROJECTION_FIELD_EXCEPTIONS` | `electron/ops/projectionsCoverage.test.js:263` | The live-db column audit (`:784-837`) fails on any table column not in `fields` |
| 8 | `ENTITY_LABEL` | `src/screens/recordLabels.js:8` | Trash/history shows a raw table name |
| 9 | ingest registries (§4.4) | `ingest.js` / `extractEntities.js` / `confirmAlias.js` | Only needed when locations become ingestible (**M4**) |

Rows 1, 3, 4, and 9 (silent discard / clients never receive / silent admin-only / silent ingest
discard) are the **four silent-failure modes** — no test necessarily catches their absence, so M1 must
verify each positively. **Not required** (entity-generic): `setupCrudRepository` (entity is a call
argument), `preload.js`, `main.js` handler registration, the `operations`/`conflicts` schema, and the
drag write queue.

## Migration (v31 → v32) — loud, per owner Q1/Q2 ("fix and surface everything")

### Backfill (deterministic, one `db.transaction()`, gated `>= 31 && < 32`)

1. `SELECT DISTINCT TRIM(location) FROM activities WHERE location IS NOT NULL AND TRIM(location) <> ''`.
2. Insert one `locations` row per distinct trimmed value; `name` = the trimmed string; `id` derived
   per **INV-1** (`camp_id` + `TRIM`-only, case-sensitive name); `sort_order` by name.
3. **Seed capacity to the most permissive *declared* value:**
   `capacity = MAX(COALESCE(NULLIF(a.max_groups_per_slot, 0), 1))` over the activities that used that
   string — NULL and `0` read as `1`, never as today's accidental "unlimited." Default is `1`.
4. `UPDATE activities SET location_id = <derived id>` by `TRIM`-only match (INV-1 key).
5. Record, per location, whether its contributing activities **disagreed** about capacity.

**Dedupe is `TRIM`-only and case-sensitive. Do not case-fold, do not fuzzy-match, do not merge.**
`CONSTITUTION.md` Article V forbids silent merging of director-authored data by a migration the
director never saw.

### Review items — surfaced before any regeneration, three kinds

The migration writes no silent merges; it **surfaces** review items on the Locations screen (M3), in
the reconciliation program's existing reviewable shape:

- **(a) Capacity disagreements** — two activities at one place declared different numbers
  (*"Pool — Swim Lessons says 1 group, Free Swim says 3. How many fit at the Pool?"*). The migration
  keeps the permissive value so nothing gets tighter without consent, and asks (Q1).
- **(b) Effectively-unlimited-now-capped** (Red Hat, addendum) — a place whose contributing
  activities were **all-null caps** was effectively unlimited and is now capped at `1`. This case has
  **no disagreement**, so it would not raise flag (a) — it **needs its own flag**:
  *"the Pool had no stated limit and is now one group at a time."* (Q2.)
- **(c) Near-duplicate names** — `"Pool"`/`"pool"` (*"Pool and pool look like the same place. Merge
  them?"*) with an explicit, reversible merge action.

**The near-duplicate merge review MUST be impossible to miss and presented at/before first
regeneration — not dismissible chrome** (Red Hat, assessment addendum). Rationale: `TRIM`-only dedupe
leaves `"Pool"`/`"pool"` as two rows with independent capacity pools; post-migration `capacity`
becomes a *trusted, director-set* number the engine will **under-enforce across the split**. This is
not a regression (the engine string-keys today) but it is a trust problem once capacity is a real
number, so the merge review is a first-run gate, not a background suggestion.

### Fresh-vs-migrated equivalence — mandatory, and the column-order trap

v32 requires the fresh/migrated `PRAGMA table_info` equivalence pair plus idempotency twin, matching
the five existing precedents (`localDb.migrations.test.js`, `sourceAliases.migration.test.js:85`, etc.).

**Column-order decision (decided here, not left to Maker):** `activities.location_id` is ALTER-added,
so on a migrated database it lands **last** in `activities`' column order. `schema.sql`'s
`CREATE TABLE activities` **MUST place `location_id` last** so a fresh install matches a migrated one.
This is the same trap `operations.source` hit — it was deliberately kept in the same relative position
to avoid a fresh/migrated order mismatch (`schema.sql:148-164`). Placing `location_id` last in the
`CREATE TABLE` is the chosen resolution; the alternative (omit from `CREATE TABLE` entirely, add only
via ALTER, with recorded reasoning, per the `operations.source` precedent) is **not** taken here —
last-column placement is simpler and equally correct. `locations` and `week_location_exclusions` are
new tables created identically in both paths, so only `activities.location_id` carries the trap.

### Export round-trip moves with the schema (M4, subject to Q8)

`exportWorkbook.js:55` and its `_shoresh_meta` baseline emit the location **name** resolved via
`location_id`; `workbookToSource.js:99-155` resolves a name back to a row (creating inline as needed),
and the `<clear>` sentinel path (`workbookToSource.test.js:75-81`) keeps clearing the binding. All
string cells continue through `aoaToSanitizedSheet` — a location named `=cmd` is a real input already
covered by the shared sanitizer boundary
(`docs/adr/2026-08-08-export-formula-injection-sanitizer.md`).

## Sync

**There is exactly one sync architecture here and this adds nothing to it.**

### Location rows are ordinary replicated entities — NOT host-local

`locations` and `week_location_exclusions` are **ordinary camp-scoped replicated entities** (assessment
§10.1): field-level ops, `client_write_id` idempotency, genuine conflicts recorded in `conflicts` and
resolved explicitly. `week_location_exclusions` is the third instance of a shape that already works
twice, including its parent-keyed `ensureExists`.

**Nothing about locations is host-local.** The `source_aliases` host-local precedent
(`docs/adr/2026-08-09-s1b-host-local-aliases.md`) is justified by **one writer, one reader, one copy**
(import is host-only, admin-only). Locations have none of those properties — they are camp domain data
any authorized device may edit — so making them host-local would misapply that precedent.

### Geometry (deferred to M6) — one JSON field, one op per gesture, serialized per `location.id`

Geometry is camp domain data a headless CLI must read and write, so it is neither renderer-only nor a
serialized canvas blob, and it is **not** host-local. Two sub-decisions (assessment §10.2/§10.3):

- **One `map_geometry TEXT` field holding `{"x","y","w","h"}`, not four columns.** Ops are field-level;
  four columns would let two directors' independent per-field conflict resolutions yield a rectangle at
  one device's `x` and the other's `y` — **a box in a place neither director put it.** One JSON field
  makes the rectangle **atomic**: one op per gesture, a whole-rectangle conflict a director can
  actually reason about, landing in `conflicts` like everything else. Coordinates are **fractions of
  the background image (0..1)**, not pixels, so replacing the image at a different resolution does not
  move every box. JSON-in-a-column is established here (`template_slots.flags`, etc.), and the engine
  never reads geometry (T69 purity is unaffected).
- **One op on release, serialized per `location.id` via the shipped per-cell write-queue pattern.**
  Follow `docs/adr/2026-08-12-drag-live-write-serialization.md` exactly: no write during pointer-move
  (position is renderer state until the gesture ends); one write on release carrying a `gestureId`,
  chained through `claimAndRun` keyed by `location.id`. **Do NOT extract a shared abstraction** between
  the schedule grid and the map on the first pass — copy the pattern and cite the ADR
  (`ARCHITECTURE_STANDARD.md` §9). **Do NOT reintroduce a queue clear** — a clear-on-route-switch
  revision reopened the exact race it fixed (`useSlotMutations.js:99-118`).

**M6 Designer note (not a blocker):** the geometry conflict-resolution UI would render a raw JSON blob
(`{"x":…,"y":…}`) a director cannot reason about — the M6 Designer must render it as a positioned
rectangle, not raw text. Also: a `locations`/`location_id` snapshot is only coherent once the whole
fleet is on v32; staggered-update version skew silently drops the column on a v31 receiver (the
version-skew variant of the registry-#3 discard mode).

## Rollback (`electron/db/rollback/v32_down.js`, per assessment §9.4)

Following the `v30_down.js`/`v31_down.js` precedent:

1. `UPDATE activities SET location = (SELECT name FROM locations WHERE id = activities.location_id) WHERE location_id IS NOT NULL`
   — repopulate the frozen column from the entity, so **rollback is lossless for location names**,
   including names created or renamed after the upgrade.
2. Drop `week_location_exclusions`, `locations`, and `activities.location_id`.
3. Delete the v32 row from `schema_migrations`.

**Disclosed rollback losses:** per-location **capacity**, **geometry**, **week exclusions**, and any
**merge decisions**. Names survive; structure does not. This is inherent to rolling back a
structure-introducing migration and is stated here rather than discovered.

## Forward compatibility with the coming seasons container (stated, not designed)

The owner has decided Shoresh will gain a **season/year container** concept — a **separate future
program** under which every camp entity (groups, tiers, days, activities, time blocks, **and**
locations) becomes season-scoped via a **uniform** migration.

This ADR builds locations **camp-scoped now**. When the seasons program lands, it will scope locations
**identically to every other entity** — one uniform migration adds the season dimension across the
board — so building locations first **creates no rework**. Crucially, the one-entity model of D1 is
**confirmed under seasons, not threatened by it**: year-to-year change of use ("Room 201 is the arts
room this summer, the drama room next summer") lives at the **season-container level**, not in a
two-entity physical-vs-schedulable location split. The rejected two-entity Approach B (below) invented
a season concept to solve a locations problem; the actual season concept, when it arrives, arrives once
for the whole model.

**This ADR MUST NOT add `season_id` and MUST NOT design seasons.** It records only that the design is
forward-compatible with the coming container. Owner Q3 (does Shoresh know what a summer is) is the gate
for that separate program and is **not** a v32 question.

## Amendment to D7

This ADR **amends** `docs/adr/2026-08-10-ingestion-reconciliation-semantics.md` D7. D7 recorded *"No
`locations` table now… First-classing (`activity_locations` + nullable `location_id` soft-migrate) is
the prior program's slice S3 — deferred, not pulled forward."* The owner has now decided to build it.
D7's **deferral is lifted**; its **forward guidance is honored** (locations grow at
`source_aliases.entity_type` / `INGESTIBLE_ENTITIES`, M4). The table is named **`locations`**, not
`activity_locations` (D1). This is an amendment, not a supersession — D7's other decisions stand;
`affects` (not `supersedes`) records the edge.

## Candidates considered

Generated under five isolated `adhd` frames (regulator, hostile-competitor, inversion, one-hour-budget,
biology), scored and clustered into six angles (assessment §6). The recommended synthesis — reusing
`week_*_exclusions` for availability — was **not** produced by any frame; it came from repository
evidence (schema v27/v28) after divergence closed. Chosen and rejected, one line each with the killing
reason:

- **A — one `locations` entity, geometry optional on the row `[N4 V9 F9]` ★ CHOSEN.** A physical place
  and a schedulable location are one thing; "seasonal" is handled by other primitives (D3) or by
  re-pointing activities. Confirmed under the coming seasons container.
- **B — two entities: physical `places` vs. schedulable `location_seasons` `[N7 V5 F6]` — REJECTED.**
  Its whole justification is a **season concept the app does not have** (no `season`/`year` in
  `schema.sql`). It would require inventing a season entity that then applies to groups/tiers/
  activities/time-blocks too — a redesign of the time model to solve a locations problem, the exact
  premature generality `ARCHITECTURE_STANDARD.md` §9 forbids. The third entity B's regulator frame
  wanted ("claim") already exists as `template_slots`.
- **C — background image + structured overlays `[N5 V7 F7]` — FOLDED IN.** Not an alternative to A; it
  **is** A's map layer (M6). Its one adopted discipline: the dependency arrow runs one way — geometry
  points at locations, locations know nothing about geometry.
- **D — time-versioned locations (leases / `effective_from-to` / append-only fact log) `[N8 V3 F4]` —
  TRAP.** Date ranges are a **second time model** parallel to `schedule_weeks`; the fact log
  **re-implements the op log inside the domain**. Both forbidden.
- **E — no entity: controlled vocabulary or activity self-reference `[N6 V6 F3]` — TRAP.** Leaves
  capacity on the activity, so the live §3.2 defect survives — the one thing definitely broken today.
- **F — hierarchy `parent_location_id`, Upper/Lower as children `[N5 V8 F6]` — DEFERRED, not
  precluded.** Containment only earns its keep if the parent stays schedulable while children are
  (Q6). Adding a nullable `parent_location_id` later is a one-column migration, so choosing A precludes
  nothing.

## Consequences

- **Positive:** the live, order-dependent, silent capacity defect (§3.2) is fixed in M2; place identity
  becomes a real entity a CLI can address; the dead Readiness "Review" button (gap 14) is fixed; the
  `notInSource` bucket becomes a measurement rather than a permanent floor of 2 (M3); no parallel model
  and no second sync architecture is created; the security envelope is unchanged; the design is
  forward-compatible with the coming seasons container at zero rework.
- **Costs / risks:** M2 **changes generated schedules** for camps with NULL/0 caps (unlimited → 1) —
  disclosed to the director in plain words before regenerating (Q2), characterization-tests-first.
  Re-keying `computeOverlaps` by location makes OVERLAP fire on existing manual schedules where it
  never did (place-blind → place-aware). The v32 migration is the one non-additive structural change;
  its rollback is lossless for names only. INV-1 is a **silent cross-device hole** if missed — the
  two-db test is non-negotiable.
- **Explicitly NOT decided / NOT built here:** `parent_location_id` (Q6), `locations.is_outdoor` (Q5),
  any season/`season_id` (Q3, separate program), per-date availability (Q4), the background image's
  host-local storage (Q7, revisited at M6), and whether the parser proposes recognized room text as a
  reviewable location (Q8). Each deferred item is a nullable-column migration or a later slice away.

## Ticket decomposition

Dependency-ordered. Red Hat is mandatory on M1 and M6 (stored shape / op-log / migration / write path).

| Slice | Scope | Gate notes |
|---|---|---|
| **Gap 16 (prerequisite)** | Add `schedule_weeks`, `week_activity_exclusions`, `week_group_exclusions` to `permissions.ENTITIES`; add a drift test between `permissions.ENTITIES` and the entity registries. **Its own ticket**, landed before M1 so M1's copied template is correct (INV-3). | Separate pre-existing defect, not this initiative's feature work |
| **M1 — Create the entity** | Schema v32 (`locations`, `activities.location_id`, `week_location_exclusions`), deterministic backfill, `v32_down.js`, all nine registries, mock parity, **INV-1/INV-2/INV-3**. **No UI.** | Red Hat mandatory. Fresh-vs-migrated equivalence + idempotency twin. **Two-db cross-device migration test (INV-1).** Restore re-resolution test (INV-2). First-pairing `full_sync` integration scenario for the new tables |
| **M2 — Fix place capacity in the engine** | **Characterization tests FIRST** for the §3.2 cases (they do not exist today). Then: engine reads `locations.capacity` at the location key; `activities.max_groups_per_slot` checked per-activity; NULL/0 holes closed; `same_tier_only` exercised. **Re-key `computeOverlaps` by location** so the manual route stops being place-blind. | Test-first non-negotiable — changes generated output. Determinism preserved. Disclose behavior change (Q2) |
| **M3 — Locations setup screen** | 8th setup entity on `setupCrudRepository`. Name, capacity, notes. **Migration review items (a)/(b)/(c)** surfaced here, near-duplicate merge impossible to miss. Activities' location input becomes a picker (create-new inline). **Promote `location` out of `FORWARD_AREAS` into `OPTIONAL_AREAS` with a `COLLECTION_FOR` binding — never `REQUIRED_AREAS`.** Fixes dead Review button (gap 14). **D5 completion (pinned from M1): once the picker replaces the free-text input, add the app-wide test asserting no code path writes `activities.location`.** **M3 must not assume `location_migration_reviews` exists on every device** — it is populated only where the migration ran over real activity data (typically the Host); a device that paired into an already-v32 camp has an empty journal (Code Reviewer follow-up). **Decide whether a NULL-vs-declared-number reads as a capacity "disagreement" (kind a) or belongs with the "was unlimited" framing (kind b)** — the M1 journal currently records `[null,3]` as disagreement `[1,3]` (Code Reviewer follow-up). | Designer required. Verify whether `useCrudScreen` fits or repository-only is right (unproven for an 8th screen) |
| **M4 — Import/export round-trip** | Export emits location *name*; re-import resolves name → row. Locations join `INGESTIBLE_ENTITIES` + alias registries (§4.4) + `EVIDENCE_ENTITY_TYPES`. Parser stops silently discarding recognized room text, proposes it as a reviewable `observed` location — **subject to Q8**. | Do not redesign the ingestion UI. Reuse the fixed-event reviewable-unit pattern |
| **M5 — Week-scoped availability** | "The lake is closed weeks 1–2" via `week_location_exclusions`, using the existing week-exclusion UI shape. Engine honors it. | Small if M1 landed the table. **Subject to Q4** |
| **M6 — The optional map** | Background image (host-local, Q7), `map_geometry` as one JSON field, drag-to-position commit-on-release serialized per `location.id`. A camp with no map is unaffected in every respect. | Only after M1–M3. Red Hat on the write path, citing the drag ADR. Designer renders geometry conflicts as rectangles, not raw JSON |
| **Deferred, unscheduled** | `parent_location_id` (Q6); `is_outdoor` on the place (Q5); staffing; any season concept (Q3). | Each a nullable-column migration or separate program away |

## Product-owner decisions and remaining questions

**Q1–Q5 were answered by the owner on 2026-08-15 (recorded below, encoded in the Decision and
Migration sections above — not reopened). The only gate left on this ADR is ADR approval itself.**
Q6–Q8 remain genuinely open but do **not** gate M1 or change the M1 schema (assessment §13); they are
answered at the slice that needs them.

Answered (2026-08-15):

- **Q1 — Capacity disagreements found during migration → ASK / surface everything.** The migration
  keeps the permissive value and surfaces review items; the near-duplicate merge review is impossible
  to miss at/before first regeneration (Red Hat sharpening). Encoded in "Migration → Review items."
- **Q2 — Places with no stated capacity → FIX (default 1), disclosed.** No grandfathering; some
  generated weeks change and the app says so before regenerating. The all-null "was effectively
  unlimited, now capped at 1" case gets its own flag (b) (Red Hat sharpening). Encoded in D2 + Migration.
- **Q3 — Does Shoresh know what a summer is? → YES, as a season/year *container* — a separate future
  program, sequenced AFTER locations.** Not a v32 question. Confirms the one-entity model (D1); the
  design is forward-compatible at zero rework ("Forward compatibility" section).
- **Q4 — How precisely must "closed" be stated? → PER-WEEK.** Reuses the v28 exclusion primitive; no
  dates, no calendar. Encoded in D3; gates M5's behavior only.
- **Q5 — Is "outdoor" about the place or the activity? → STAYS ON THE ACTIVITY for v32.** Encoded in D4.

Remaining, non-gating (answered at the slice that needs them):

- **Q6 — When a field splits into Upper/Lower, does anything still happen on the whole field?** Gates
  whether `parent_location_id` is ever needed (deferred slice F). Needed before that slice, not M1.
- **Q7 — Is the map visible on staff tablets, or a director tool on the main computer?** Gates the M6
  background-image host-local-vs-synced decision.
- **Q8 — When an imported schedule prints room numbers, propose them for review or keep discarding
  them?** Gates M4's parser behavior.
