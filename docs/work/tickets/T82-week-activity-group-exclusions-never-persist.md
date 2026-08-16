---
title: T82-week-activity-group-exclusions-never-persist
document_type: ticket
status: completed
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
related_adrs: [docs/adr/2026-08-02-schedule-weeks-first-class.md, docs/adr/2026-08-03-multi-week-slices-2-3.md]
related_specs: []
related_runs: [docs/work/runs/2026-08-16-locations-m5-week-availability.md]
archive_when: "week_activity_exclusions and week_group_exclusions persist a freshly-created exclusion through the real appendOp→applyProjection path on real SQLite, proven by a real-DB test for each; the false-success signal is closed (a write that doesn't materialize its row no longer reports 'applied'); duplicateWeek/restore recovery paths work for these two tables; and the fix is merged with owner sign-off"
---

# T82 — Week activity/group exclusions never persist on real SQLite (shipped data-loss)

> **RESOLVED 2026-08-16 — completed before it became active work.** A concurrent session's **PR #73**
> (`314bae3` "fix(op-log): persist week activity/group exclusions (two NOT NULL columns)", merged to main
> `62cfa66`) fixed this exact bug the principled way: a shared `ensureWeekJoinRow(table, secondColumn)` in
> `electron/ops/projections.js` that reconstructs BOTH NOT NULL columns from the op-log and inserts the
> complete row once both are known (order-independent, replay-safe, no placeholder), plus the missing
> real-SQLite regression tests (`projections.test.js`, `duplicateWeek.test.js`). **M5 (this branch) then
> adopted the same helper for `week_location_exclusions`** on rebase, retiring its interim `''` placeholder
> and closing the `''`-orphan LOW in the same stroke — all three `week_*_exclusions` tables now share one
> correct mechanism. The acute data-loss is gone. Residual (minor, non-data-loss, NOT tracked here unless it
> recurs): `performWrite` still returns `applied` without checking `applyProjection`'s `.changes` — moot now
> that exclusions persist, but a latent general false-success signal if another projection ever silently
> no-ops. Supersedes chip `task_dfad43e9`.

**Severity: HIGH (silent data-loss, core feature, false-success feedback). WAS live on `main`; now fixed.**

## The bug (proven end-to-end on real better-sqlite3 by BOTH Red Hat and Code Reviewer during M5)

Creating a `week_activity_exclusions` or `week_group_exclusions` row through the real app never
materializes the row. In `electron/ops/projections.js`, each table's `ensureExists` seeds
`INSERT OR IGNORE INTO <table> (id, week_id) VALUES (?, ?)` — omitting the `NOT NULL` `activity_id`/
`group_id` column (`electron/db/schema.sql:563-573`, both `NOT NULL REFERENCES ...(id)`). SQLite's
implicit NULL for the omitted column violates NOT NULL, `INSERT OR IGNORE` **silently swallows** the
violation, so the row is never created; the follow-up per-field `UPDATE ... SET activity_id WHERE id`
(`applyProjection`, `projections.js:542-546`) then matches **zero rows**, also silently.

**False success is total:**
- `performWrite` (`electron/sync/syncClient.js:875-914`) returns `{status:'applied'}` on a successful
  op-log insert — it never checks whether `applyProjection`'s UPDATE matched a row; `applyProjection`
  doesn't check `.changes` either.
- Both field-ops DO land durably in `operations` and replicate to every peer — the op log looks complete.
- The renderer (`ActivitiesScreen.jsx handleToggleExclusion` ~:543) sets optimistic local state and only
  re-reads on `weekId` change/remount, so the checkbox stays checked with no row behind it.
- Concrete failure: director closes "Swim" for Week 3 → sees it checked, no error → Schedule screen's
  `useScheduleData` reloads exclusions from the DB (empty set) → Generate schedules Swim during the
  "closed" week anyway.
- `restore.js:39-40` documents the recovery paths as "rebuilt by toggling the exclusion UI or duplicating
  the week" — BOTH are broken by this same root cause (`duplicateWeek` copies via the same buggy op order;
  confirmed empirically it copies zero rows).

## Why it hid since inception (multi-week Slice 2)

No test in the suite drives these two entities through the real `appendOp`→`applyProjection` path on real
SQLite. Every existing test either (a) uses the mock (`ScheduleScreenExclusions.test.jsx` jsdom + mocked
localClient; `scheduleRepository.test.js` fake in-memory client — asserts the `write()` call, never
persistence), or (b) seeds rows via raw multi-column SQL (`ingest.test.js:609-611`), bypassing
`ensureExists` entirely. `projections.test.js` has zero cases for any `week_*_exclusions` table.

## Why M5's fix doesn't transfer

M5 fixed the identical defect for `week_location_exclusions` by seeding `location_id=''` — safe ONLY
because that column has **no FK** (M1's deliberate no-FK convention). `activity_id`/`group_id` are real FKs
to `activities`/`groups`, so `''` would violate the FK. The siblings need a different, principled fix.

## Success predicate

- Creating a `week_activity_exclusion` / `week_group_exclusion` via the real `scheduleRepository`
  toggle path persists the row on real SQLite; a real-DB test proves it for each (through
  `appendOp`→`applyProjection`, week_id-then-fk-id order — NOT raw SQL seeding).
- The false-success signal is closed: a field write whose row never materialized must not report
  `applied` (surface the constraint failure so the caller/UI knows), OR the seeding is fixed so the row
  always materializes. Architect chooses the mechanism.
- `duplicateWeek` and restore recover these exclusions correctly (real-DB tests).
- **Consider unifying:** a principled row-seeding fix (seed all NOT NULL columns / atomic create for
  multi-required-column tables) would fix all three `week_*_exclusions` tables and let M5's
  `week_location_exclusions` `''` hack be retired. Evaluate blast radius across every `ensureExists`
  entity before touching the shared mechanism — Red Hat mandatory.

## Gate notes

Architect required (core op/projection save-mechanism; the fix shape — per-table seed-all-columns vs.
a generic `applyProjection` change vs. surfacing the constraint failure — is an ADR-worthy decision with
blast radius across all `ensureExists` callers). Red Hat mandatory (stored shape / op-log / real-SQLite
persistence). The missing real-DB test coverage is itself part of the deliverable.
