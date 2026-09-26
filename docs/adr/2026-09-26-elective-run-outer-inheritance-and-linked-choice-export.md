---
title: "Elective run outer-schedule group-template inheritance and linked-choice export shape (v76)"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-09-26
approved: 2026-09-26 (owner ruling relayed via Governor — see "Owner ruling" below)
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - SECURITY.md
related_adrs:
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
related_specs:
  - docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md
related_tickets:
  - docs/work/tickets/T197-projection-and-export.md
  - docs/work/tickets/T243-elective-run-lifecycle-schema.md
  - docs/work/tickets/T244-finalize-elective-run-ipc.md
  - docs/work/tickets/T248-child-schedule-export.md
---

# Elective run outer-schedule group-template inheritance and linked-choice export shape (v76)

## Context

`docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md` decision (d) specifies, in
prose, that a run's draft outer schedule is derived "for the non-elective cells the run's campers
occupy" by reading the camper's group's `template_slots`. T244/T248 did not build that. The module
header of `electron/ops/electiveRunOuterSchedule.js` records why: building the draft-read path to
that prose while `finalizeElectiveRun.js` snapshotted only resolved elective placements would make
draft-derive and finalize **disagree** for the same run — the exact defect
`electiveRunOuterSchedule.integration.test.js` exists to prevent. That governor extracted T244's
actual derivation into one shared function, called by both the draft-read handler
(`getElectiveRunOuterScheduleHandler`) and `finalizeElectiveRun.js`, and left the ADR's
group-template reading unbuilt on both sides — a **known, recorded, symmetric gap**, not a defect
in either path.

T197's remaining scope requires that gap closed: a child's non-elective cells must appear in the
export, and a finalized run's export must survive a later template edit (the finalization-snapshot
requirement, decision (d) again). It also requires a linked elective choice — whose member
occurrences are not contiguous — to render as one unit rather than as N separate cells.

Both requirements need the same thing: more information flowing through
`deriveElectiveRunOuterRows` and into `elective_run_outer_snapshots`. That is an additive schema
change. v76 is allocated to this work (verified free across all remote branches and local
worktrees at time of writing; max in use is v74).

## Owner ruling

Per the dispatching brief: ADR `2026-09-23-...` decision (d), chosen option 2, already reads "for
the non-elective cells the run's campers occupy." The shipped code does not do that. Building it
now does not reopen a settled deviation — it **resolves** an already-open item (ADR prose vs.
shipped code). This ADR records that resolution and supersedes decision (d)'s deferred half.

## Decision

### 1. `deriveElectiveRunOuterRows` returns two cell kinds from one call, symmetrically

`electron/ops/electiveRunOuterSchedule.js` gains a second internal query (group-template
inheritance) whose output is merged with the existing elective-assignment query. Every returned
row carries a `cell_kind` discriminant: `'elective'` (today's behavior, unchanged) or
`'inherited'` (new). The function's inputs, signature, and the fact that `finalizeElectiveRun.js`
and the draft-read handler both call the exact same function are unchanged — this is the load-bearing
symmetry and it is preserved by construction: there is still only one code path that decides what a
camper's outer schedule looks like for a run, whether that call happens at draft-read time or at
finalize time.

```js
/**
 * @returns {{rows: Array<OuterRow>, skipped: Array}}
 *
 * OuterRow (both kinds):
 *   camper_id, day_id, time_block_id, cell_kind: 'elective' | 'inherited',
 *   activity_id, activity_name, location_id, location_name, span_blocks,
 *   solver_generation,          // null for 'inherited' rows — no generation concept applies
 *   choice_id,                  // 'elective' rows only; null for 'inherited'
 *   is_linked_choice,           // boolean; 'elective' rows only; false for 'inherited'
 * }
 */
export function deriveElectiveRunOuterRows(db, run)
```

**Camper universe.** Unchanged from today's implicit universe, made explicit: the set of
`camper_id`s appearing in generation-visible `elective_assignments` for the run, **union** the set
of `camper_id`s in `elective_preferences` for the run (so a camper with zero resolved assignments
this generation — fully unranked/unassigned — still receives their inherited group cells; without
this a fully-unassigned camper's export would show only blank elective cells and no group
schedule at all, which contradicts "combining inherited group cells with elective assignments").
**Flagged for Governor** (see Open Questions): if product intent for "the run's campers" is
narrower or wider than this, that is a product call, not a technical one — the union above is the
conservative choice that never drops a camper the run touches.

**Elective query.** Unchanged (existing SQL), plus two additional selected/joined columns:
`a.choice_id`, and `c.is_linked AS is_linked_choice` via `LEFT JOIN elective_choices c ON
c.id = a.choice_id`. `cell_kind` is a literal `'elective'` on every row this query produces.

**Inheritance query (new).** For each distinct `(camper_id → group_id)` pair among the camper
universe above (via `campers.group_id`), read that group's `template_slots` rows for
`run.schedule_template_id` **where `elective_set_id IS NULL`** (elective-set slots are excluded
categorically — those cells are populated by the elective query regardless of whether an
assignment happens to exist for that generation; a slot with no visible assignment this generation
is a gap the exceptions layer reports, not a fallback to the template). Each qualifying
`template_slots` row resolves to `activity_id` (direct), `anchor_id` (via `is_anchor`/`anchor_id`
→ resolve the anchor's own `activity_id`/name if anchors carry one, else name from
`anchor_activities`), or `event_id` (via `events` → its activity/name) — same three-way resolution
`finalizeElectiveRun.js`'s existing `mapTemplateSlot` already performs for conflict-scoping,
reused here for the same classification rather than re-invented.

**Span-collapsing for inherited cells (new logic — see §3).** `template_slots` is *not*
pre-collapsed like `elective_occurrences` is: a 3-block activity in a group's template is three
separate rows with identical `activity_id` at three consecutive `time_block_id`s (this is exactly
the shape `src/utils/exportSchedule.js`'s D12 defect fails to collapse, and exactly what the
renderer's `collectSpanTails`/`getActivityRowSpan` collapse in the browser — tools this module
cannot call, per its own header comment, because they run on a renderer `slots` grid and this is
main-process code). The inheritance query must do its own contiguous-run collapse to produce one
row per span head, matching the elective side's existing shape, or the two cell kinds returned by
one function would carry two different granularities — which is worse than the current gap.

Algorithm: load `time_blocks` for the relevant cohort, build a `time_block_id → sort_order` map;
for each `(group_id, day_id)`, sort the qualifying `template_slots` rows by that order; walk the
sorted list and merge adjacent rows into one span head when they share the same resolved
`(kind, ref_id)` (activity/anchor/event identity) — `span_blocks` on the emitted row is the
**derived run length** (count of merged rows), not a copy of `activities.span_blocks`. This is a
deliberate divergence from the elective side's convention (which copies `activity.span_blocks`
unchanged) because there is no occurrence-level authority for inherited cells the way there is for
elective occurrences — the template rows on disk are the only ground truth, and trusting a
possibly-stale `activities.span_blocks` value instead of the actual contiguous run would let the
export disagree with what the template screen shows. Non-contiguous repeats of the same activity
on the same day (a gap in between) are two separate spans, not one — this only merges adjacent
blocks.

### 2. Linked-choice grouping is a separate concept from a span, applied downstream

A span (`span_blocks > 1`) is **contiguous time occupancy** by one row. A linked choice's member
occurrences are **not** contiguous — they are multiple, possibly non-adjacent, elective
occurrences a camper was assigned to as one bundled decision (`elective_choices.is_linked = 1`,
`elective_assignments.choice_id`). Conflating the two would make a linked choice's export depend on
its members happening to be adjacent, which they are not guaranteed to be.

Resolution: `deriveElectiveRunOuterRows` / the snapshot never clusters by `choice_id` — it emits
one row per resolved elective placement (span-collapsed only within that placement's own
contiguous occupancy, exactly as today), carrying `choice_id` + `is_linked_choice` as plain
metadata. Clustering into "one rendered unit" is a **separate, pure, IO-free** post-processing step:

```js
// src/utils/clusterLinkedElectiveRows.js
export function clusterLinkedElectiveRows(rows) {
  // rows: OuterRow[] (as returned by getElectiveRunOuterSchedule / the snapshot read)
  // returns: Array<{ kind: 'span', ...row } | { kind: 'linked_choice', camperId, choiceId,
  //   label, memberRows: OuterRow[] }>
  // Groups only rows where is_linked_choice === true, by (camper_id, choice_id).
  // Every other row passes through unchanged as kind: 'span'.
}
```

This lives in `src/utils/` (a pure function, no DB/IPC), imported by every consumer that needs
"one unit per linked choice": the child-schedule export, the roster export, and the XLSX builder.
One function, one definition of "linked choice as a unit" — the same discipline
`electiveGenerationPredicate.js` established for visibility. This is safe under this repo's
renderer/main import convention: `finalizeElectiveRun.js` already imports pure functions from
`src/` (`deriveOccurrences.js`, `routeConflicts.js`); a `src/utils/` pure helper imported the other
direction, by renderer-side export code that already lives in `src/`, needs no new precedent at
all — it never crosses into `electron/`.

`label` for a linked-choice unit is `elective_choices.label`; `memberRows` preserves each member's
own day/time_block/activity for renderers that want the detail, while `kind: 'linked_choice'` is
what a summary/roster view groups on to avoid repeating the camper N times.

### 3. Finalize snapshots both cell kinds, `choice_id`, and `is_linked_choice` — v76

`finalizeElectiveRun.js`'s snapshot-write loop is unchanged in structure (still one `appendOp` per
field per row, inside the existing `runAtomic` transaction) and gains three fields per row, sourced
from the same `deriveElectiveRunOuterRows` call it already makes — no new derivation exists at
finalize time, which is exactly what keeps draft-derive and finalize symmetric (see "Symmetry
argument" below).

**v76 additive columns on `elective_run_outer_snapshots`** (appended, in this order, matching the
ALTER-appends-at-the-end convention this schema already follows for v73/v74):

```sql
ALTER TABLE elective_run_outer_snapshots ADD COLUMN cell_kind TEXT NOT NULL DEFAULT 'elective'
  CHECK (cell_kind IN ('elective', 'inherited'));
ALTER TABLE elective_run_outer_snapshots ADD COLUMN choice_id TEXT;
ALTER TABLE elective_run_outer_snapshots ADD COLUMN is_linked_choice INTEGER NOT NULL DEFAULT 0;
```

`schema.sql`'s `CREATE TABLE IF NOT EXISTS elective_run_outer_snapshots` gets the same three
columns added directly to the fresh-install DDL, in the same order, so fresh and migrated
installs produce identical `PRAGMA table_info` output (the v74 migration test's own
"fresh vs migrated equivalence" pattern, replicated for v76 — see §6).

The `DEFAULT 'elective'` on `cell_kind` exists only so the `ALTER TABLE` can satisfy `NOT NULL` on
a table that may already hold v74 rows; per the migration posture (§5) those pre-v76 rows are never
read as `'elective'` in practice because every run that predates v76 gets re-finalized, not
migrated. It is a schema-satisfying default, not a claim about old data.

**Registrations to update alongside the DDL** (mechanical, same shape as every prior
`elective_run_outer_snapshots` field addition — T243/T244 already went through this for the base
five columns):
- `electron/ops/projections.js` — add `cell_kind`, `choice_id`, `is_linked_choice` to the
  `elective_run_outer_snapshots` entry's `fields` array (op-log replay must know about them or a
  synced write from another device silently drops these fields).
- `electron/ops/undoReferences.js` — `choice_id` is a soft reference to `elective_choices`; add one
  entry alongside the four existing ones (`day_id`, `time_block_id`, `activity_id`,
  `location_id`), `enforced: false`, same posture. `cell_kind`/`is_linked_choice` are not
  references — no entry needed.
- `electron/ops/mergeActivity.js` — no change: `activity_id`/`activity_name` handling is untouched;
  the new columns are not activity-shaped.
- `electron/ops/restore.js`, `electron/ops/campScopedEntities.js`,
  `electron/automerge/campDocument.js` (MODELED_ENTITIES entry), `electron/ops/participantEntities.js`
  — no change: the table itself is already registered everywhere these files care about; only its
  column *set* grows, which none of these enumerate independently of `projections.js`'s `fields`
  list. Verify this against each file directly before Maker starts (do not assume from this
  description — `electron/ops/restore.js`'s per-entity restore mapping in particular should be
  read to confirm it doesn't hand-enumerate columns).

No `GENESIS_ENTITIES`/`GENESIS_B64` regeneration is required: `elective_run_outer_snapshots` is
already a genesis-pinned entity (added at v74); adding columns to an already-modeled table does not
change the Automerge document shape genesis pins (empty-object placeholder), only the SQLite
projection's column set.

### 4. Rosters, exceptions, summary — renderer-side, one new IPC field addition, zero new handlers

Per clause 7 (no new staff-reachable path) and the existing precedent that
`src/utils/exportSchedule.js`/`exportScheduleJson.js`/`exportChildSchedule.js`/
`exportElectiveRun.js` are all renderer-side pure functions operating on already-authorized,
already-loaded data: **no new IPC action is introduced.** The only main-process change is widening
the existing `getElectiveRunOuterScheduleHandler`'s row mapping (both the `final`/snapshot branch
and the live-derive branch) to pass through `cellKind`, `choiceId`, `isLinkedChoice` alongside the
fields it already returns — same action name (`elective_assignment_runs.read`), same authorization
call, same shape otherwise. This is why `participantEntitiesAdminOnly.test.js`'s existing negative
assertion (lines 184-194, that a staff session cannot call `elective_assignment_runs.read`) needs
**no new test** — the action being asserted against is unchanged. Extend the handler's own
positive-path test (wherever `getElectiveRunOuterScheduleHandler`'s response shape is asserted
today) to cover the three new fields instead.

New renderer-side pure builders, mirroring `exportChildSchedule.js`'s existing shape and each
consuming `clusterLinkedElectiveRows` where a linked choice must render as one unit:

- **`src/screens/elective/export/exportActivityRoster.js`** — `buildActivityRosterExport({run,
  campers, groups, activities, days, timeBlocks, outerRows})`. Filters to `cell_kind === 'elective'`
  rows only (a roster is who's *assigned where*, not a restatement of the group template), clusters
  linked choices, groups by `(day_id, time_block_id, activity_id | choice_id)`, and for each group
  emits `{day, time_block, activity_name (or choice label), members: [{camper_id, camper_name,
  group_name}], count, capacity}`. `capacity` is read from the existing capacity data
  `getElectiveRunHandler` already returns (`capacityRows`) rather than re-querying — this is the
  "inverse projection of `elective_assignments`, no second roster table" the ticket requires: the
  roster is computed, not stored, from data already loaded for the Draft/Final screens.

- **`src/screens/elective/export/exportRunExceptions.js`** — `buildRunExceptionsExport({run,
  preferences, assignments, staleCount, capacityRows, outerRows})`. Categories fully discharged by
  this design from data already available on the existing `getElectiveRunHandler` response plus
  `elective_preferences` (already loaded by the Draft screen): **unassigned** (camper in the
  preference/camper universe with no visible assignment for an occurrence they ranked),
  **unranked** (camper with zero `elective_preferences` rows for an occurrence the run covers),
  **unresolved** (an occurrence with no assignment at all), **stale** (`staleCount`/the
  generation-stale fragment, already computed server-side). **Capacity** is discharged using
  `capacityRows` (already returned) compared against each occurrence's declared capacity.
  **Eligibility** and **resource** exceptions are **NOT discharged by this design** — no existing
  computed source for either category was found in this codebase during design (see Open Questions
  below); Maker should not invent a definition for these two categories without a Governor/product
  ruling on what they mean operationally for this run shape.

- **`src/screens/elective/export/exportRunSummary.js`** — `buildRunSummaryExport({run, preferences,
  assignments, capacityRows, camp, week})`. Pure aggregation over the same already-loaded data:
  counts by rank received, unassigned count, fill by offering (from `capacityRows`), run identity
  (`run.id`/`name`/`status`/`solver_generation`), `source_hash` (`run.source_sha256`, already on
  the run row), route/week/division (`run.schedule_template_id`/`schedule_week_id`/`tier_id`,
  resolved to names the same way `exportChildSchedule.js` resolves `group_id`).

- **`exportChildSchedule.js` (existing, extended, not rebuilt)** — its `schedule` mapping per camper
  now includes `cellKind` per row and runs `clusterLinkedElectiveRows` before emitting, so a linked
  choice appears once with its member list instead of N times. `format_version` on this file's
  contract bumps from `1` to `2` (shape change: rows gain `cell_kind`, a linked choice collapses
  from N schedule entries to 1) — this is `exportChildSchedule.js`'s **own** format_version, not
  `exportScheduleJson.js`'s group-schedule contract, which decision (per ticket) is explicitly not
  touched.

### 5. XLSX workbook

New `src/screens/elective/export/exportElectiveRunWorkbook.js`, following the
`exportElectiveRun.js:11` precedent exactly: builds sheets as arrays-of-arrays and writes every one
through `aoaToSanitizedSheet` (`src/utils/exportSanitize.js`) — camper names, activity names, and
choice labels are all user-controlled strings and must not bypass the formula-injection sanitizer.
Sheets: Child Schedules (one row per camper × span/linked-unit, using the same clustering as the
JSON child-schedule export so the two artifacts cannot disagree), Activity Roster, Exceptions,
Summary. No new sanitizer, no `XLSX.utils.aoa_to_sheet` call anywhere in this new file outside
`aoaToSanitizedSheet`.

### 6. Migration posture and tripwire

Per the owner's standing pre-production preference: **no migration shim for pre-v76 snapshot
data.** A `final` run that was finalized under v74 has snapshot rows lacking `cell_kind`/
`choice_id`/`is_linked_choice` meaning — those rows never captured inherited cells or linked-choice
identity because that capability didn't exist yet. Re-deriving that meaning from a v74 snapshot
would require guessing at data that was never recorded (was this row from a template read or an
assignment? we cannot know after the fact for a legacy row). The correct action for an existing
`final` run under this design is: **flip it back to `draft` and re-finalize**, which re-runs
`finalizeElectiveRun.js` against the *current* template/assignments and writes a fresh, complete
v76 snapshot. This repo has no live camps on this run type yet (pre-production), so no migration
shim, no backfill script, and no dual-read compatibility path are built for this bump — matching
the `v66`/`v74` precedent of accepting a clean cutover when nothing has captured real data yet.

**Migration guard form** (per this repo's standing gotcha): `getSchemaVersion(db) >= 74 &&
getSchemaVersion(db) < 75`, not a bare `< 75` — a bare upper bound would re-run this block against
every older schema version that reaches this line, exactly the bug this repo has been bitten by
before.

**Tripwire.** A new migration test file, `electron/db/electiveRunOuterInheritance.migration.test.js`,
modeled directly on `electron/db/electiveRunLifecycle.migration.test.js`'s v74 file:
- `expect(CURRENT_SCHEMA_VERSION).toBe(76)` (not just `getSchemaVersion(db)` — the `.toBe(N)`
  literal tripwire this repo has been bitten by omitting before).
- `expect(cols).toEqual([...11 v74 columns..., 'cell_kind', 'choice_id', 'is_linked_choice'])` on a
  fresh install.
- The fresh-vs-migrated `tableInfo` equality test, replicated for v76 exactly as the v74 file does
  for v74 (build a pre-v76 db by dropping the three new columns from a fully-migrated db, run
  `initSchema` forward, assert identical `table_info` to a fresh install).
- A rollback file `electron/db/rollback/v76_down.js` (mirroring `v74_down.js`) that drops the three
  columns and the `schema_migrations` row — non-destructive to the base v74 columns/table, since
  this bump is purely additive.

## Symmetry argument

`deriveElectiveRunOuterRows(db, run)` is the **only** function that decides a run's outer-schedule
rows, for both cell kinds, unchanged in that respect from today. `getElectiveRunOuterScheduleHandler`
(draft path) calls it directly. `finalizeElectiveRun.js` (finalize path) calls it directly, at the
same point in the same transaction it already called it before this change, and writes every field
the call returns — including the three new ones — into the snapshot. There is no second
inheritance-reading code path, no second span-collapsing implementation, and no second
linked-choice-detection query anywhere in this design. Re-deriving a run live (draft branch) and
reading back its snapshot (final branch, immediately after finalizing, before any template edit)
therefore produce identical rows by construction, because both branches are the same function call
against the same inputs at the same instant — exactly what
`electiveRunOuterSchedule.integration.test.js` already asserts and must continue to assert
unmodified. `clusterLinkedElectiveRows` runs downstream of both branches identically (it is a pure
function of the rows array, called by export builders regardless of which branch produced those
rows), so it cannot introduce asymmetry either.

The one intentional divergence this design does NOT introduce, and must not: computing span length
for inherited cells from `activities.span_blocks` on one branch and from the derived contiguous-run
count on the other. Both branches call the same derivation, so this cannot happen — but it is
called out explicitly because it is the shape of mistake that would silently reintroduce the exact
defect T248's governor refused to ship.

## Exit clauses discharged

- **Child schedules combine inherited + elective cells** — discharged (§1, §4 extended
  `exportChildSchedule.js`).
- **Activity rosters, inverse projection, no second table** — discharged (§4).
- **Exceptions: unresolved/unassigned/unranked/stale/capacity** — discharged (§4).
  **Eligibility/resource** — **not discharged**; flagged below.
- **Summary** — discharged (§4).
- **New JSON `format_version: 1` contract, existing group-schedule contract untouched** — the
  ticket's own JSON contract (roster/exceptions/summary, if bundled into one document) should adopt
  its own `format_version: 1` the same way `exportElectiveRun.js` and `exportChildSchedule.js` each
  independently did; `exportChildSchedule.js`'s own contract moves to `format_version: 2` for its
  shape change (§4) — `exportScheduleJson.js:43` is untouched, matching the ticket's explicit
  instruction.
- **XLSX, sanitized** — discharged (§5).
- **Multi-block activity and linked choice each render as one span/unit** — discharged (§1 span
  collapsing, §2 linked-choice clustering), and kept as two distinct mechanisms per the brief's
  instruction not to conflate them.
- **Finalized run's export survives a later template edit** — discharged (§3: inherited cells are
  snapshotted, not re-read from `template_slots`, on a final run).
- **No staff-reachable path** — discharged (§4: zero new IPC actions; existing negative test
  requires no change).
- **Migration posture: no shim, hard cutover** — discharged (§6).
- **Schema tripwire** — discharged (§6).

## Open Questions for Governor

1. **Camper universe** for inheritance (§1): this design uses preferences ∪ visible-assignments.
   Confirm this matches product intent for "the run's campers," or supply the narrower/wider
   definition if one exists elsewhere (e.g., an explicit run-scope table not found during this
   design pass).
2. **Eligibility and resource exceptions** (§4): no existing computed source was located for
   either category. Needs a product-level definition (what makes an assignment "ineligible" or
   "resource"-flagged in this run shape) before Maker can build them; do not let Maker guess.
3. **Whether the bundled roster/exceptions/summary JSON is one combined document or three separate
   `format_version: 1` contracts** — this design assumed three separate builder functions (mirrors
   the existing one-concern-per-file convention) but did not receive a ruling on whether the ticket
   wants them merged into a single exported JSON file for staff. Either is compatible with this
   schema design; it only affects the export-builder file count, not the v76 bump.
