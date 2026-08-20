---
title: 2026-08-20-special-days-data-shape-design
document_type: spec
status: active
created: 2026-08-20
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: the special_days data-shape slice is implemented and merged, and the author/ingest follow-on specs supersede this one for their concerns
related_tickets: [docs/work/tickets/T40-one-day-special-event-schedule.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
---

# Special Days — data-shape design (T40, slice 1 of a decomposed initiative)

## Context and scope

T40 asks for a **one-day special-event schedule** — a Maccabiah / color-war / trip / themed day,
built once and thrown away, scheduled differently enough that bending the weekly grid to hold it is
the wrong move.

**Owner decisions (2026-08-20 brainstorm) that scope this design:**

- The essential traits are: a **theme/name** and the ability to **run activities at a location**.
- The Maccabiah example's two exotic traits are **explicitly NOT required**: no re-dividing campers
  into throwaway *teams* (reuse the camp's existing **groups** as columns), and no naming a *person*
  per cell (cells hold an **activity**, optionally at a **location**).
- Structurally it is a **standalone single-day schedule** — "like a single day override, but its own
  full thing" — **not tied to a calendar date** (named/throwaway, not a dated entry), and it **can
  have its own time structure** (its own time blocks, not necessarily the camp's normal ones).
- The full feature (author + ingest) is a **decomposed initiative**. This spec covers **only the
  first piece: the data shape** (the entity family + its sync/permissions/migration). In-app
  **authoring UI** and **ingest** are separate follow-on specs built against this foundation and are
  **non-goals here**.

### Why a new entity (approach ①), not an extension

Three shapes were considered (T40 discovery, 2026-08-20):

- **① New `special_days` entity family (chosen).** Honest fit for "standalone single day with its own
  time." Keeps the throwaway time grid isolated from the camp's permanent `time_blocks`. Reuses
  `groups`/`activities`/`locations` by reference, so it is less new work than it looks. As an un-dated
  standalone object it **sidesteps** the plural-candidates ADR's "no canonical week" rule rather than
  competing with the two routes.
- **② Extend `day_override_templates`.** Conceptually "like a day override," but today's override
  slots have **no group/column axis and no own-time-blocks** — extending it means building this same
  new structure *inside* the override table. Mostly-new work wearing an old table's name. Rejected.
- **③ New `schedule_templates.kind = 'special'`.** The `kind` axis means *"how the week was
  produced"* (manual vs generated) — orthogonal to T40's axis, *"repeating week vs single event."* A
  special day is not a week and has its own time blocks, so this pollutes the two-route model and
  breaks the shared-time-blocks assumption the ADR relies on. Rejected.

The closest existing pattern to copy is `day_override_templates` + `day_override_template_slots`
(a camp-scoped parent with parent-scoped child slots), and `schedule_templates` + `template_slots`
(parent-scoped slots keyed by group + time block + activity). This design follows those patterns.

## Data model

Three new tables (schema **v34**). All are ordinary **op-log-synced, camp-scoped** entities (a
director authors them and they must replicate across the camp's devices) — the same trust model as
`groups`/`activities`/`day_override_templates`, **not** host-local.

### `special_days` (camp-scoped parent)

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | minted uuid |
| `camp_id` | TEXT NOT NULL | the one camp (single-camp-per-db) |
| `name` | TEXT NOT NULL | the theme/name — "Among Us", "Color War" |
| `sort_order` | INTEGER | ordering among a camp's special days |

`UNIQUE(camp_id, name)` — a camp's special days are distinguished by name (consistent with
`locations`/`groups` name-uniqueness). No date column — the object is not calendar-dated.

### `special_day_time_blocks` (parent-scoped child)

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | minted uuid |
| `special_day_id` | TEXT NOT NULL | → `special_days.id` |
| `name` | TEXT NOT NULL | the row label — "9:15", "Opening", "Team Meeting" |
| `sort_order` | INTEGER NOT NULL | vertical order of the day's grid |
| `start_time` | TEXT | optional (`"09:15"`), display-only |
| `end_time` | TEXT | optional |

**Every special day OWNS its time blocks** (approach (a), not a polymorphic "reuse camp time_blocks
vs own" flag). Rationale: it keeps `special_day_slots.time_block_id` a single, unambiguous FK into one
table, avoids a polymorphic reference, and the "same grid as the normal week" case is served by the
**author UI seeding** a special day's time blocks from the camp's `time_blocks` at creation — a UI
convenience, not a storage branch. (Decided against a `uses_camp_time_blocks` flag for exactly the
polymorphic-FK complexity it would add to every slot reader.)

### `special_day_slots` (parent-scoped child — the grid cells)

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | minted uuid |
| `special_day_id` | TEXT NOT NULL | → `special_days.id` |
| `group_id` | TEXT NOT NULL | **column** = an existing `groups.id` (reused, not a throwaway team) |
| `time_block_id` | TEXT NOT NULL | **row** = a `special_day_time_blocks.id` (this day's own grid) |
| `activity_id` | TEXT | cell content = an existing `activities.id`; **nullable** (empty cell) |
| `location_id` | TEXT | where it runs = an existing `locations.id`; **nullable** |

A cell is identified by `(special_day_id, group_id, time_block_id)`. No `is_span_head`/spanning in this
slice (a special day's blocks are its own; multi-block spanning is a later concern if wanted). No
person/staff column (owner: not required).

### Referential integrity and deletion

- `special_day_time_blocks` and `special_day_slots` are **parent-scoped by `special_day_id`** with no
  `camp_id` column — the same shape as `day_override_template_slots`/`template_slots`.
- Deleting a `special_days` row (throwaway semantics) must tombstone its time blocks and slots. This
  follows the op-log **delete** path the codebase already uses for parent+child sets; the slice adds a
  cascade helper mirroring how a template's slots are cleared, so no orphaned children remain.
- `group_id`/`activity_id`/`location_id` are references to **live** camp entities. If a referenced
  group/activity/location is later deleted, a special-day slot pointing at it is stale — handled the
  same soft way the weekly grid handles a deleted referenced entity (render resolves by id; a missing
  id renders empty), **not** a hard FK constraint (consistent with the app's op-log model where FK
  enforcement is by projection, not SQL FKs).

## Sync, projections, and permissions (the registration surface)

To make these real op-log entities they must be registered everywhere the existing camp entities are —
this is the bulk of the implementation and the Red-Hat-critical part (a table registered on one side
of sync but not the other silently drops rows — the T88 class of bug):

- **`electron/ops/projections.js`** — `PROJECTIONS` entries with `ensureExists` for all three tables
  (parent camp-scoped; children parent-scoped, following the `day_override_template_slots` entry).
- **`electron/ops/campScopedEntities.js`** — add all three to the camp-scoped set and to
  `DOMAIN_SNAPSHOT_ORDER` (full-sync manifest) in FK order (`special_days` →
  `special_day_time_blocks` → `special_day_slots`), so a first-pairing client receives them. The
  `assertDirectEntityParity` guard must stay green.
- **`electron/sync/catchup.js` / `syncClient.js`** — inherit from the single-sourced manifest (T88
  work) so send and apply sides can't drift; verify all three appear on both.
- **`electron/auth/permissions.js`** — add `special_days`, `special_day_time_blocks`,
  `special_day_slots` read/write to staff; delete/bulk_replace remain admin-only (matching every other
  entity).
- **`electron/db/localDb.js` + `electron/db/schema.sql`** — the v34 migration block (both places),
  plus a `electron/db/rollback/v34_down.js` (following the v30/v31 rollback precedent).
- **`src/localClient.js` + `src/localClient.mock.js`** — the mock must reproduce the same
  create/read/delete + `UNIQUE(camp_id, name)` behavior so the flow is exercisable at `localhost:5200`
  and in tests (the mock-parity gap has bitten before).

**Id derivation:** `special_days.id` is a minted uuid (interactive create, not a deterministic
backfill — so *no* `deriveLocationId`-style determinism, consistent with T81/T101's ruling that
interactive creates use random uuids to avoid the rename-recollide hazard). Children are minted uuids
too.

## Non-goals (explicitly out of this slice)

- **Author UI** — the screen where a director builds a special day (creates it, seeds/edits its time
  blocks, fills the groups×time grid, assigns locations). Its own follow-on spec.
- **Ingest** — parsing a Maccabiah-style file into a special day. Its own follow-on spec; note the
  T16 `" - "` split would mis-read person/room cells, which is a known ingest concern to design there.
- **Render / engine** — special days are **authored, never engine-generated**; the engine
  (`buildSchedule.js`) does not touch them. A view to display one is part of the author-UI follow-on.
- **Context wiring** — surfacing special days in the Roots "Context" census (the read-only inventory)
  is a small follow-on once the entity exists; not required for the data shape.
- **Multi-block spanning, per-cell staff/person, calendar dates** — owner-deferred / not required.

## Testing seams

- **Migration:** a v33→v34 migration test (mirroring `campMaps.migration.test.js`) — fresh-vs-migrated
  schema equivalence; the three tables exist at v34; `getSchemaVersion === 34`.
- **Projections:** `ensureExists` creates each row from a first field write; a create→read round-trip
  for parent + children.
- **Sync parity:** an integration scenario (mirroring `25-full-sync-manifest-week-location-exclusions`)
  proving a first-pairing client receives and applies `special_days` + its time blocks + slots.
- **Permissions:** staff can read/write, cannot delete/bulk_replace (IPC + WS paths).
- **Mock parity:** a drift test that the mock's special-days behavior matches the real path
  (`UNIQUE(camp_id, name)`, create/read/delete).

## Implementation note (governance)

This is architecturally significant (new entity, schema migration, cross-device sync registration).
The implementation goes through the full loop: **Maker (test-first) → Red Hat (migration + sync
registration completeness — the T88 drop-a-table-on-one-side class) → Security (permissions surface) →
Code Reviewer → Verifier → Grader.** This spec doubles as the ADR-level record of the ①-over-②③ entity
decision; a separate short ADR can be filed if the team prefers the decision live under `docs/adr/`.
