# Sub-plan B — Cohorts + trivial screens

Design: `docs/superpowers/specs/2026-07-21-renderer-supabase-migration-design.md`. Depends on Sub-plan A complete (needs `cohorts` table + `window.shoresh.list`). This is the first sub-plan with renderer-visible changes — Tester's UX/Visual dimensions become genuinely applicable for Task 3 (CohortsScreen), N/A for Tasks 1-2.

Clean-cut migration per file (user-approved, no dual-write): each task fully replaces that file's Supabase calls with `window.shoresh` calls in one pass.

## Task 1 — Sidebar.jsx

**Success predicate:** `src/components/layout/Sidebar.jsx`'s `supabase.from('camps').select('name')...` is replaced with `window.shoresh.getCamp()` (already exists, already returns the full camp row including `name`). Zero remaining Supabase import in this file.
**Files:** `src/components/layout/Sidebar.jsx`.

## Task 2 — ensureCohort.js + useCohorts.js

**Success predicate:** `src/utils/ensureCohort.js`'s count-then-insert-default-cohort logic and `src/hooks/useCohorts.js`'s read-and-select-active-cohort logic are ported to use `window.shoresh.list('cohorts')` for reads and `window.shoresh.write(...)` for the ensure-default insert. Both files' existing call contracts (function signatures, return shapes, what `useCohorts` returns to its 4 consumer screens) are preserved exactly — this task must not change what B/C/D screens will later expect from these two files, since they're both load-bearing shared dependencies, not leaf UI.
**Not done if:** the `useCohorts` hook's return shape changes in any way that would require touching every consumer screen — that defeats the point of migrating the shared dependency first.
**Depends on:** Task 1's pattern isn't a hard dependency, but Sub-plan A's `cohorts` table + `list` IPC are.
**Files:** `src/utils/ensureCohort.js`, `src/hooks/useCohorts.js`, and their existing tests if any (check for `ensureCohort.test.js`/`useCohorts.test.js` — none confirmed to exist yet in the 2026-07-21 inventory, so this task should add them if genuinely new coverage, or confirm none exist and note that explicitly rather than silently skipping test-writing).

## Task 3 — CohortsScreen.jsx

**Success predicate:** `src/screens/CohortsScreen.jsx`'s select/insert/update/delete are fully ported to `window.shoresh.list('cohorts')` + `window.shoresh.write(...)`. Full Tester UX pass now applies — verify in the running app (`npm run electron:dev`) that creating, editing, and deleting a cohort works end-to-end against the local db, not just via unit tests.
**Depends on:** Task 2 (shares `cohorts` read logic conceptually, though this task ports the screen's own direct calls, not the hook).
**Files:** `src/screens/CohortsScreen.jsx`.

---

## Notes for the GOVERNOR loop operator

- Task 2 is the highest-leverage task in this sub-plan — every later sub-plan's screens (`TiersScreen`, `TimeBlocksScreen`, `AnchorsScreen`) call `useCohorts()`; if its contract changes here, that's a plan-doc-staleness risk for Sub-plans C/D exactly like this project's memory describes (patch downstream plan docs immediately if this happens, don't wait for those tasks' own Maker rounds to rediscover it).
- On completion, proceed to Sub-plan C (`2026-07-21-renderer-migration-c-leaf-screens.md`).
