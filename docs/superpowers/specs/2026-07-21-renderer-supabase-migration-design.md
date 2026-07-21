# Renderer Supabase→local-first migration — design

## Problem

The local-first rebuild (`docs/superpowers/plans/2026-07-19-local-first-desktop-architecture.md` + the users/camps sync sub-plan) fully replaced auth, session, and device-sync with Electron/SQLite/LAN-WebSocket. But it never touched the renderer's actual content screens. Confirmed by direct inventory (2026-07-21): 10 of 13 checked files still do live Supabase CRUD — `CampSetup`, `TimeBlocksScreen`, `DayOverridesScreen`, `DaysScreen`, `AnchorsScreen`, `ScheduleScreen`, `GroupsScreen`, `ActivitiesScreen`, `TiersScreen`, `CohortsScreen`, plus `ensureCohort.js`, `useCohorts.js`, `Sidebar.jsx`. Nine Supabase tables have zero local-schema equivalent (`cohorts`, `days_of_operation`, `time_blocks`, `anchor_activities`, `schedule_templates`, `template_overlays`, `schedule_snapshots`, `day_override_templates`, `day_override_template_slots`); three of those (`cohorts`, `day_override_templates`, `day_override_template_slots`) have no schema documented anywhere in the repo, only inferrable from JS call sites. `window.shoresh` has no generic read mechanism today, only `getCamp`/`listUsers`/`listPendingConflicts`.

This is a second rebuild, comparable in size to the original 10-task local-first architecture plan — not a cleanup task. User has explicitly approved treating it as its own project (2026-07-21) and made two binding architecture calls (below) precisely to avoid GOVERNOR hitting the same kind of contradiction that halted the original attempt to fold this into Phase 1's docs cleanup.

**Relationship to the paused hardening docs:** the original `docs/superpowers/plans/2026-07-21-phase1-architecture-cleanup.md` (moving `src/supabase.js` to `legacy/`) cannot proceed until every screen listed above no longer imports it. This migration is a hard prerequisite for that plan's Task 2. Phase 2 (authorization layer) is independent of this migration and can proceed in parallel or before/after — it touches `electron/main.js`/`electron/sync/syncServer.js` IPC/WS handlers, not renderer Supabase calls.

## Binding decisions (user-approved, 2026-07-21)

1. **Bulk replace gets a new op-log primitive.** Schedule regeneration/snapshot-restore's delete-all-then-reinsert-hundreds-of-rows pattern is represented as a dedicated bulk operation type in the sync/op-log system (not table-level full-sync, not thousands of per-field ops), so schedule data stays inside the same conflict-detection machinery as everything else in the app rather than falling back to last-write-wins. See "Bulk replace operation" below for the concrete shape.
2. **Clean cut per screen, no dual-write.** Each screen's migration task fully replaces its Supabase calls with `window.shoresh` IPC calls in one pass, tested only against the local SQLite db. No feature flag, no fallback path — consistent with this project's already-established "no migration path needed, clean-slate rebuild, no existing hosted-version customer data" stance (see project memory).

## Sequencing (five sub-plans, strict dependency order)

Modeled on the original rebuild's "main plan + sync sub-plan" structure — each sub-plan is its own file under `docs/superpowers/plans/`, executed via its own GOVERNOR task-by-task loop, in this order:

- **A — Foundation** (`2026-07-21-renderer-migration-a-foundation.md`): generic entity-read IPC, new/extended schema (all 9 missing tables + column additions to `tiers`/`activities`/`template_slots`), the bulk-replace op primitive in the sync layer. Nothing renderer-visible changes yet. Everything else depends on this.
- **B — Cohorts + trivial screens** (`...-b-cohorts-trivial.md`): `cohorts` is a foundational cross-screen dependency (feeds `tier`/`time_block`/`anchor_activity` writes) so it goes first among renderer work. Bundled with the two genuinely trivial files (`Sidebar.jsx`, already satisfiable by existing `getCamp()`).
- **C — Leaf CRUD screens** (`...-c-leaf-screens.md`): `GroupsScreen`, `DaysScreen`, `TimeBlocksScreen`, `TiersScreen`, `ActivitiesScreen`, `CampSetup` — straightforward CRUD once Foundation + Cohorts exist, no cross-dependencies on each other beyond what Foundation already provides.
- **D — Anchors + day overrides** (`...-d-anchors-dayoverrides.md`): `AnchorsScreen`, `DayOverridesScreen` — depend on `time_blocks`/`days_of_operation`/`activities`/`tiers`/`groups` all already existing locally (i.e., depend on C having landed), plus two undocumented tables needing fresh schema design.
- **E — Schedule screen** (`...-e-schedule-screen.md`): the largest, most complex file, depends on every other table existing locally and on the bulk-replace primitive from Foundation. Done last, deliberately.

Only after E completes does `docs/superpowers/plans/2026-07-21-phase1-architecture-cleanup.md` (moving/banning `src/supabase.js`) become executable — that plan's Task 1 should be re-run to confirm zero remaining active imports before Task 2 proceeds.

## Generic entity-read IPC

New `window.shoresh.list(entity)` (preload.js) → new IPC handler in `electron/main.js` → `SELECT * FROM <entity_table> WHERE camp_id = ?` (or unfiltered for camp-singleton tables). `entity` is a fixed allowlist of table names registered the same way `PROJECTIONS` already registers writable entities (electron/ops/projections.js) — do not accept an arbitrary client-supplied SQL identifier; validate against the allowlist before building any query (this is exactly the "validate type, not just presence, default-deny unrecognized" pattern already established for this project's IPC/WS boundary work). Returns plain row arrays, already reflecting current op-log-applied state (these tables are the *projected* current-state tables, not the log itself — reading them directly is correct and is exactly how `groups`/`tiers`/`activities` already work today).

## New/extended schema (schema_migrations version bump — exact version number is Foundation-task's Maker's job to pick correctly relative to whatever version is current at execution time, not hardcoded here)

New tables (columns are the minimum needed to satisfy current renderer usage, reverse-engineered from the 2026-07-21 inventory — Maker should re-verify exact fields against the live insert/update call sites in each screen file before finalizing, since the inventory flagged some fields as needing direct confirmation):

- `cohorts (id, camp_id, name, session_week_start, session_week_end, capacity_source, anchor_model, sort_order)`
- `days_of_operation (id, camp_id, label, day_of_week, sort_order)`
- `time_blocks (id, camp_id, cohort_id, name, start_time, end_time, part_of_day, sort_order)`
- `anchor_activities (id, camp_id, cohort_id, day_id, unit_id, span_blocks, is_all_groups, group_ids)`
- `schedule_templates (id, camp_id, name)`
- `template_overlays (id, template_id, unit_id, day_id, from_block_order, to_block_order, label)`
- `schedule_snapshots (id, template_id, name, is_auto, created_at, slots, overlays)` — `slots`/`overlays` stored as JSON text columns (SQLite has no native jsonb); this is a deliberate, narrow exception to the op-log model, scoped only to snapshot storage (a snapshot is an immutable point-in-time blob by design, not something field-level-synced) — do not generalize this pattern to any actively-edited table.
- `day_override_templates (id, camp_id, name, ...)` and `day_override_template_slots (id, day_override_template_id, ...)` — schema for these two is NOT fully knowable from this design doc; Sub-plan D's Maker brief must start with a direct re-read of `DayOverridesScreen.jsx`'s exact insert/update payloads (not just this doc's inference) before writing the `CREATE TABLE`.

Column additions to existing tables:
- `tiers`: add `sort_order INTEGER`, `cohort_id TEXT REFERENCES cohorts(id)`
- `activities`: add `priority INTEGER`, `is_locked INTEGER` (0/1), `span_blocks INTEGER`
- `template_slots`: add `flags TEXT` (JSON), `is_released INTEGER` (0/1), `is_span_head INTEGER` (0/1)

All camp-scoped new tables get a `camp_id` FK column and should follow the existing single-camp-per-db convention (no need for additional camp filtering logic beyond what already exists elsewhere, but don't omit the column — future multi-camp-per-db is explicitly out of scope, not a reason to skip normal FK hygiene now).

Apply the project's own established lesson here (see feedback memory on Maker/Resilience patterns for foundational schema work): this migration block needs schema versioning via the existing `schema_migrations` guard, wrapped in a transaction, with `PRAGMA table_info()` existence checks before each `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` — do not let Sub-plan A's Maker skip this because "it's just adding columns."

## Bulk replace operation (new sync primitive)

New operation shape distinct from today's field-level op: a `bulk_replace` operation carrying `{entity: 'template_slots', scope_id: templateId, rows: [...]}` (or similar — exact wire shape is Sub-plan A's Maker's job to finalize against the existing `operations` table schema, e.g. by serializing `rows` into the existing `value` TEXT column as JSON, with `entity_id` = `scope_id`). On apply (both host-side `handleSubmitOp` and any syncing client), a `bulk_replace` op deletes all current rows in-scope and inserts the new set, atomically (single SQLite transaction), then is recorded in the `operations` log exactly like any other op so it replicates and appears in conflict history the same way. This is a genuinely new mechanism, not a trivial reuse of `appendOp` — Sub-plan A must design it explicitly, test it for the same idempotency/replay properties every other op already has (retry-safe via `client_write_id`, exactly like existing ops), and Sub-plan E (ScheduleScreen) is the only consumer — do not let earlier sub-plans invent ad hoc alternatives to it.

## Out of scope for this whole migration

- Multi-camp-per-database support — single-camp-per-db assumption stays.
- Any change to the auth/authorization work already planned separately (Phase 2, `2026-07-21-phase2-authorization-layer.md`) — the new `list`/write paths added here should still ultimately be wrapped by `authorize()` once that lands, but this migration does not itself build the permission matrix; if Phase 2 lands first, Sub-plans B-E's Maker briefs should wrap new IPC handlers in the already-existing `authorize()` the same way other handlers are; if this migration lands first, Phase 2's own "audit every handler" step picks up these new ones automatically since it audits by reading the current `electron/main.js`, not a fixed list written before this migration existed.
- Realtime/live-push equivalents for these tables (confirmed zero `.channel()`/`postgres_changes` usage across all 13 files) — not needed, `onOpApplied` already exists for this purpose and these entities will get it "for free" once routed through the op-log/bulk-replace mechanism.

## Testing plan (applies across all sub-plans; each sub-plan's own plan doc adds specifics)

1. Every new/extended table has schema-migration tests (version bump idempotent, column-existence-checked, transaction-wrapped) — same pattern as the existing `signing_secret` migration (schema v9).
2. Every new IPC read/write path has a test proving a malformed/unrecognized `entity` argument is rejected, not silently querying an arbitrary table name.
3. Each migrated screen gets an integration test (or the closest existing equivalent — check what test coverage, if any, currently exists for these screens before assuming there's a baseline to preserve) proving it round-trips through `window.shoresh` correctly against a real local SQLite db, not a mocked Supabase client.
4. The `bulk_replace` op gets its own dedicated test suite in Sub-plan A: idempotent retry (same `client_write_id` doesn't double-apply), atomicity (a mid-transaction failure leaves the original rows untouched, not half-replaced), and replication (a bulk_replace op applied on the Host syncs correctly to a Client).
5. After Sub-plan E completes, live two-Electron-process re-verification of at least one full schedule-build-and-regenerate cycle, matching this project's established practice of confirming critical cross-process behavior live, not just via the same-process Vitest harness.
