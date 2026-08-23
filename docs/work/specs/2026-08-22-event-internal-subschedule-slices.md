---
title: Event internal sub-schedule — implementation slices
document_type: spec
status: draft
created: 2026-08-22
archive_when: this slice ships (merged/deferred) or the parent ADR is superseded
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-event-internal-subschedule.md]
---

# Event internal sub-schedule — implementation slices

Implements `docs/adr/2026-08-22-event-internal-subschedule.md`. Mirrors the
`special_days` → `special_day_time_blocks`/`special_day_slots` pattern under
`events`, reusing the campwide grid's geometry primitives — **with one
owner-confirmed divergence: the grid's columns are the event's OWN editable
`event_groups`, not the camp's fixed `groups`.** `event_groups` are plain
column labels (name + sort_order) — no roster, no scoring, no membership.
No teams-with-scoring, rotation rules, stations, scoring, or program
narrative in this slice.

## Ground-truth first (do before Slice 2)
Re-verify against the live tree before writing anything — this spec's line
numbers are a snapshot from the design pass and will drift:
- `electron/db/localDb.js` — confirm `CURRENT_SCHEMA_VERSION` is still 40
  (next migration is v41) and that the v40 block (events overlay placement)
  is unchanged since the design pass.
- `electron/ops/campScopedEntities.js` — confirm `PARENT_SCOPED_ENTITIES`
  still has the `special_day_time_blocks`/`special_day_slots` two-child
  shape and `DOMAIN_SNAPSHOT_ORDER` still lists `'events'` with no children
  of its own yet.
- `electron/ops/operations.js` `BULK_REPLACE_ENTITIES` — confirm
  `special_day_slots` is still absent (the "no bulk path" precedent this
  spec relies on).
- **`event_groups` is a third parent-scoped child of `events`, distinct from
  the deferred teams-with-scoring object** — confirm the ADR's current §1
  (owner-updated 2026-08-22) still shows three tables
  (`event_time_blocks`/`event_groups`/`event_slots`) with
  `event_slots.event_group_id` referencing `event_groups`, not
  `event_slots.group_id` referencing camp `groups`, before starting Step 1.

## Slice 2 — `event_time_blocks` + `event_groups` + `event_slots` + `EventGridEditor`

### Step 1 — Schema + migration (test-first)
- Write `electron/db/eventSubschedule.migration.test.js` (red first),
  mirroring `electron/db/specialDays.migration.test.js`: assert a pre-v41 db
  has no `event_time_blocks`/`event_groups`/`event_slots` tables; migrate;
  assert all three exist with the exact columns from the ADR §1 (`event_slots`
  has `event_group_id`, not `group_id`); assert the three DDL copies
  (schema.sql, `EVENT_TIME_BLOCKS_DDL`/`EVENT_GROUPS_DDL`/`EVENT_SLOTS_DDL`
  in localDb.js) are byte-identical for EACH of the three tables
  (string-compare the constants against the schema.sql excerpt, same
  technique `specialDays.migration.test.js` uses for its own triplication
  check); assert a migrated existing event starts with zero time blocks,
  zero groups, and zero slots.
- Implement: add all three `CREATE TABLE` statements to
  `electron/db/schema.sql` (immediately after the `events` table,
  cross-referencing this ADR); add `EVENT_TIME_BLOCKS_DDL`/`EVENT_GROUPS_DDL`/
  `EVENT_SLOTS_DDL` constants to `electron/db/localDb.js` alongside
  `EVENTS_DDL`; add the v41 migration block
  (`getSchemaVersion(db) >= 40 && getSchemaVersion(db) < 41`), executing all
  three DDL statements inside the transaction; bump `CURRENT_SCHEMA_VERSION`
  to 41; write `electron/db/rollback/v41_down.js` mirroring `v34_down.js`'s
  shape — drop `event_slots` FIRST (it FKs both axis tables), then
  `event_time_blocks` and `event_groups` (order between these two doesn't
  matter), standard data-loss warning, no un-drifting since none of the
  three is an ALTER.
- **Success:** migration test green; a fresh install and a v40→v41 migrated
  install produce identical `PRAGMA table_info` for all three new tables.

### Step 2 — Registration (the six-file checklist, now three children not two)
Work through the ADR §3 table one row at a time; existing parity tests
should catch any miss without new tests needing to be written for most of
them:
- `electron/ops/campScopedEntities.js`: add `event_time_blocks`,
  `event_groups`, AND `event_slots` to `PARENT_SCOPED_ENTITIES` (parent
  `events`, key `event_id` for all three) and to `DOMAIN_SNAPSHOT_ORDER` —
  `event_time_blocks` and `event_groups` positioned after `'events'` (either
  order), `event_slots` positioned AFTER both (it FKs `event_groups.id` and,
  via `time_block_id`, `event_time_blocks.id`, both NOT NULL under
  `foreign_keys=ON`).
- `electron/ops/projections.js`: add `PROJECTIONS.event_time_blocks`
  (two-field `ensureExists`, mirrors `special_day_time_blocks`),
  `PROJECTIONS.event_groups` (the IDENTICAL simple two-field `ensureExists`
  shape — it's structurally just a second `event_time_blocks`, not the slots
  table), and `PROJECTIONS.event_slots` (three-NOT-NULL reconstruction,
  mirrors `special_day_slots` with `event_group_id` replacing `group_id` as
  the second required column — port the `readField` op-log-replay helper
  exactly, don't simplify it).
- `electron/auth/permissions.js`: add `'event_time_blocks'`,
  `'event_groups'`, `'event_slots'` to `ENTITIES`. Run
  `permissionsEntityParity.test.js` — it should fail red before this change
  (new parent-scoped entities not yet listed) and pass green after, without
  any test-file edits (that's what the parity test is for).
- `src/localClient.mock.js`: add three field-array entries —
  `event_time_blocks: ['event_id', 'name', 'sort_order', 'start_time', 'end_time']`,
  `event_groups: ['event_id', 'name', 'sort_order']`,
  `event_slots: ['event_id', 'event_group_id', 'time_block_id', 'activity_id', 'location_id']`
  — and extend the delete-cascade helper for `deleteEvent` to remove
  `event_slots` first, then `event_time_blocks` AND `event_groups`, even
  though nothing calls it yet (see Step 3).
- `electron/ops/undoReferences.js`: add the `event_slots` soft-reference
  entries — `event_group_id`→`event_groups` (NOT `groups` — this is the
  column that changed target), `activity_id`→`activities`,
  `location_id`→`locations`, all `enforced: false`. Check whether this
  file's existing pattern also records the three ordinary parent-links
  (`event_time_blocks`/`event_groups`/`event_slots` → `events`, all real SQL
  FKs) — mirror whatever `special_day_time_blocks`/`special_day_slots` →
  `special_days` actually does here (or doesn't) before adding new entries.
- `electron/ops/restore.js`: add the three refusal entries for
  `event_time_blocks`/`event_groups`/`event_slots`, text mirrored from the
  `special_day_time_blocks`/`special_day_slots` entries.
- Run `electron/ops/projectionsEntityParity.test.js` and
  `permissionsEntityParity.test.js` (both existing parity gates) — they
  should catch any entity present in one registry but missing from another.
- **Success:** both existing parity tests green; a new `event_slots`
  three-field reconstruction unit test (mirroring whatever `special_day_slots`'
  own reconstruction test looks like, e.g. in `projections.test.js` or a
  sibling) passes: writing `event_group_id` then `time_block_id` then
  `event_id` in that order creates the row only after the third write,
  regardless of arrival order; a companion `event_groups`
  add/rename/reorder unit test (mirroring `event_time_blocks`') passes.

### Step 3 — `deleteEvent.js` (built, unwired)
- Write `electron/ops/deleteEvent.js`, mirroring `electron/ops/deleteSpecialDay.js`,
  extended to three children: delete `event_slots` rows for the event
  first, then `event_time_blocks` AND `event_groups` rows (order between
  these two is unconstrained), in that order.
- **Success:** a unit test (mirroring however `deleteSpecialDay.js` is
  tested) confirms the ordering — `event_slots` before either axis table —
  and that no UI currently calls this function — it exists for registry/
  op-log parity, not for a Slice 2 delete affordance (`restore.js`'s
  existing `events: 'refused: no delete UI yet'` note stays accurate; Slice
  2 does not change it).

### Step 4 — `EventGridEditor.jsx` + `EventCell.jsx` (rows AND columns editable)
- New files under `src/screens/event/` (mirroring
  `src/screens/specialDay/`'s directory shape), copied structurally from
  `SpecialDayGridEditor.jsx`/`SpecialDayCell.jsx` with `special_day` renamed
  to `event` throughout, PLUS the one real addition beyond a straight
  mirror:
  - Row axis (`event_time_blocks`): verbatim port of
    `addBlock`/`renameBlock`/`moveBlock`/`removeBlock`
    (`SpecialDayGridEditor.jsx` L175-231), `event_id` replacing
    `special_day_id`.
  - **Column axis (`event_groups`) — new, `SpecialDayGridEditor.jsx` has no
    analogue**: an `addEventGroup`/`renameEventGroup`/`moveEventGroup`/
    `removeEventGroup` quartet, structurally identical to the row quartet
    (same `sort_order`-swap reorder, same "has filled cells?"
    `window.confirm` guard before remove), operating on `event_groups`
    instead of `event_time_blocks`. Column header rendering becomes an
    editable `EventGroupName` component (sibling to the existing row-side
    `BlockName`, L431-457) instead of `SpecialDayGridEditor.jsx`'s current
    plain `{g.name}` text (L349).
  - **First-entry seed**: when an event has zero `event_time_blocks` AND
    zero `event_groups`, seed both axes once from the camp's current
    `time_blocks`/`groups` (ordinary per-field `writeField` calls, not a
    special import path) — mirrors `special_days`' own "seed from camp
    time_blocks" UI convenience, extended to both axes since both are now
    editable. No re-seed / "reset to camp defaults" affordance after the
    one-time seed.
  - Cell placement writes `event_slots.activity_id`/`location_id` directly
    via a local `writeField` helper, keyed by `event_group_id` (not
    `group_id`) — never `placeActivityManual`, never bulk_replace — per ADR
    §3's table. Reuses `gridTracks`/`gridPlacement`/`cellLabel`/
    `scheduleGrid.css` unchanged.
- Wire `EventScreen.jsx`'s `EventDetail` to render a new "Internal schedule"
  section that opens `EventGridEditor` for the selected event (mirrors
  however `SpecialDaysScreen.jsx` opens `SpecialDayGridEditor` for a
  selected special day — check that call site before writing this one).
- **Success (Tester, as a non-technical director):** open an event from
  `EventScreen` with no internal schedule yet, confirm the camp's groups/
  time-blocks are offered as a starting point (seed), then diverge — rename
  a column, add a column that doesn't exist in the camp's groups, reorder
  both axes, remove one of each — place activities across the resulting
  grid, reload the app, confirm everything persisted including the custom
  columns; the Slice 1 campwide overlay placement for the same event is
  untouched by any of this (verify both facts coexist independently); no
  coming-soon controls anywhere on the new section; gate green
  (`npm run verify`).

## Non-goals / guardrails
- No event-scoped teams-with-scoring/roster/membership — **`event_groups`
  (plain editable column labels, name + sort_order only) ARE built in this
  slice.** What's deferred is a richer teams object (scoring, roster)
  layered on top of a grouping concept — `event_groups` deliberately stops
  short of that.
- No rotation rules / rotation engine — Slice 2 is a static, director-filled
  grid, same posture as `special_day_slots` (no solver, ever).
- No stations-with-materials, staff leads, or scoring fields on
  `event_slots`/`event_time_blocks`/`event_groups` — they carry exactly the
  name/sort_order/timing fields `special_day_slots`/`special_day_time_blocks`
  carry, nothing more.
- No `BULK_REPLACE_ENTITIES` entry for `event_groups` or `event_slots`
  (deliberate; see ADR §3's "one deliberate non-mirror").
- No event delete UI (the op-log machinery from Step 3 is unwired).
- No "reset to camp defaults" affordance — the camp-setup seed (Step 4) runs
  once at first entry; `event_groups`/`event_time_blocks` are independent of
  the camp's `groups`/`time_blocks` after that.
- No new coupling between this internal grid and the Slice 1 campwide
  overlay cell (`template_slots.event_id`) — they stay independent facts.
- No palette/token changes; Operate restraint, reusing the same grid CSS the
  campwide schedule and `SpecialDayGridEditor` already use.
