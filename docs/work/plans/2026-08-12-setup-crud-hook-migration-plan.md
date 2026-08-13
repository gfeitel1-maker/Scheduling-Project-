---
title: "Setup-CRUD shared persistence seam: migration plan"
document_type: plan
status: complete
created: 2026-08-12
governing_docs: [docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md]
---

# Setup-CRUD shared persistence seam: migration plan

**For agentic workers:** each task below is a self-contained, behavior-preserving unit of work: write characterization test(s) capturing CURRENT behavior first, run green against the unmigrated screen, then (for migration tasks) swap the screen's internals to use the new seam, re-run the SAME characterization tests green with zero edits to their assertions. Do not start a task until the previous one is committed. Tasks are ordered so the tree stays green after every commit.

**ADR:** `docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md` (read in full before starting — it decides the contract; this plan only sequences building it).

**Branch:** `work/setup-crud-hook`. **Base commit:** `a7ee973`.

## Goal

Five setup-CRUD screens (`GroupsScreen`, `TiersScreen`, `DaysScreen`, `TimeBlocksScreen`,
`ActivitiesScreen`) each hand-roll an identical write/delete/import orchestration. Replace the
duplicated logic with one shared repository (`setupCrudRepository`) + hook (`useCrudScreen`),
migrating one screen at a time, with the full existing test suite plus new characterization tests
green after every commit. Zero observable behavior change — same error copy, same collision
handling, same fresh-refetch-before-delete-all, same delete-confirmation UI per screen.

**Non-goals:** `DayOverridesScreen` (excluded — see ADR premise check). Any rendering
consolidation (table/row components) — out of scope per the ADR's rejected Candidate 1. Any
change to `electron/**`, `localClient.js`, or the op-log write path.

**Success predicate:** after all six tasks, `GroupsScreen`, `TiersScreen`, `DaysScreen`,
`TimeBlocksScreen`, and `ActivitiesScreen` each call `useCrudScreen`/`setupCrudRepository` for
their write/delete/import path instead of a locally-defined `writeFields`/`cleanupPartialRow`/
`deleteAll`/import loop, and `npm run test` is green with no assertions weakened or removed from
any of the five screens' test files relative to their state at branch base.

## Task 1 — `setupCrudRepository`, test-first, no screen touched yet

Write `src/data/setupCrudRepository.js` per the ADR's contract (`writeFields`, `createRecord`,
`deleteAllRecords`) and `src/data/setupCrudRepository.test.js` driving it with a fake `localClient`
(mirroring how `scheduleRepository.test.js` — check if one exists; if not, mirror
`scheduleRepository`'s own doc comment on collaborator injection as the test surface). Cover:
- `writeFields` throws on first non-`applied`/`queued` result, does not continue to later fields.
- `createRecord` writes fields in the given order; on failure after partial writes, best-effort
  `deleteEntity` cleanup, then rethrows the ORIGINAL error (not a cleanup error).
- `createRecord`'s cleanup failure is swallowed (cleanup itself throwing does not mask the
  original error or throw a second exception).
- `deleteAllRecords` returns `{ succeeded, failed, failedDueToRole }` matching today's
  `GroupsScreen.deleteAll`/`TiersScreen.deleteAll` counting logic exactly (both reference-checked
  against the ADR's quoted behavior).

No screen imports this yet. Commit.

## Task 2 — `useCrudScreen`, test-first, no screen touched yet

Write `src/hooks/useCrudScreen.js` per the ADR's contract and
`src/hooks/useCrudScreen.test.js` using `@testing-library/react`'s `renderHook` (check existing
hook tests, e.g. `src/hooks/useCohorts.test.js` if present, for this project's hook-testing
convention) with a fake `setupCrudRepository` injected. Cover:
- `add(formState)` calls `buildCreateFields`, mints an id, calls `createRecord`, reloads, clears
  form state on success.
- `add` surfaces `errorMessages.uniqueCollision` when the underlying error message matches
  `/UNIQUE/i`, else `errorMessages.addFailed`.
- `save(id, fields)` calls `writeFields`, reloads; on failure sets error and RETHROWS (matching
  today's `saveGroup`/`saveTier` — callers like `TierRow.save` catch it to stay in edit mode).
- `deleteAll()` re-fetches fresh rows via `localClient.list` before building the id list (NOT the
  hook's own `rows` state) — this is the fresh-refetch behavior called out in the ADR as a real
  correctness property to preserve, so assert the fake `localClient.list` is called again inside
  `deleteAll`, not just once at initial load.
- `importRows(parsedRows, { mapRow, duplicateCheck })` skips warned/duplicate rows, tallies
  `{added, skipped}`, uses the same create-with-cleanup path as `add`.

No screen imports this yet. Commit.

## Task 3 — characterization tests for `DaysScreen` (migrate first — smallest, no cohort scoping)

Before touching `DaysScreen.jsx`, extend `src/screens/DaysScreen.test.jsx` (currently 169 lines)
to pin every behavior in the ADR's "duplication, measured" list as it exists TODAY in
`DaysScreen.jsx`, specifically the ones not already covered by the existing 169 lines:
name-first write ordering on add, cleanup-on-partial-failure, fresh-refetch before delete-all,
`/admin role required/i` → role-specific message, `/UNIQUE/i` → collision message, import
skip-on-duplicate-or-warning. Run green against the CURRENT (unmigrated) `DaysScreen.jsx`. Commit
the test additions alone — this is the safety net the migration in Task 4 is checked against.

## Task 4 — migrate `DaysScreen`

Swap `DaysScreen.jsx`'s local `writeFields`/`cleanupPartialRow`/`addDay`/`saveDay`/`deleteAll`/
`confirmImport` internals to call `useCrudScreen`. Screen keeps: table rendering, `DayRow`,
`downloadTemplate`'s column headers, `onFileChange`'s validation rules, its own delete-confirmation
modal (Days has no `previewDelete` backend support per the ADR — unchanged). Run Task 3's
characterization tests plus the pre-existing `DaysScreen.test.jsx` assertions — all green, zero
edits to expected values. Run `npm run test -- src/screens/DaysScreen.test.jsx` and the full
suite. Commit.

## Task 5 — characterization tests + migrate `TiersScreen` (exercises cohort `scopeFilter`)

Same two-step pattern as Tasks 3-4, scoped to `TiersScreen.jsx`. Extra characterization coverage
needed here specifically: the cohort-scoped `scopeFilter` (`camp_id` AND `cohort_id`), the
stale-load-guard (`loadRequestRef`) behavior when `activeCohort` changes mid-load — confirm this
either stays screen-local (recommended: it's cohort-switching UI logic, not CRUD IO) or gets a
`useCrudScreen` extension point; default to keeping it screen-local unless it turns out to
duplicate into a later screen too, per karpathy — don't generalize on a sample size of one. Commit
tests, then commit migration, matching Task 3/4's split.

## Task 6 — characterization tests + migrate `TimeBlocksScreen`

Same pattern. `TimeBlocksScreen` has no cohort scoping and no delete-preview backend support
(hand-rolled modal, like Tiers/Days) — expect this to be the closest repeat of Task 3/4, lowest
risk of surfacing a new divergence. Commit tests, then commit migration.

## Task 7 — characterization tests + migrate `GroupsScreen` (exercises week-exclusion wiring + `DeleteRecordDialog`)

Same pattern. Extra characterization coverage: `loadExclusions`/`handleToggleExclusion`/
`confirmExclusion` (week-context exclusion toggle) and the `DeleteRecordDialog` +
`localClient.previewDelete` path (Groups DOES have backend delete-preview support, unlike Tiers/
Days/TimeBlocks) stay screen-local and unchanged — `useCrudScreen`'s `remove(id)` is called only
after the screen's own confirmation flow resolves, per the ADR. Commit tests, then commit
migration.

## Task 8 — characterization tests + migrate `ActivitiesScreen` (largest, most screen-specific logic — migrate last)

Same pattern, extra care: `duplicateActivity`, eligibility toggles (`toggleTier`/`toggleGroup`),
and its own week-exclusion wiring are NOT part of the shared seam and stay entirely screen-local —
this task is the load-bearing check that `useCrudScreen`'s config surface is flexible enough to
absorb the screen with the most divergence without needing new escape hatches invented on the
spot. If it DOES need a new hook option, that is a signal to stop and report back to Governor
before proceeding — a hook whose shape needed to change on its last consumer is worth a second
look before committing to it as done. Commit tests, then commit migration.

## Task 9 — final verification

Run `npm run test` (full suite, not per-file) and `npm run lint`. Confirm no screen among the
five retains a local `writeFields`/`cleanupPartialRow` definition (`grep -n "function writeFields"
src/screens/{Groups,Tiers,Days,TimeBlocks,Activities}Screen.jsx` returns nothing). Update the ADR's
`status` front-matter from `proposed` to `accepted` and `implementation_state` from
`not-started` to `implemented` (per this project's doc-staleness gate — the status flip ships in
the same commit as the work it describes). Report to Governor for the code-review/verifier loop.
