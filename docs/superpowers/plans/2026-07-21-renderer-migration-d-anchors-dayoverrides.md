# Sub-plan D — Anchors + day overrides

Design: `docs/superpowers/specs/2026-07-21-renderer-supabase-migration-design.md`. Depends on Sub-plans A, B, C complete (`time_blocks`, `days_of_operation`, `tiers`, `groups`, `activities` all need to be locally populated by migrated screens for these two to have real data to read).

## Task 0 — Confirm exact schema for `day_override_templates`/`day_override_template_slots`

**Success predicate:** before writing any migration code, re-read `DayOverridesScreen.jsx` line-by-line and extract the EXACT field set used in every `.insert()`/`.update()` call for both tables (the design doc's schema sketch is explicitly marked as inference-only for these two — no source of truth exists anywhere in the repo, not even in `supabase/migrations/`). Produce a short confirmed schema note before Task 1 proceeds. This is not optional busywork — guessing wrong here means Task 1's migration is wrong and everything downstream in this sub-plan is built on a bad schema.
**Files:** none (research only, note in commit message or a short doc).

## Task 1 — AnchorsScreen.jsx

**Success predicate:** fully ported to `window.shoresh.list`/`write` against `anchor_activities`, `days_of_operation`, `time_blocks`, `tiers`, `groups` (all now populated by real local data via Sub-plans A-C). The per-day-of-week insert-loop business logic (one logical "anchor" fanning into multiple day-scoped rows, per the 2026-07-21 inventory) is preserved exactly — this is real scheduling business logic, not incidental Supabase plumbing, and must not be simplified or changed as a side effect of the migration.
**Not done if:** the fan-out-per-day insert logic is collapsed or altered in a way that changes how many rows get created per anchor — verify with a test that asserts the exact row count/shape for a multi-day anchor, not just "some rows got created."
**Files:** `src/screens/AnchorsScreen.jsx`.

## Task 2 — DayOverridesScreen.jsx

**Success predicate:** fully ported to `window.shoresh.list`/`write` against `time_blocks`, `activities`, and the two new tables from Task 0's confirmed schema. The delete-then-bulk-insert-child-rows pattern (parent `day_override_templates` row + its `day_override_template_slots` children) needs a transaction-safe equivalent — since this is NOT the same shape as Sub-plan A's `bulk_replace` primitive (that one is scoped to `template_slots` regeneration specifically), decide explicitly whether to reuse `bulk_replace` generically for this pattern too (extending its `entity` allowlist) or write a small dedicated multi-write helper; either is acceptable but the choice and reasoning must be stated in the Maker brief response, not left implicit.
**Depends on:** Task 0, Task 1 is not a hard dependency but should land first per the sub-plan's stated order.
**Files:** `src/screens/DayOverridesScreen.jsx`.

---

## Notes for the GOVERNOR loop operator

- Task 0 is unusually important for a "task" that produces no code — do not let the loop treat it as a formality or skip its own mini-review; a quick Maker-only pass with a sanity-check re-read is sufficient (Tester/Security/RedHat/Grader full cycle is probably overkill for a pure documentation-extraction task, but use judgment — if Task 0's output looks uncertain or incomplete, do run it through review rather than trusting a single pass).
- On completion of Tasks 1-2, proceed to Sub-plan E (`2026-07-21-renderer-migration-e-schedule-screen.md`) — the final and largest sub-plan.
