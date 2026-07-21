# Sub-plan A — Foundation

Design: `docs/superpowers/specs/2026-07-21-renderer-supabase-migration-design.md`. Nothing renderer-visible changes in this sub-plan — it is pure infra, same "zero product-behavior risk except where explicitly noted" caveat does NOT apply here (this touches the sync protocol and schema migration machinery, which is exactly the class of change this project's memory says reliably fails Resilience on round 1 — brief Maker proactively per that lesson: schema versioning hook, transaction-wrapped migration, WAL/busy_timeout already established, don't skip existence checks).

Full Tester+Security+Red Hat every round. Tester's UX dimensions N/A (no UI yet).

## Task 1 — Schema migration: new tables + column additions

**Success predicate:** `electron/db/schema.sql` and the version-gated migration block in `electron/db/localDb.js` add all 9 new tables and all 3 sets of column additions listed in the design doc's "New/extended schema" section, guarded by the existing `schema_migrations` version-check pattern, wrapped in a transaction, with `PRAGMA table_info()` existence checks before each ALTER. A fresh db gets the full new schema via `schema.sql` directly; an existing db gets it via the migration block; both produce an identical final schema (test this equivalence directly, don't assume it).
**Not done if:** any new *top-level* table lacks a `camp_id` FK column, or the migration isn't wrapped in a transaction. **Correction (post round-1 review, landed):** 3 of the 9 tables — `template_overlays`, `schedule_snapshots`, `day_override_template_slots` — are parent-scoped by design (via `template_id`/`day_override_template_id`), matching the existing `template_slots` precedent (no `camp_id`, only `template_id`). This is correct per the design doc's own authoritative per-table column list, not a defect. Task 2's brief must special-case these 3 tables.
**Files:** `electron/db/schema.sql`, `electron/db/localDb.js`, `electron/db/localDb.migrations.test.js`. **Status: DONE, PASS (round 1, avg 4.0 — Security 5/5, Resilience 3/5, Test Coverage 4/5, UX/Visual N/A).**

## Task 2 — Generic entity-read IPC (`window.shoresh.list(entity)`)

**Success predicate:** new `list(entity)` in `preload.js` → new IPC handler in `main.js` that validates `entity` against a fixed allowlist (mirroring how `electron/ops/projections.js`'s `PROJECTIONS` registry already validates writable entities) before querying. For the 9 camp-scoped-directly tables (`groups, tiers, activities, template_slots, cohorts, days_of_operation, time_blocks, anchor_activities, schedule_templates, day_override_templates`) returns `SELECT * FROM <table> WHERE camp_id = ?` (using the single camp row's id). **For the 3 parent-scoped tables (`template_overlays`, `schedule_snapshots`, `day_override_template_slots`) do NOT filter by a literal `camp_id` column — it doesn't exist on these tables. Scope them via JOIN through their parent (`schedule_templates`/`day_override_templates`) to the camp, e.g. `SELECT t.* FROM template_overlays t JOIN schedule_templates st ON st.id = t.template_id WHERE st.camp_id = ?`.** This was flagged by Red Hat/Grader on Task 1's review round as a real cross-task contract note, not speculative — build it in from the start rather than discovering it via a Task 2 test failure. Malformed/unrecognized `entity` values are rejected, not silently used to build a query.
**Not done if:** `entity` is interpolated into SQL without allowlist validation (this would be a real SQL-injection-shaped bug even though it's IPC from the same app's own renderer, not a network boundary — Security should treat it with the same rigor as any other unvalidated-input-into-query case).
**Depends on:** Task 1 (needs the tables to exist to test against).
**Files:** `electron/preload.js`, `electron/main.js`, `electron/main.test.js`.

## Task 3 — Bulk-replace op-log primitive

**Success predicate:** a new `bulk_replace` operation type is handled by `handleSubmitOp` (host-side, `electron/sync/syncServer.js`) and by client-side op application (`electron/sync/syncClient.js`): applying one deletes all current rows for the given entity+scope_id and inserts the new row set, atomically, in one SQLite transaction; the op itself is recorded in `operations` (replicates like any other op); retried submission with the same `client_write_id` does not double-apply (same idempotency guarantee as every other op type). Tests per the design doc's testing-plan item 4: idempotent retry, atomicity-on-failure (original rows survive a mid-transaction error untouched), and cross-process replication (Host bulk-replace syncs correctly to a Client — same live-verification bar as prior sync fixes in this project, at minimum via the existing multi-actor Vitest harness, live two-process check deferred to Sub-plan E's final verification per the design doc).
**Not done if:** the operation is only tested same-process/happy-path — this is new sync-protocol surface and needs the same adversarial rigor Tasks 5/6 of the original rebuild needed (malformed/partial `rows` payload must not crash the handler; validate shape before touching the DB, wrap in try/catch as defense-in-depth, exactly per this project's established WS/IPC message-handling pattern).
**Depends on:** Task 1.
**Files:** `electron/sync/syncServer.js`, `electron/sync/syncClient.js`, `electron/ops/operations.js` (or wherever op-type dispatch lives — confirm exact location by reading the file), plus corresponding test files.

---

## Notes for the GOVERNOR loop operator

- This is the highest-risk sub-plan in the whole migration (new sync primitive + schema surface) — do not rush past a Resilience finding here the way earlier foundational tasks in this project's history initially did; budget for 2+ rounds on Task 3 as the norm, not the exception.
- On completion of all 3 tasks, proceed to Sub-plan B (`2026-07-21-renderer-migration-b-cohorts-trivial.md`).
