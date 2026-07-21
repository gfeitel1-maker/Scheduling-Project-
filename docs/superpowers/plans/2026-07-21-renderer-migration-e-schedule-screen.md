# Sub-plan E — ScheduleScreen (final sub-plan)

Design: `docs/superpowers/specs/2026-07-21-renderer-supabase-migration-design.md`. Depends on Sub-plans A, B, C, D complete. This is the largest, most complex file in the app (947 lines per CLAUDE.md) and the last piece of the renderer migration. Do not start this sub-plan until A-D have all passed.

Given the size, split into smaller tasks by concern rather than one monolithic Maker round (a single 947-line-file rewrite in one Maker round would violate this project's own established granularity of "one reviewable unit per round").

## Task 1 — Read path: template load (groups/days/timeblocks/activities/anchors/tiers/template_slots/overlays/snapshots-list)

**Success predicate:** all of ScheduleScreen's initial-load `Promise.all` reads (currently against `groups, days_of_operation, time_blocks, activities, anchor_activities, tiers, schedule_templates, template_slots, template_overlays`) plus the snapshots-list read are ported to `window.shoresh.list(...)` calls. No write logic touched yet. The screen should render its existing data correctly with zero behavior change from a user's perspective — this task is purely "read from a different source," success is verified by loading the schedule screen and confirming it shows the same shape of data it did against Supabase (modulo actually-empty local tables if this is a fresh local db with no prior Supabase-equivalent data — check with the operator/user what the actual comparison baseline is if ambiguous, don't guess).
**Files:** `src/screens/ScheduleScreen.jsx` (read-path sections only).

## Task 2 — Auto-create-template-if-missing + single-slot writes (move/swap/activity-assign)

**Success predicate:** the `schedule_templates` auto-create-if-missing pattern, and all single-slot mutations (`.update({activity_id, flags})`, slot moves/swaps, `.update({flags})` alone) are ported to `window.shoresh.write(...)` calls, field by field, per the established op-log convention. `activities.update({is_locked:true})` (the activity-locking feature) is also ported here — this is the point where Sub-plan C Task 5's temporary "two different is_locked paths" caveat resolves, since after this task both ActivitiesScreen and ScheduleScreen write `is_locked` through the same local table.
**Depends on:** Task 1.
**Files:** `src/screens/ScheduleScreen.jsx` (single-slot write sections), confirm `Sub-plan C Task 5`'s transition-window note can be closed out.

## Task 3 — Bulk regeneration + snapshot restore via `bulk_replace`

**Success predicate:** the 500-row-batch `template_slots` delete-then-reinsert pattern (on template creation, full regeneration, and snapshot restore) is ported to use the `bulk_replace` op primitive built in Sub-plan A Task 3 — NOT reimplemented as a new ad hoc bulk mechanism. `template_overlays`' own bulk delete/insert-on-restore is handled the same way (extend `bulk_replace`'s entity allowlist to cover `template_overlays` too, per the primitive's general design, rather than inventing a second bulk mechanism).
**Not done if:** this task reinvents bulk semantics instead of reusing Sub-plan A's primitive — that would mean Sub-plan A's adversarial review effort (idempotency, atomicity, replication testing) doesn't actually cover the code path that needed it most.
**Depends on:** Task 2, and Sub-plan A Task 3.
**Files:** `src/screens/ScheduleScreen.jsx` (regeneration/restore sections).

## Task 4 — Snapshot CRUD (create/rename/list) + overlay single-item CRUD

**Success predicate:** `schedule_snapshots` create/`.update({name, is_auto:false})`, and `template_overlays` single-item insert/delete/update (`to_block_order` reorder) are ported. Snapshot `slots`/`overlays` JSON blob storage uses the JSON-text-column approach from the design doc (explicitly scoped exception to field-level sync, not a precedent to reuse elsewhere).
**Depends on:** Task 3.
**Files:** `src/screens/ScheduleScreen.jsx` (snapshot/overlay CRUD sections).

## Task 5 — Final verification: full round-trip + live two-process check

**Success predicate:** design doc's testing-plan item 5 — after Task 4 passes, run a live two-Electron-process check (Host + a genuinely separate Client, matching this project's established practice for critical cross-process behavior) covering at minimum: build a schedule, regenerate it, create a manual snapshot, restore it, and confirm the Client sees the same final state as the Host after sync. This closes the whole migration's loop the same way the shared-signing-secret and fresh-client-login fixes were each live-verified before being considered done.
**Depends on:** Task 4.
**Files:** none new — verification task, may add a regression test to the suite if a gap is found during live verification (same pattern as prior live-verification passes in this project).

---

## Notes for the GOVERNOR loop operator

- Given this file's size and complexity (the "most complex file in the app" per CLAUDE.md, now confirmed as the most complex migration task too), expect more than 2 rounds on at least one of Tasks 1-4 — budget for it rather than treating a 3rd/4th round as unusual.
- On completion of all 5 tasks: this closes the entire renderer-Supabase-migration project. Re-run `docs/superpowers/plans/2026-07-21-phase1-architecture-cleanup.md`'s Task 1 (inventory) to confirm zero remaining active Supabase imports anywhere in `src/`/`electron/`, then proceed with that plan's Tasks 2-3 (move to `legacy/`, ban via lint) — this was the original blocker that started this whole migration project.
- Run `update-state` to refresh `PLATFORM_STATE.md` with the new schema/tables/IPC surface, and write a project-memory entry summarizing the full migration (all 5 sub-plans, pass/round counts, any new patterns) the same way the original 10-task rebuild's memory entry was maintained incrementally across sub-plans.
