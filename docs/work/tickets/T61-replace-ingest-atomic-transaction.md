---
title: T61-replace-ingest-atomic-transaction
document_type: ticket
status: open
created: 2026-08-07
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/work/specs/S-replace-ingest-atomic-transaction.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md, docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md]
related_tickets: [docs/work/tickets/T16-ingest-prior-year-schedule.md]
archive_when: the change lands, the ingest suite covers replace-mode rollback, and a real Replace import against a camp with schedule data leaves the camp either fully replaced or untouched
---

# T61 — Replace-mode ingest runs in one main-process transaction

**Spec:** [`docs/work/specs/S-replace-ingest-atomic-transaction.md`](../specs/S-replace-ingest-atomic-transaction.md)
— read it first. It is normative, including the deletion order.

**Raised:** 2026-08-07, product owner.

> "replace ingest = delete dependents + delete set + create new set up + create inferred
> rules/anchors — inside one main-process transaction"

## The problem

`src/screens/ImportScreen.jsx`'s `commit()` (the `importMode === 'replace'` block, ~lines
220–255) tears the camp down from the renderer with one IPC call per row across four
dependent tables, then `anchor_activities`, then the five REPLACEABLE setup entities —
hundreds of independent transactions with no atomicity between them. Any failure mid-way
leaves a half-erased camp. Commit 32ff9d6 fixed the FK ordering by hand and a malformed-DB
state was still reached in testing.

## What to build

1. `electron/ops/ingest.js` — `commitIngest` accepts `mode: 'add' | 'replace'`; a new
   `replaceScope()` appends the teardown ops as the **first statements inside the existing
   `db.transaction()` body**. One transaction, one function. Do not add a parallel
   `commitReplace`.
2. Teardown order per spec §"Deletion order (normative)", including the two steps today's
   renderer code misses: `day_override_template_slots`, and nulling
   `activities.weather_alternative_id` before deleting activities.
3. `PRAGMA foreign_key_check` inside the transaction after the deletes; any row throws.
4. `electron/main.js` — thread `mode` through the `ingestCommit` handler. Auth unchanged:
   `requireAuthorized(..., 'groups.import')`, admin-only, checked before the transaction.
5. `src/localClient.js` / `src/localClient.mock.js` — thread `mode` through.
6. `src/screens/ImportScreen.jsx` — delete the whole replace teardown block; the branch
   becomes one awaited IPC call. Surface `replaced` counts in the result banner.
7. **Host-only guard — both modes.** `ingestCommit` refuses `mode: 'replace'` *and* bare
   Add-mode calls when the device is in Client mode, same shape as `deleteRecordHandler`
   (`electron/main.js:855-858`). Without this guard on Replace, the camp is silently forked.
   Add mode lacks the guard too; fix both in the same location. Replace error:
   *"Replace can only be run on the main computer."* Add error: *"Import can only be run on
   the main computer."* Read spec §"Risks considered — HIGH" and its amendment before
   touching this; write separate test cases for each mode.
8. Replace confirmation copy warns that saved schedule versions become unrestorable and
   that Day Override templates are emptied. Spec §"Risks considered", MEDIUM-HIGH and LOW.
9. **Activity normalization.** In `commitIngest` (both modes), before appending any op,
   floor each activity's `min_per_week` to `1` if it has eligible groups and the value is
   currently `0` or null. Spec §"Activity data normalization". Add a test confirming an
   activity with `min_per_week: 0` and eligible groups is stored as `1`.

## Definition of done

The spec's success predicate, verbatim. In short: Replace either fully succeeds or leaves
the camp untouched; `commit()` has no delete loop; `foreign_key_check` is clean; rollback
is proven by a test that injects a failure after the deletes and asserts row counts and
`operations` length are unchanged; `npm run test` and `npm run lint` pass.

## Notes for the Maker

- Test-first. This is a data seam under `TESTING_STANDARD.md`.
- Deletes stay ordinary `__deleted__` ops so Trash and per-record history keep working.
  Do not switch to raw SQL `DELETE`, and do not add `ON DELETE CASCADE` — see
  `docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md` for why.
- Scope the dependent-row queries via `electron/ops/campScopedEntities.js`'s
  `PARENT_SCOPED_ENTITIES` rather than hand-writing joins.
- `cohorts` is never deleted.
- Cover the client-mode refusal, a large-camp wall-clock budget, and mutually-referencing
  `weather_alternative_id` activities (A→B, B→A) in the test set.
- `npm rebuild better-sqlite3` before `npm run test` if you have been running Electron.
