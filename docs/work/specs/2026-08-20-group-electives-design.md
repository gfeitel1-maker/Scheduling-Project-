---
title: 2026-08-20-group-electives-design
document_type: spec
status: active
created: 2026-08-20
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: the group-electives feature is implemented and merged across its slices, or superseded by an approved revision
related_tickets: [docs/work/tickets/T41-elective-scheduling.md]
---

# Group-level elective scheduling — design (T41)

## Context and owner decisions (2026-08-20 brainstorm)

An elective period runs several activities at once; a group is distributed across them. Today the app
can't express this — real camps flatten it to one opaque activity name ("Chugim", "Indoor Elective").

Owner decisions that scope this design:

- **Group-level, no campers.** The app records *which activities run in an elective period and that a
  group participates* — it does NOT model individual campers, their choices, or who-got-what. The app
  has no `campers` entity today, by deliberate design, and this feature does not add one.
- **No solver / no engine assignment.** The director decides; the app holds and displays it (same
  posture as the manual schedule route). The engine never assigns campers/groups to electives.
- **Reusable elective sets.** An elective is a **named set of activities** ("Afternoon Chugim" =
  {Swim, Art, Archery}) that a director drops into periods, reused across days/groups — matching how
  camps describe electives (Ⓐ over a per-slot ad-hoc list).

**Non-goals (deferred / not required):** campers as records, per-camper elective assignments/rosters,
choice/preference data, capacity-can-fail-per-camper handling, any solver, and the deferred
`camper_headcount` capacity work. If per-camper rosters are ever wanted, that is a separable follow-on
initiative with its own spec — this design leaves the door open but builds none of it.

## What "group-level elective" means concretely

A cell at `(group, day, time_block)` — today one activity — can instead hold an **elective set**: a
reference to a named `elective_sets` row whose members are the activity options offered that period.
The cell renders "Electives: Swim / Art / Archery" (or the set's name) instead of one flattened
activity. Capacity, where it matters, is per-member-activity via the existing `locations` entity — no
new capacity model. Both schedule routes (Manual / Generated) support elective cells; the **engine
skips** an elective cell (never auto-fills it), exactly as it already leaves anchor/pre-placed cells
alone.

## Data model (schema v35)

### `elective_sets` (camp-scoped parent, op-log-synced)

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | minted uuid |
| `camp_id` | TEXT NOT NULL | single-camp-per-db |
| `name` | TEXT NOT NULL | "Afternoon Chugim" |
| `sort_order` | INTEGER | ordering |

`UNIQUE(camp_id, name)`.

### `elective_set_activities` (parent-scoped join, op-log-synced)

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | minted uuid |
| `elective_set_id` | TEXT NOT NULL | → `elective_sets.id` |
| `activity_id` | TEXT NOT NULL | → `activities.id` (a member option) |

`UNIQUE(elective_set_id, activity_id)`. Parent-scoped, no `camp_id` (mirrors
`day_override_template_slots`/`special_day_time_blocks`).

### `template_slots.elective_set_id` (new nullable column)

A nullable `elective_set_id TEXT` on `template_slots`. **Cell interpretation:** a slot with
`elective_set_id` set is an **elective cell** (its `activity_id` is null/ignored; the cell renders the
set). A slot with `activity_id` set and `elective_set_id` null is an ordinary activity cell (unchanged).
The two are mutually exclusive at render time; the writer enforces it (setting one clears the other).
This keeps electives inside the existing slot/route/snapshot/sync machinery rather than a parallel grid
— an elective is a *kind of cell content*, not a new schedule object (contrast T40, which is a whole
separate day). Reference is soft (no SQL FK), resolved by id at render like every other slot reference.

## Engine behavior (correctness-critical)

`buildSchedule.js` must treat an elective cell as **pre-placed / do-not-fill** — the same handling
anchors already get (the `"groupId|dayId|blockId"` pre-placed lookup; T62 closed anchor
double-scheduling). Specifically: the placement pass must **exclude** `(group, day, block)`
coordinates that already carry an `elective_set_id`, so the engine neither overwrites an authored
elective cell nor counts it as an empty slot to fill. An elective cell is authored content, never
engine output. This is the highest-risk correctness point and gets an explicit engine test.

## Render and authoring

- **Render (`SlotCell` / the grid):** an elective cell shows the set — the set name and/or its member
  activity names — visually distinct from a single-activity cell, using existing tokens (no new
  design tokens; follow the schedule-canvas ADR — any new ephemeral cell state is a data-attribute +
  a `scheduleGrid.css` rule, not React state).
- **Authoring:** a director marks a cell as an elective by placing an **elective set** into it, the
  same interaction model as placing an activity (via the palette / drag-first placement, or a picker),
  on **both routes**. Placing an elective set writes `elective_set_id` (and clears `activity_id`);
  clearing/replacing behaves like any other cell edit (undo/redo, the per-cell write queue — reuse the
  T91/T99 span-aware `replaceSlot` machinery; an elective cell is not a span, so no span interaction).
- **Managing sets:** a small setup surface to create/edit elective sets (name + member activities) —
  ordinary setup CRUD, following the `setupCrudRepository`/existing setup-screen pattern.

## Sync, projections, permissions, migration (registration surface — the T88 class)

Mirror the T40 special_days slice exactly (Red Hat 5/5 there validated this list):

- `electron/db/schema.sql` + `electron/db/localDb.js` — v35 migration (both places; `CURRENT_SCHEMA_VERSION=35`),
  the two new tables **and** the `template_slots.elective_set_id` ADD COLUMN; `electron/db/rollback/v35_down.js`.
- `electron/ops/projections.js` — `elective_sets` (camp-scoped) + `elective_set_activities`
  (parent-scoped, two-NOT-NULL-column ensureExists like the week-exclusion join rows); `template_slots`'s
  projection already exists — extend its writable fields to include `elective_set_id`.
- `electron/ops/campScopedEntities.js` — add both new tables to the camp-scoped set + `DOMAIN_SNAPSHOT_ORDER`
  in FK order (`elective_sets` → `elective_set_activities`); keep `assertDirectEntityParity` green.
- `electron/sync/syncClient.js` — `DOMAIN_TABLE_COLUMNS` entries; `template_slots`' column list gains
  `elective_set_id`.
- `electron/auth/permissions.js` — both new entities: staff read/write; delete/bulk_replace admin-only.
- `electron/ops/undoReferences.js` — `elective_set_activities.activity_id` and
  `template_slots.elective_set_id` as reference edges (enforced:false); the schema-parity scanner covers them.
- `src/localClient.mock.js` — parity (UNIQUE keys, create/read/delete).
- Deleting an `elective_sets` row cascades its `elective_set_activities`; and any `template_slots`
  pointing at a deleted set render empty (soft, like any deleted reference) — a cascade primitive
  mirroring `deleteSpecialDay.js`.

## Decomposition into slices

1. **Data shape + engine-skip + registration (this slice's implementation).** The two tables +
   `template_slots.elective_set_id` + full sync/permissions/migration/rollback/mock registration + the
   engine exclusion of elective cells (with its test) + the delete cascade primitive. No UI yet — but
   unlike a pure-data slice, the **engine-skip correctness ships here** because it's the risky part and
   must be right before any authoring writes elective cells.
2. **Elective-sets setup CRUD** — create/edit/delete named sets + members (setup screen).
3. **Authoring + render** — place/clear an elective set in a cell on both routes; render the set in
   the grid.

Slices 2 and 3 are separate follow-on specs/PRs against this foundation.

## Testing seams (slice 1)

- **Migration v34→v35:** fresh-vs-migrated byte-identity; the two tables + the `elective_set_id`
  column exist; `getSchemaVersion===35`.
- **Projections:** round-trip for `elective_sets` + the join; `template_slots.elective_set_id` writes/reads.
- **Engine-skip (correctness):** `buildSchedule` with an elective cell present does NOT place an
  activity there and does NOT count it as an unfilled slot — mirror the anchor-skip test (T62).
- **Sync parity:** an integration scenario proving a first-pairing client receives elective sets +
  members + a slot's `elective_set_id` (mirror scenario 26).
- **Permissions:** staff r/w, admin-only delete/bulk_replace (IPC + WS).
- **Mock parity + registries** drift test (mirror `specialDaysRegistries.test.js`).

## Implementation note (governance)

Architecturally significant (schema migration, a core-slot-model column, cross-device sync,
engine-correctness). Full loop: **Maker (test-first) → Red Hat (migration + sync-registration
completeness + the engine-skip correctness) → Security (permissions) → Code Reviewer → Verifier →
Grader.** This spec doubles as the ADR-level record of the group-level / reusable-sets / no-solver
decisions.
