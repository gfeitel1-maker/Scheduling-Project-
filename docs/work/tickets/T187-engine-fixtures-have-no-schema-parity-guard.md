---
title: "Engine fixtures have no schema-parity guard, so the T62 defect class can return silently"
document_type: ticket
status: open
created: 2026-09-16
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "None (base-independent). Related prior art: electron/ops/projectionsCoverage.test.js and electron/ops/undoReferences.schemaParity.test.js, both of which guard the electron/ SQL boundary."
archive_when: "a parity guard under src/engine/ asserts that anchor/slot fixture key sets are subsets of the real PRAGMA table_info columns for anchor_activities and template_slots, the guard has a non-vacuity floor, it has been proven to catch a defect it was not designed for, and `npm run verify` is green"
---

# T187 — Engine fixtures have no schema-parity guard

## Confirmed problem (verified against code at 8014932)
T62 (#443) fixed a defect where the engine read `anchor.activity_id` — a column `anchor_activities`
**never had**. It stayed green for a month because the test fixture hand-built the column. The engine
double-booked Lunch and Rest Hour in production the whole time.

The audit confirms **no live instance of this class exists today.** Ground truth was taken by running
`initSchema` on an in-memory DB and dumping `PRAGMA table_info` for all 48 tables (schema.sql
self-documents as base-only, so it is not ground truth on its own):

- `anchor_activities` columns are exactly `id, camp_id, cohort_id, day_id, time_block_id, name,
  unit_id, span_blocks, is_all_groups, group_ids, notes, schedule_week_id, recurrence_level,
  location_id, kind, unit_ids` — **no `activity_id`**.
- Every non-interpolated SQL literal across 288 non-test files `prepare()`d: **zero phantom columns**.
- 2,481 statements across 312 test files checked: every failure is a migration test deliberately
  constructing an older shape. **No test inserts a phantom column into a current table.**
- All 28 entities in `electron/ops/projections.js` diffed against real columns: **0 phantom fields**.

## The gap: the guards are all on the wrong side of the seam
`grep -rn "PRAGMA table_info" src/ electron/ test/ scripts/` → 8 files, **zero under `src/`**.

All three real parity guards sit on the `electron/` SQL boundary. But `src/engine/buildSchedule.js`
is a **pure function** whose anchor and slot fixtures are JS object literals that never touch SQLite.
**That is exactly where T62 lived.** A future engine read of `anchor.foo_id`, plus a fixture that
supplies `foo_id`, reproduces the silent month-long defect with nothing mechanical to catch it —
because the engine's tests never compare their fixtures to a real schema.

This is a **latent structural risk, not a present defect.** It is filed because the class is currently
clean and nothing prevents its return.

## Required work
Add a parity test under `src/engine/` asserting that the key sets used by anchor and slot fixtures are
**subsets** of the real columns from `PRAGMA table_info` for `anchor_activities` and `template_slots`.
`initSchema` is importable from `electron/db/localDb.js`, as the migration tests already do — the
engine stays pure; only the test reaches for the schema.

Follow the non-vacuity floor idiom in `electron/ops/projectionsCoverage.test.js`: the guard must fail
if it ever inspects zero fixtures, so that a refactor which moves fixtures cannot silently turn it off.

## Anti-vacuity requirement (standing rule — this is the point of the ticket)
A guard that catches only the defect it was designed for proves nothing. T184 found three gaps in a
scanner that already shipped with a non-vacuity test. Plant defects this guard was **not** designed
for, at minimum:
- a phantom column on `template_slots` (not `anchor_activities` — the one the author was thinking about);
- a fixture built by a **helper function** rather than an inline literal (T184's exact blind spot);
- a fixture key that is real on a *different* table (plausible-looking, wrong table).

Report honestly which of these the first implementation missed, rather than adjusting the guard until
all planted defects pass.

## Non-goals
- Do not make `src/engine/buildSchedule.js` itself import from `electron/` — engine purity is load-bearing
  (T69) and the ADRs depend on it. Only the **test** may reach for the schema.
- Do not attempt to remove `src/engine/anchorActivityLink.js:42`'s `activity_id` short-circuit. The audit
  confirmed it is correctly handled: `buildSchedule.test.js:47` and `weekCatalog.test.js:225` add
  explicit name-linked regression tests, and every legacy fixture carries a comment stating the column
  does not exist.
