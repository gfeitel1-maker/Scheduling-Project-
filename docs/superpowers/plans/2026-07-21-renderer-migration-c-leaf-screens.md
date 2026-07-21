# Sub-plan C — Leaf CRUD screens

Design: `docs/superpowers/specs/2026-07-21-renderer-supabase-migration-design.md`. Depends on Sub-plans A and B complete. Clean-cut migration per file, full GOVERNOR review per task, Tester's UX/Visual dimensions genuinely apply for every task here (all touch real screens).

Each task: replace the file's Supabase `.select()`/`.insert()`/`.update()`/`.delete()` calls with `window.shoresh.list(entity)` for reads and `window.shoresh.write(...)` for writes (remember: the op-log is field-level — a Supabase multi-field `.insert({name, tier_id, availability})` becomes one `write()` call per field for the new `entity_id`, or a small local helper that fires several `write()` calls in sequence and surfaces the first failure per the existing project convention of checking `result.status !== 'applied'` and treating anything else as a hard failure, not a silent partial success — see project memory on the `createUser`-partial-write lesson).

## Task 1 — GroupsScreen.jsx

**Success predicate:** fully ported. Both backing tables (`groups`, `tiers`) already exist locally (`tiers.sort_order` gap already closed by Sub-plan A Task 1). Verify sort-by-name and sort-by-`sort_order` behavior is preserved.
**Files:** `src/screens/GroupsScreen.jsx`.

## Task 2 — DaysScreen.jsx

**Success predicate:** fully ported to the new `days_of_operation` table (Sub-plan A Task 1). Bulk-clear-by-camp_id and reorder/bulk-insert behavior preserved.
**Files:** `src/screens/DaysScreen.jsx`.

## Task 3 — TimeBlocksScreen.jsx

**Success predicate:** fully ported to the new `time_blocks` table. Note this table has a `cohort_id` column — confirm the screen correctly scopes reads/writes to the currently-active cohort (via `useCohorts`, already migrated in Sub-plan B) rather than reading all cohorts' time blocks.
**Depends on:** Sub-plan B Task 2 (`useCohorts`).
**Files:** `src/screens/TimeBlocksScreen.jsx`.

## Task 4 — TiersScreen.jsx

**Success predicate:** fully ported. `tiers.sort_order`/`tiers.cohort_id` columns already exist (Sub-plan A). Confirm cohort-scoping same as Task 3.
**Depends on:** Sub-plan B Task 2.
**Files:** `src/screens/TiersScreen.jsx`.

## Task 5 — ActivitiesScreen.jsx

**Success predicate:** fully ported. `activities.priority/is_locked/span_blocks` columns already exist (Sub-plan A). **Cross-file consistency check required:** `ScheduleScreen.jsx` (not migrated until Sub-plan E) still directly calls Supabase to flip `activities.is_locked` (line ~253 per the 2026-07-21 inventory) — until Sub-plan E lands, `ScheduleScreen` and this newly-migrated `ActivitiesScreen` will be writing `is_locked` through two different paths (Supabase vs local SQLite) to what are now two different tables entirely (Supabase's `activities` table vs local SQLite's). This is a real, temporary inconsistency window inherent to doing a clean-cut migration screen-by-screen rather than atomically — the Maker brief must make this explicit and the Grader must not treat it as a Task 5 defect; it resolves itself once Sub-plan E completes. Document this transition-window caveat directly in this task's commit message so it isn't mistaken for a regression later.
**Files:** `src/screens/ActivitiesScreen.jsx`.

## Task 6 — CampSetup.jsx

**Success predicate:** fully ported, including the "count rows per table" onboarding-progress check across `tiers, groups, time_blocks, activities, anchor_activities` — the last one (`anchor_activities`) exists as a table (Sub-plan A) but isn't populated by a migrated screen until Sub-plan D; this task should still count it correctly (it'll just always read 0 until Sub-plan D lands), not skip it.
**Depends on:** Sub-plan A (needs `anchor_activities` table to exist even though nothing populates it yet).
**Files:** `src/screens/CampSetup.jsx`.

---

## Notes for the GOVERNOR loop operator

- Tasks 1-6 have no dependencies on each other (only on A/B) — they can be parallelized across separate Maker rounds if the operator wants to save wall-clock time, but each still gets its own full Tester+Security+Red Hat+Grader cycle; don't merge multiple screens into one task to save review overhead.
- On completion of all 6 tasks, proceed to Sub-plan D (`2026-07-21-renderer-migration-d-anchors-dayoverrides.md`).
