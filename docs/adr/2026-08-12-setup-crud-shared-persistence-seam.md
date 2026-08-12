---
title: "A shared persistence seam for the setup-CRUD screens"
document_type: adr
authority: normative
status: proposed
date: 2026-08-12
supersedes: []
implementation_state: not-started
affects:
  - src/screens/GroupsScreen.jsx
  - src/screens/TiersScreen.jsx
  - src/screens/DaysScreen.jsx
  - src/screens/TimeBlocksScreen.jsx
  - src/screens/ActivitiesScreen.jsx
  - docs/work/plans/2026-08-12-setup-crud-hook-migration-plan.md
---

# A shared persistence seam for the setup-CRUD screens

**Status: PROPOSED.** This ADR follows the precedent of
[2026-08-01-schedule-screen-persistence-seam.md](2026-08-01-schedule-screen-persistence-seam.md):
it decides the seam and its contract only. Governor routes implementation to Maker one screen at
a time per the migration plan; this ADR is not itself a licence to touch all five screens at once.

---

## Context

### The five setup-CRUD screens — confirmed, not five-by-assumption

`src/screens/GroupsScreen.jsx`, `TiersScreen.jsx`, `DaysScreen.jsx`, `TimeBlocksScreen.jsx`, and
`ActivitiesScreen.jsx` (612 / 602 / 410 / 576 / 922 lines, 3,122 total) each render a named-entity
list with add/edit/delete/import-from-Excel/delete-all against one `localClient` entity table.
`DayOverridesScreen.jsx` was checked and excluded: it edits per-week slot overrides, not a named
entity list, and has none of the duplicated machinery below (no `writeFields`, no
`cleanupPartialRow`, no `downloadTemplate`/`onFileChange`/`confirmImport` triad). The premise
holds as stated — five screens, not `DayOverridesScreen`.

### The duplication, measured

Each of the five screens independently defines, nearly verbatim:

- **`writeFields(id, fields)`** — loops `Object.entries(fields)`, calls
  `localClient.write(token, entity, id, field, value)` per field (the op-log is field-level),
  throws on the first non-`applied`/`queued` result. Comments in `GroupsScreen.jsx:167-169`,
  `TiersScreen.jsx:157-159` explicitly cross-reference each other as the source of the copy.
- **`cleanupPartialRow(id)` / inline equivalent** — best-effort `deleteEntity` if a later field
  write fails after `name` (the first field) already created the row via `ensureExists`.
- **Add-record flow** — mint `crypto.randomUUID()`, write `name` first deliberately (so a
  `UNIQUE(camp_id[, cohort_id], name)` collision fails atomically before the row exists), catch
  the failure, translate `/UNIQUE/i` into a friendly "already exists" message via
  `describeWriteFailure`.
- **`deleteAll()`** — re-fetch fresh from `localClient.list` (never the closed-over state, to
  avoid silently skipping rows another device synced in), loop `deleteEntity`, count
  successes, detect `/admin role required/i` to produce a role-specific message.
- **Excel import triad** — `downloadTemplate()` (XLSX template via `aoaToSanitizedSheet`),
  `onFileChange()` (parse + per-entity validation to a `warning` field), `confirmImport()` (loop
  rows, skip duplicates/warnings, same add-record atomicity dance, tally `{added, skipped}`).
- **Delete-confirmation UI** — two different real implementations, not one duplicated. Groups and
  Activities have backend `previewDelete` support and use `DeleteRecordDialog`
  (see `docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md`); Tiers, Days, and TimeBlocks
  do not, and each hand-rolls an equivalent confirm modal (`TiersScreen.jsx:532-550`) with a
  comment acknowledging the fallback. **This is a real per-entity difference, not something the
  extraction should paper over.**

### What does NOT apply here — a premise correction

The task brief asks the refactor to "preserve human-provenance-on-reimport (`_humanFields`)."
Checked: `_humanFields`/`humanEditedFields` exists only in `electron/ops/ingest.js`,
`src/ingest/buildPlan.js`, and `src/screens/ImportScreen.jsx` — the bulk reconciliation importer
for prior-year schedules, a separate subsystem from these five screens' own "Import from Excel"
buttons. The five screens' import triad does a plain local XLSX parse and per-row `writeFields`;
it never touches `_humanFields` and never re-imports over hand-edited rows in the provenance sense
(each import only *adds* rows whose name doesn't already exist; it never overwrites an existing
row's fields). **The provenance constraint from the task brief does not apply to this refactor.**
It is called out here so nobody adds defensive humanFields-preserving code against a mechanism
these five screens never touch. The constraint that DOES apply, and is preserved by design below,
is the atomic-create-and-collision-cleanup behavior and the fresh-refetch-before-delete-all
behavior — both are real correctness properties, just not humanFields.

### Reused precedent

`src/data/scheduleRepository.js` (ADR `2026-08-01-schedule-screen-persistence-seam.md`) already
established this project's pattern for a persistence seam: a plain factory function
(`createScheduleRepository({ localClient, getToken })`), collaborators injected so the seam is a
test surface, no React inside it, typed/thrown errors, screen owns UI decisions. This ADR applies
the same pattern to the setup-CRUD screens rather than inventing a second one.

---

## Candidate approaches considered

1. **Single generic `useCrudScreen(entityConfig)` hook covering IO + table rendering.** Assumption:
   the five screens are similar enough that even rendering can be config-driven (columns, cell
   editors, grouping). Rejected — false on inspection. Groups groups rows by tier with subheaders;
   Activities has eligibility toggles, a duplicate-row action, and week-exclusion wiring that
   Tiers/Days/TimeBlocks don't have at all; Tiers's delete confirmation is a bespoke modal, Groups's
   is `DeleteRecordDialog`. Forcing rendering into one config schema would either lose real
   per-entity behavior or grow an escape-hatch config so large it's not actually shared code
   anymore — the over-engineering trap `karpathy-guidelines` warns against.

2. **Extract only the pure non-React helpers (`writeFields`, `cleanupPartialRow`, `deleteAll` loop,
   collision-message translation) into a plain module; no hook.** Assumption: React state
   management is thin enough per-screen that a hook adds indirection without saving much. Rejected
   as too small — it would still leave each screen re-deriving loading/error/adding state and the
   add/save/delete/import *orchestration* (not just the IO), which is most of the ~150-200 lines
   that are actually identical across screens (see `writeFields`→cleanup→add→save→deleteAll→import
   call sequence, byte-similar in Groups vs Tiers vs Days vs TimeBlocks).

3. **A repository layer (mirroring `scheduleRepository`) for IO, plus a thin `useCrudScreen` hook
   for React state/orchestration built on top of it. Table/row rendering, columns, validation, and
   import-row mapping stay screen-specific.** This is the recommended candidate — see Approach.

4. **Big-bang rewrite of all five screens at once, including a shared table/row component
   library.** Assumption: doing it once is cheaper than five incremental migrations. Rejected per
   the task brief's explicit requirement and this project's own standing practice
   (`docs/adr/2026-08-01-schedule-screen-persistence-seam.md`'s four-step program) — a
   behavior-preserving refactor across five screens with real per-entity divergence is exactly the
   case for small reversible steps with the suite green between each, not one large diff nobody can
   bisect if something regresses.

**Recommendation: Candidate 3, with confidence: high.** Evidence: the duplicated code is
concentrated in orchestration + IO (write/delete/import), not rendering; `scheduleRepository`
is a proven, tested precedent for the same split in this exact codebase; and the two real
per-entity divergences found (delete-confirmation UI, Activities' extra eligibility/exclusion
logic) both live in the "stays screen-specific" zone under this design, so nothing has to be
forced to fit.

---

## Decision

### `setupCrudRepository` — the IO layer

A new file, `src/data/setupCrudRepository.js`, following `scheduleRepository.js`'s shape exactly:

```js
export function createSetupCrudRepository({ localClient, getToken = () => localStorage.getItem('shoresh-token') }) {
  return {
    async writeFields(entity, id, fields) { /* the shared loop, entity is a parameter now */ },
    async createRecord(entity, id, orderedFields) {
      // writes orderedFields in the given order (name-first is a caller decision, not baked in
      // here — TimeBlocksScreen and DaysScreen may order differently); on any failure, best-effort
      // deleteEntity(id) cleanup, then rethrow the original error.
    },
    async deleteAllRecords(entity, ids) {
      // loops deleteEntity, returns { succeeded, failedDueToRole, failed }
      // caller re-fetches fresh ids before calling this — repository does not own "what counts as
      // this camp's rows", screen does (varies: camp_id only for Groups, camp_id+cohort_id for
      // Tiers, etc.)
    },
  }
}
```

`writeFields` and `createRecord` are entity-parametrized (not one repository instance per entity)
because the five screens share one `localClient` instance and there is no per-entity state to
close over — matching `scheduleRepository`'s existing style of taking the entity/table name as a
call argument where it already does so (`bulkReplace`, `list`).

**What stays OUT of the repository, deliberately:** row-shape validation, the `UNIQUE`-collision
message text, the `admin role required` message text, and XLSX parsing/column mapping. Those are
either screen-specific copy or genuinely screen-specific data shape — putting them in the shared
layer is Candidate 1's mistake at smaller scale.

### `useCrudScreen` — the React orchestration layer

A new file, `src/hooks/useCrudScreen.js`, taking an entity-specific config object and returning
the state + handlers every screen currently hand-writes:

```js
function useCrudScreen({
  entity,               // 'groups' | 'tiers' | 'days' | 'time_blocks' | 'activities'
  campId,
  scopeFilter,          // (row, campId) => boolean — e.g. groups: row.camp_id === campId;
                         // tiers: row.camp_id === campId && row.cohort_id === activeCohortId
  loadDeps,             // extra localClient.list() calls the screen needs alongside the entity
                         // (e.g. tiers also lists groups for groupCounts) — returned raw, screen
                         // shapes them; the hook does not know about tier/group relationships
  buildCreateFields,    // (formState) => orderedFields object, screen decides field order/content
  duplicateCheck,       // (existingRows, candidateName) => boolean, screen decides case/whitespace rule
  errorMessages,        // { uniqueCollision, addFailed, saveFailed, deleteFailed, adminOnlyDelete }
                         // — screen supplies its own copy strings; hook just picks which one fires
})
```

Returns: `{ rows, loading, error, setError, add(formState), save(id, fields), remove(id) via
existing per-entity delete-confirmation flow (unchanged — see below), deleteAll(), importRows(rows,
{ mapRow, duplicateCheck }), importState, ... }`.

**Delete-confirmation stays screen-specific, not hidden inside the hook.** Groups/Activities call
`localClient.previewDelete` + render `DeleteRecordDialog`; Tiers/Days/TimeBlocks render their own
modal. The hook exposes `remove(id)` as "do the delete, given the screen already confirmed it,"
not as an owner of confirmation UI — this matches `scheduleRepository` not owning UI either.

**Excel import stays split**: `downloadTemplate`/column headers and `onFileChange`'s per-row
validation (`warning` derivation) are screen-specific and NOT moved — they encode the entity's
actual field set. What moves into the hook is the *loop*: iterate `importRows`, skip
warned/duplicate rows, call the shared create-with-cleanup path, tally `{added, skipped}`. The
screen supplies `mapRow(row) => orderedFields` as the only per-entity piece.

### Interaction with the op-log write path and `authorize()`

No change. `setupCrudRepository` calls `localClient.write`/`localClient.deleteEntity` exactly as
the screens do today — same token acquisition (`getToken`), same IPC surface, same
`authorize()` re-check on the Electron side per call. The hook and repository are a refactor of
the *caller*, not the write path; nothing here changes what crosses IPC or how `operations` rows
are appended.

### Files/modules affected

New:
- `src/data/setupCrudRepository.js` (+ `setupCrudRepository.test.js`)
- `src/hooks/useCrudScreen.js` (+ `useCrudScreen.test.js`)

Changed, one at a time per the migration plan (see plan doc), each PR touching exactly one screen:
- `src/screens/GroupsScreen.jsx`
- `src/screens/TiersScreen.jsx`
- `src/screens/DaysScreen.jsx`
- `src/screens/TimeBlocksScreen.jsx`
- `src/screens/ActivitiesScreen.jsx`

Unchanged: `src/screens/DayOverridesScreen.jsx` (excluded per the premise check above),
`src/data/scheduleRepository.js`, `electron/**`, `src/localClient.js`.

### Reused vs. new

Reused: the `scheduleRepository` factory pattern (collaborators injected, plain function, no
React), `describeWriteFailure`/`deleteRefusalMessage` (unchanged, still called by screens with
their own copy), `DeleteRecordDialog`/`RecordHistory` (unchanged, still rendered by the two
screens that use them today).

New: `setupCrudRepository.js` and `useCrudScreen.js` — genuinely new because no existing module
generalizes the write/delete/import orchestration across *multiple* entity types; `localClient` is
already generic per-entity but has no concept of "create with collision cleanup" or "delete all
with role-failure tallying."

### ADR required: yes

This introduces a new shared primitive (`useCrudScreen` + `setupCrudRepository`) that five existing
screens will depend on for their write/delete/import path — the same bar `scheduleRepository`
met, on the same project's own precedent. Filed here:
`docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md`.

**Consequence:** once a screen migrates, its write/delete/import behavior is governed by this
contract, not by screen-local code. A future entity needing a sixth setup-CRUD screen should
build on `useCrudScreen` rather than hand-rolling a sixth copy — but nothing here forces
`DayOverridesScreen` or any future non-list-shaped screen onto it.

---

## Implementation note / deviation from sketch

The sketch above shows `useCrudScreen` taking an `errorMessages: { uniqueCollision, addFailed,
saveFailed, deleteFailed, adminOnlyDelete }` config map. The shipped implementation
(`src/hooks/useCrudScreen.js`) instead takes flat string/function props —
`addFailedText`, `saveFailedText`, `adminOnlyDeleteAllText`, `partialDeleteAllText` — and routes
failures through the existing `describeWriteFailure(err, fallbackText)` util
(`src/utils/writeErrorMessage.js`) rather than a hook-owned `uniqueCollision` string.

Why: `describeWriteFailure` already encodes the UNIQUE/FK/NOT NULL/transport-aware copy each
screen relied on before this refactor (e.g. `/UNIQUE/i` → "Another record already has that
name."), and every screen's characterization tests pin its exact existing wording. Re-deriving
that logic as a static `uniqueCollision` string in the config map would either (a) duplicate
`describeWriteFailure`'s pattern-matching inside the hook, or (b) require each screen to
pre-compute the matched message itself before handing it to the hook — both strictly worse than
calling the already-tested util directly and passing only the fallback text. This is a case of
Approach 3 as adopted, not Approach 3 as literally sketched; the seam (`add`/`save` surface a
single error string on failure, callers supply their own copy) is unchanged, only how that string
is produced.

Confirmed non-issue: `deleteFailed`/`adminOnlyDelete` fold into `adminOnlyDeleteAllText`/
`partialDeleteAllText` for `deleteAll()`'s two failure modes; the per-row `deleteEntity` failure
path (`deleteDay`/`deleteTier` etc.) stays screen-local per the ADR's own "delete-confirmation
stays screen-specific" decision and was never part of this config surface to begin with.

## Open questions for Governor

1. **Migration order** — the plan (below) proposes Days first (smallest, 410 lines, no cohort
   scoping, no eligibility/exclusion complexity) as the first migrated screen to validate the seam
   cheaply, then Tiers (cohort-scoped, exercises `scopeFilter`), then TimeBlocks, Groups
   (week-exclusion wiring), and Activities last (largest, most screen-specific logic, exercises
   the hook's flexibility under the most pressure). Confirm this order or reprioritize.
2. **Characterization tests** — each of the five screens already has a `*.test.jsx` file
   (98–335 lines). Confirm whether Governor wants NEW characterization tests written *before*
   migrating each screen (capturing current behavior byte-for-byte, per the task's test-seam
   requirement) or whether the existing test files are judged sufficient coverage to migrate
   against directly. The plan below assumes new characterization tests are wanted, since the
   existing suites were written for the old (or partially-old) shape and may not pin every
   behavior called out above (e.g. fresh-refetch-before-delete-all, name-first collision
   ordering).
3. **`DayOverridesScreen`** — confirmed out of scope for this program (see premise correction
   above). No action needed unless Governor disagrees with the exclusion.

## Post-implementation notes (all 5 screens migrated)

- **`useCrudScreen` ended up used by only one screen (Days).** This is the disclosed, empirical
  outcome of the plan's assumption turning out ~1/5 true: Tiers/TimeBlocks/Groups/Activities each
  have a load model (compound cohort scoping, parallel `Promise.all` fetches, race guards) that the
  hook's single-entity/single-`scopeFilter` load does not cover, so they use `setupCrudRepository`
  directly and keep load orchestration screen-local. Decision (Code Reviewer + Governor): **keep the
  hook, do not inline it back into Days** — it does real orchestration work Days would otherwise
  hand-roll, and it is the intended base for a future sixth simple-load-model setup screen. Tracked
  as unconfirmed-until-proven: no second simple-load screen has yet validated that the hook slots in
  cleanly; the next such screen should confirm it rather than assume.
- **Follow-up done: `AnchorsScreen` and `CohortsScreen` migrated.** Both were migrated onto
  `setupCrudRepository` via the repository-only path (same as Tiers et al.), behavior-preserving,
  under characterization tests pinned green against the pre-migration screens first. Scope of each:
  - `CohortsScreen` — `writeFields` now delegates to `repository.writeFields('cohorts', …)`. No
    serialization is composed (every field is a string/number/null). `addCohort` deliberately keeps
    calling `writeFields`, **not** `createRecord`: a `name`-first UNIQUE collision fails atomically, so
    there is no partial row to compensate-delete, and adopting `createRecord` would add a rollback
    delete that changes behavior. The single-row `deleteCohort` (last-program guard + FK-specific copy)
    stays screen-local; there is no delete-all.
  - `AnchorsScreen` — `writeFields` composes Anchors-only `serializeFields` (boolean→number,
    array→JSON string) then delegates to `repository.writeFields('anchor_activities', …)`; `deleteAll`
    delegates to `repository.deleteAllRecords`. `saveAnchor`'s per-day fan-out with granular orphan
    reporting and `cleanupPartialRow` stay screen-local — the shared `createRecord`'s
    swallow-and-rethrow cleanup cannot express the "how many rows could not be rolled back" count the
    UI surfaces.
