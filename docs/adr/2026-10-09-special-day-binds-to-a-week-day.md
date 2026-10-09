---
title: "A special day binds to a (week, day) through a placement row and replaces that day's schedule on both routes"
document_type: adr
authority: normative
status: accepted
implementation_state: not-started
date: 2026-10-09
decided: 2026-10-09
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
supersedes: []
amends:
  - docs/adr/2026-08-23-override-family-model.md (the 2x2: special_days is no longer "fully detached" - it now binds to a (week, day); the interior/flat axis is unchanged)
  - docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md (D3b/v34 "undated standalone object" - a special day is still not itself dated, but it can now be placed)
implements: [docs/work/tickets/T350-special-day-week-day-binding.md]
related_adrs: [docs/adr/2026-08-02-schedule-weeks-first-class.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md]
---

# A special day binds to a (week, day) through a placement row

**Revision note (Red Hat accuracy FAIL, 2026-10-09; decision unchanged).** Ten corrections, each verified in
code before being written: the engine mechanism (D4: the first draft's "five callers of resolveWeekCatalog"
was a transitive graph count, the direct call sites are three and two engine entries bypass it), the soft
reference (D1), the real Automerge write model and the unbind-vs-rebind case (D5), the genesis consequence
(D3), the restore and duplicateWeek decisions (D8), stats/findings on retained rows (D4), the complete
registration list (D10), the exporter names (D7), and four edge cases (D11).

## Decision of record (owner, 2026-10-09, audit #31)

> "A special day gets a date/day picker and replaces that day's schedule in the week."

Today a special day has a name, a sort order and notes, and nothing in the engine or the schedule
screens reads it (v34 shipped it deliberately undated). This ADR decides how it becomes placeable.

## Context (verified in code, 2026-10-09)

- Weeks are `schedule_weeks` rows: director-named text ("Week 1"), no date column. Days are camp-wide
  `days_of_operation` rows (Mon..Sun, deterministic id `day:<campId>:<dow>`), shared by every week. The
  coordinate of "a day in the week" the data model already has is **(schedule_week_id, day_id)**.
  There is no calendar date anywhere a week could be resolved to one.
- A camp holds two candidate schedules per week (Manual, Generated; `schedule_templates` keyed
  `(week_id, kind)`), neither canonical (plural-candidates ADR). Slots live in `template_slots`
  keyed by template, so anything per-route is the wrong place for a week-level fact.
- The engine does **not** have one week-aware entry today. Verified by grep, 2026-10-09:
  `resolveWeekCatalog()` has exactly **three direct call sites**: `generate()` and `placeFixedEvents()` in
  src/screens/schedule/useGeneration.js, and `computeFindings()` in src/engine/buildSchedule.js, which only
  calls it inside `if (fixedEvents && fixedEvents.length > 0)` and only for the fixed-event duplicate loop
  (UNDERSERVED/DISTRIBUTION read the raw `days`). The manual route's `computeFindings` call
  (useGeneration.js, after a manual placement) passes **no** `fixedEvents` and **no** `weekId`.
  `recalcFindings()` (useScheduleData.js) and `restoreSnapshot()` (useSnapshots.js) reach it only through
  `computeFindings`. Two engine entries bypass it entirely: the headless `buildSchedule(...)` in
  scripts/mcp/tools.js (validate route) and `assembleScheduleEngineInputs` in
  electron/ops/scheduleEngineInputs.js. `buildSchedule()` is `weekId`-aware but never filters `days` or
  pre-placements by week. A design that hangs the change on `resolveWeekCatalog` would therefore silently
  miss the manual route, the MCP validator and the findings loops.
- Day Overrides (a `(week, day, group, block)` render-time diff) existed and were removed at v59 (T145)
  on the owner's reasoning "either it's a special event, or you replace it on the grid". This ADR is the
  second half of that sentence. It reuses the *composition lesson* of the retired design (render-time,
  route-agnostic, flags computed after substitution), not its table.
- A special day OWNS its own time blocks and its own group x block grid (special_day_time_blocks,
  special_day_slots) and carries free-text notes. It is reusable by design (2026-08-20 D3b: "build Color
  War once and reuse/print it for years").

## Candidate approaches considered

Divergence here was run as written reasoning over five frames (regulator, 3am on-call, competitor-
breaking-it, remove-the-load-bearing-assumption, $0/1-hour); no parallel sub-agents were spawned, because
the live design space is small and the candidates below are what the frames converged on. Say so if you
want the full `adhd` fan-out re-run.

| # | Approach | Key assumption | Verdict |
|---|---|---|---|
| A | Two columns on `special_days` (`schedule_week_id`, `day_id`) | a special day is used once | Rejected. One-to-one by construction contradicts the documented "reuse for years" intent; two special days on the same (week, day) is representable and nothing structural prevents it, so conflict handling becomes a render-time tie-break. Cheapest migration, wrong shape. |
| **B** | **Placement table `special_day_placements`, one row per bound (week, day), deterministic id from `(week_id, day_id)`, mutable field `special_day_id`** | the (week, day) slot is the scarce thing, not the special day | **Chosen.** |
| C | Calendar `date` on the special day or placement | weeks map to dates | Rejected. No week has a date; adding one drags in a week-start-date concept, DST/locale rendering, and a second source of truth for "which day is Tuesday of Week 2". Reconsider only if the owner wants printed dates. |
| D | Put the special day on the main grid as an `events`-style cell in `template_slots` (event_id pattern) | the day is just a very wide event | Rejected. Per-route storage means two copies of a week-level fact, and it re-opens the 2x2 (override-family ADR) the owner settled 2026-08-23. |
| E | A generic `week_day_state` table (closed / special / half-day...) | more day states are coming | Rejected as speculative (karpathy). One state exists; the table in B is already the extension seam. |

**Why B over A (the real trade):** B costs one more table and one more registration surface than A. In
exchange the *key* of the row is the uniqueness rule, so "two special days on one day" cannot exist as two
rows, and "one special day on two days" is simply two rows. Both of those were the owner-facing conflict
questions and B answers them structurally rather than with a tie-break.

## Decision

### D1 - Shape: `special_day_placements`

New table (schema **vN** — the next free version at implementation time; see D3, additive `CREATE TABLE IF NOT EXISTS`, no ALTER of any existing table):

| column | notes |
|---|---|
| `id TEXT PRIMARY KEY` | **deterministic** `deriveSpecialDayPlacementId(weekId, dayId)`, built with the `opaque()`/`join()` convention in electron/ops/electiveDerivedIds.js (week and day ids contain colons, so a naive `a:b` join is ambiguous). |
| `week_id TEXT NOT NULL REFERENCES schedule_weeks(id)` | hard FK, same as `week_activity_exclusions`; the parent that scopes the row to a camp. |
| `day_id TEXT NOT NULL` | **soft** reference to `days_of_operation` (no SQL REFERENCES): days are deterministic camp-wide rows and a placement whose day later disappears is ignored at resolution, not a constraint failure. |
| `special_day_id TEXT NOT NULL` | **soft** reference to `special_days` (no SQL REFERENCES), for the same reason as `day_id` and to be consistent with D4.7 ("an orphan is tolerated, never thrown"): a hard FK would make a placement that syncs in before its special day (or after the special day's delete on another device) a projection failure instead of a no-op. The one mutable field; this is where a cross-device clash lives. |

No `template_id`, no `kind`, no route anything: the binding is a fact about the week and is therefore
**route-agnostic by construction**, so Manual and Generated both see it and neither is designated
(CLAUDE.md "Two routes, two candidate schedules"). No UNIQUE index is declared: the primary key already is
the uniqueness rule, and the repo's T241 program removed inline UNIQUEs precisely because a UNIQUE on
random-id rows turns a cross-device duplicate into a failed projection.

### D2 - Where it lives: category B (WHERE_DATA_LIVES), Automerge document first

An ordinary camp entity: `appendOp` -> SQLite + `operations`, then the Automerge document; SQLite is the
projection. Registered exactly like `week_activity_exclusions` (parent-scoped: `parentTable:
'schedule_weeks'`, `parentKey: 'week_id'`) so it reuses the flat `doc[entity][row_id]` shape and the
existing projector. It is **not** SQLite-only and not host-local. Hard-FK parents are inserted by
`ensureExists` following the "reconstruct then insert once all fields are known" pattern used by
`ensureWeekJoinRow` (electron/ops/projections.js).

### D3 - Migration (vN, guard form, schema:check family)

- `localDb.js`: `CURRENT_SCHEMA_VERSION` (N-1) -> N; block guarded **`getSchemaVersion(db) >= N-1 && < N`**,
  never a bare `< N` (standing guard-form gotcha). Executes the same DDL text as schema.sql via a
  `SPECIAL_DAY_PLACEMENTS_DDL` constant; schema.sql and the constant are asserted byte-identical by a
  `specialDayPlacements.migration.test.js` (precedent: specialDays.migration.test.js).
- `electron/db/rollback/vN_down.js` (+ test): `DROP TABLE special_day_placements`. Lossless for every
  other table; loses only bindings, which is stated in the file header. Descending-order guard applies.
- Any change under electron/db/** requires `npm run schema:check` before push. Also bump the doc-fact
  markers (schema version, entity count 36 -> 37 in WHERE_DATA_LIVES) in the same PR.
- **Genesis (a stated consequence, not a footnote).** `special_day_placements` is a new document collection,
  so it must be added to `GENESIS_ENTITIES` in electron/automerge/campDocument.js and `GENESIS_B64`
  regenerated by the recipe in that file's comment (this is the **fifteenth** regeneration; the fourteenth is
  T331), with the pinned-head assertion in campDocument.test.js updated to the new head and the
  `GENESIS_ENTITIES`-vs-`MODELED_ENTITIES` completeness assertion kept green (never fix that by editing
  the list alone). Consequence: the shared genesis root hash changes, so **every already-paired device
  re-pairs** and an existing `.automerge` file is discarded, exactly as at each prior regeneration.
  Acceptable only because the app is pre-production with no live camps; this ADR names it so no reviewer
  has to discover it. If another in-flight ticket also regenerates, the two must be sequenced so the
  second regenerates on top of the first's entity list (one head, not two).
- A freshly-created column order question does not arise (new table, free order, fixed in the DDL).
- **Version collision risk:** v91 is already claimed twice (#772 / T311 pending-tables drop; #762 / T348). N is chosen only when slice 1 starts, after #772 lands (expected v92), re-checked against #762 and every local worktree. Re-check `origin/main`'s
  `CURRENT_SCHEMA_VERSION` and open PRs at Slice 1 start; renumber the guard if it moved.

### D4 - Engine interaction: apply replacements at the engine entries, not at the callers

Mechanism: a pure module `src/engine/effectiveDays.js` exporting
`resolveEffectiveDays({ days, placements, weekId })` -> `{ days, replacedDayIds }` (placements filtered to
this week, ignoring any whose `day_id` is not in `days`) and
`dropReplacedPreplaced(preplacedSlots, replacedDayIds)`. The two engine entry points
**`buildSchedule()` and `computeFindings()` accept `replacedDayIds` and apply it themselves, once, at
entry**: filter `days`, filter every pre-placement, and use the filtered `days` for every loop including
UNDERSERVED/DISTRIBUTION. Callers only resolve and pass `replacedDayIds`. This replaces the first draft's
"extend `resolveWeekCatalog`": that function stays what it is (a catalog filter), and its early return
(no exclusions) is left alone because it no longer carries days. (If a reviewer prefers it to carry them,
it must return `days`/`replacedDayIds` on **every** path including the early return, and
`computeFindings` must read them outside the `fixedEvents.length` branch; the engine-entry design makes
both unnecessary.)

Every entry point and how it receives `replacedDayIds` (each is pinned by one test; a table-driven
`engineEntryReplacedDays.test.js` enumerates them and fails if a new `buildSchedule(`/`computeFindings(`
call site appears that is not in the table):

| Entry | File | Receives it from |
|---|---|---|
| `generate()` | src/screens/schedule/useGeneration.js | the screen's loaded placements via `resolveEffectiveDays` |
| `placeFixedEvents()` | src/screens/schedule/useGeneration.js | same |
| manual-route `computeFindings` after placement | src/screens/schedule/useGeneration.js | same (this call has no `fixedEvents`/`weekId` today; replacement must not depend on them) |
| `recalcFindings()` | src/screens/schedule/useScheduleData.js | `ctx.replacedDayIds` |
| `restoreSnapshot()` | src/screens/schedule/useSnapshots.js | same |
| `computeFindings()` internal fixed-event loop | src/engine/buildSchedule.js | its own `replacedDayIds` argument, independent of `fixedEvents` |
| MCP validate route | scripts/mcp/tools.js | `assembleScheduleEngineInputs` |
| headless inputs | electron/ops/scheduleEngineInputs.js | gains `dayPlacements` and returns `replacedDayIds` beside `days` |

Consequences, each pinned by a test:

1. Nothing is generated on a replaced day. Manual builds nothing up front; its replaced day is simply not
   a drop target (D6).
2. **Pre-placements are filtered by `replacedDayIds`.** `buildSchedule` Pass 1 places every
   `preplacedSlots` entry (`place(act, pre.groupId, pre.dayId, ...)`) and fills `electiveLookup`/
   `eventLookup` for any day, without consulting `days`. So the filter is applied to **all** callers' lists:
   `lockedPreplaced`, `electivePreplaced`, `eventPreplaced` in useGeneration.js, and the three families in
   scripts/mcp/tools.js. **Required failing test first:** a locked activity whose stored slot sits on a
   replaced day must not be placed, must not consume that group's same-day count, and must not occupy its
   location in capacity accounting.
3. Findings are computed against effective days in **all** loops. `UNDERSERVED` and `DISTRIBUTION` iterate
   the raw `days` today (`days.findIndex(...)` at the prefer_before_day check), so this is an engine change,
   not a pass-through. A min_per_week goal is judged by what was actually placed on the days that run.
4. **`prefer_before_day` on a replaced day must show, not vanish.** `targetIdx = days.findIndex(d =>
   d.day_of_week === act.prefer_before_day)` returns -1 once the day is filtered out and the existing code
   does `continue`, silently dropping the goal. When the target day is in `replacedDayIds` the loop instead
   emits a `DISTRIBUTION` finding with a distinct reason ("Goal: N before <day> cannot be met - <day> is
   replaced by <special day>"), severity `info`, so it appears in the rail. Test: goal on a replaced day
   yields that finding; goal on a normal day is unchanged.
5. **Stats and the rail use the same filtered view.** `recalcStats(slotList)` (useScheduleData.js; ~9 call
   sites in useSlotMutations.js, useSnapshots.js, useScheduleData.js, ScheduleScreen.jsx) counts open and
   filled over whatever list it is handed, so retained hidden rows would inflate both. `recalcStats` and
   `recalcFindings` take `replacedDayIds` as a required second argument, and a guard test fails on any
   one-argument call. The dismissal rail and per-slot flags (UNFILLABLE etc.) are derived from the
   post-filter `slots` list (D6), so hidden rows cannot appear in them; dismissal keys for a replaced day's
   findings are inert and reappear correctly if the day is unbound.
6. **Non-destructive.** Stored `template_slots` for a replaced day are retained, hidden at render.
   `generate()` writes a whole-template bulk replace, so it **carries forward** the existing rows of replaced
   days into its payload. Carry-forward rows pass through the same dead-reference guard
   `restoreSnapshot` uses before `restoreSnapshotRows` (src/screens/schedule/useSnapshots.js, "Restore-time
   reference guard"): a row whose activity, group or time block no longer exists is dropped rather than
   written back dangling. Unbinding therefore restores what the director had, minus anything that has since
   ceased to exist.
7. An orphan placement (week differs, `day_id` not in `days`, or `special_day_id` not resolving) means no
   replacement: the normal day shows and nothing throws.

### D5 - Conflicts (against the real document model)

The document is **flat and per-field**: `doc[entity]` is a single map whose keys are
`<entity_id><FIELD_DELIM><field>`, one LWW register per field (`applyOneWriteInto`,
electron/automerge/campDocument.js). There is no per-record container. A delete is a sweep of every key
with that `entity_id` prefix plus provenance markers. This changes the analysis in three ways.

| Case | Behaviour |
|---|---|
| Two devices bind **different** special days to the same (week, day) offline | Same derived id, so the same three keys. `week_id` and `day_id` are written identically by both (no clash); `special_day_id` is two concurrent writes to one register: Automerge picks a deterministic winner and the loser stays visible via `getConflicts`, which the existing machinery turns into a `conflicts` row for `resolveConflict`. Until resolved the winner renders, with an unresolved-conflict marker on the day. |
| **Concurrent creation of the same derived id** | **Not a risk in this model**, and the first draft's worry about object-level insert collisions does not apply: there is no object to collide. Two creations are just identical writes to `week_id`/`day_id` and a possible clash on `special_day_id`, handled above. |
| One special day bound to two days or weeks | Two rows. Deleting the special day cascades both. |
| Same-device bind to an occupied (week, day) | A replace, not a conflict: write the existing id's `special_day_id`. The prompt names how to undo it (D11). |
| **Unbind on A vs rebind on B (the real hazard)** | A's delete removes every key for the id. B concurrently sets `special_day_id`. After merge, `week_id` and `day_id` are gone and `special_day_id` survives: a **partial row**. |

Rule for partial rows (defined, not left to chance):

1. **Bind always writes all three fields** (`week_id`, `day_id`, `special_day_id`) in one atomic unit
   (`runAtomic`), including on a rebind of an existing id. A concurrent rebind therefore re-creates a
   complete row, and the merged result is "bound", i.e. add-wins over a concurrent unbind. That is the
   deliberate semantics: a director who just bound a day should not have it vanish because another device
   unbound it a moment earlier. The unbinding director sees the day become bound again.
2. A row missing any of the three fields is **incomplete and is skipped by the projector without a
   `projection_failures` row** (an explicit completeness check in `ensureExists`/the projector pass for this
   entity, using the `knownRow` the projector already supplies), and the resolver ignores it (D4.7). It is
   not an error and not rendered. It can only arise from a non-bind writer or a future bug, never from the
   bind path.
3. **Required test** (`specialDayPlacements.concurrent.test.js`): two documents forked from one state;
   doc A unbinds, doc B rebinds to a different special day; merge both directions; assert identical
   convergence, a complete row with B's `special_day_id`, and that SQLite projection matches. A second case:
   A unbinds, B only edits an unrelated record, so the row is gone on both. A third: the partial-row input
   projects nothing and records no failure.

### D6 - Rendering (both routes, same result)

A pure `resolveDayReplacements({ days, placements, specialDays, specialDayTimeBlocks, specialDaySlots, weekId })`
returns `Map<dayId, { specialDay, blocks, cellsByGroup, notes }>`. It is applied in the ScheduleScreen
`slots` pipe **before** `withWeekClosureFlags`/`withOverlapFlags` (the one ordering lesson of the retired
override design): slots on a replaced day are removed first, so OVERLAP and WEEK_CLOSED never evaluate
hidden cells. Both routes call the same function with the same inputs; there is no per-route branch and no
remembered preference.

- Group view (one group, all days): the replaced day's column shows that group's cells from the special
  day, laid out on the **special day's own time blocks**, labelled with the special day's name, read-only,
  with one link to open the special day to edit it.
- Day view (all groups, one day): the replaced day renders the special day's grid (its blocks x groups)
  and its notes, read-only, same link.
- Not a drop target, no fill handle, no inline editor. Edits happen in the special day, one place.
- Activity drilldown ignores the replaced day.
- **UI-significant, so DESIGN_STANDARD binds this design.** The replaced lane is a new view state with a
  visible transition, and the bind/unbind/replace actions have async and error states. Per section 5
  (motion and feedback) each of those write actions shows pending, success and failure feedback, and per
  section 8 (transitions) the grid shows the swap between a normal day and a replaced day as a state
  change, not a pop. Reduced motion is never *no* feedback: with `prefers-reduced-motion` the same states
  are conveyed by a static label change plus the existing status text, no movement. New ephemeral cell
  state is a data attribute plus a `scheduleGrid.css` rule (the scoped exception), not React state. A
  Designer pass precedes Slice 3's code. Per owner convention it is shown with a flag or inline label,
  never a banner.

### D7 - Export

Reconciled with the real files. The schedule exporters that print a week are **`exportToExcel`**
(src/utils/exportSchedule.js, called from ScheduleScreen's export handler) and **`buildScheduleExport`**
(src/utils/exportScheduleJson.js). Both receive the resolved replacements and print the special day's grid
(its own blocks x groups) and its notes in place of the normal day, identically for whichever route the
director chooses at export time (the route choice is not remembered; unchanged).
`exportScheduleRoundTrip.test.js` gains a replaced-day case. **`exportWorkbook`** (src/utils/exportWorkbook.js)
is the camp-setup worksheet used for the import round trip (`PLAN_VERSION`, `shoresh_id`), not a schedule
export, and special days are never ingestible (2026-08-20 D3b), so it is deliberately **not** changed.
The camp-data record, `buildCampDataWorkbook` (src/utils/buildCampDataWorkbook.js, entity list in
electron/campDataRecord.js), already has a Special Days sheet; it gains a "Placed on" column listing
its (week, weekday) placements, read-only and not part of any round trip.

### D8 - Undo, history, unbinding, restore

Binding and unbinding are `appendOp` writes (bind: three field writes in one `runAtomic`; unbind: a
delete), so they are in the device-local history ledger and entity history. **Restore decision:
`special_day_placements` is REFUSED in `UNRESTORABLE` (electron/ops/restore.js), with the reason "refused:
rebuilt by binding the special day again, or by duplicating the week"**, matching the three
`week_*_exclusions` entries there. Rationale: a restore of a deleted placement could resurrect a binding
over a day someone has since bound to a different special day, and re-binding is one action. The user-facing
undo of a replace or unbind is therefore the ledger-level history entry plus re-binding, and the prompt says
so (D11). Cascades: `deleteWeek` removes a week's placements (children-before-parents, in its documented
order); `deleteSpecialDay` removes its placements; the ingest teardown lists `special_day_placements` in
`PARENT_SCOPED_DEPENDENTS` (electron/ops/ingest.js) so a week cleared by import cannot be blocked by its
placement rows. **`duplicateWeek` copies placements using the derived id for the NEW week**
(`deriveSpecialDayPlacementId(newWeekId, dayId)`), never `randomUUID()` (which `duplicateWeek` uses for the
exclusion rows it copies), and writes all three fields; otherwise the copy would carry a random id and
break the one-row-per-slot rule. Unbinding is one action on the special day and one on the replaced lane;
neither destroys the day's stored slots (D4.6).

### D9 - Interface contract check (org-interface-contracts)

- Idempotency: bind = set `special_day_id` on a derived id, so a retry or double-click applies once;
  `client_write_id` rides the existing appendOp path.
- Concurrent retries: converge by key (D5); no double-apply possible because there is only one row.
- Unknown outcome: bind/unbind re-read the row; a retry after a dropped write is a no-op or the same write.
- Error shape: new IPC `bindSpecialDay` / `unbindSpecialDay` return the codebase's existing
  `{ ok:false, reason }` write-failure shape and every failure is surfaced in the UI (standing rule).
- Authority: both go through `authorize()` with a new permission pair added to electron/auth/permissions.js
  (schedule-adjacent: same role floor as editing a week's exclusions); camp scope enforced by the week's
  `camp_id`; a foreign-camp `special_day_id` is refused at the handler.
- Trust boundary: a placement arriving by sync is validated by the projector like any other row; an
  unknown `special_day_id` is tolerated (D4.7), never thrown.

### D10 - Registration surface (complete list, each grep-verified as a place a week-scoped entity is named)

Slice 1/2 touch all of: electron/ops/projections.js (fields, `ensureExists`, completeness check),
electron/ops/campScopedEntities.js (`PARENT_SCOPED_ENTITIES`: parent `schedule_weeks`, key `week_id`),
electron/automerge/campDocument.js (MODELED_ENTITIES via the registry, `GENESIS_ENTITIES`, `GENESIS_B64`),
electron/automerge/projector.js, electron/auth/permissions.js, src/localClient.mock.js,
electron/ops/undoReferences.js, electron/ops/restore.js (refusal, D8), electron/ops/deleteWeek.js,
electron/ops/deleteSpecialDay.js, electron/ops/duplicateWeek.js, **electron/main.js `SCOPED_LIST_ENTITIES`**
(so the renderer can `listByScope('special_day_placements', weekId)`), **electron/ops/ingest.js
`PARENT_SCOPED_DEPENDENTS`**, **src/data/scheduleRepository.js** (load a week's placements beside its
exclusions, `bindSpecialDay`/`unbindSpecialDay`), electron/campDataRecord.js and
src/utils/buildCampDataWorkbook.js (D7), recordLabels. **electron/ops/mergeActivity.js is checked and
unchanged**: its list is entities that hold an `activity_id`, and a placement references a week, a day and
a special day, not an activity. A parity test (the existing PROJECTIONS-vs-MODELED_ENTITIES diff plus an
explicit list-membership test for `SCOPED_LIST_ENTITIES` and `PARENT_SCOPED_DEPENDENTS`) pins the list.

### D11 - Edge cases (each gets a defined behaviour and a test)

1. **Every day of a week replaced.** The week has no normal days. Group and day views render only replaced
   lanes; the engine receives `days = []`, `generate()` returns an explicit "Every day this week is a
   special day, so there is nothing to generate" message (a flag-style inline notice, not a banner), writes
   nothing, and does not throw on an empty `days`.
2. **A special day with no time blocks.** Its lane renders an explicit empty state ("No schedule yet -
   open <name> to add one") with the edit link, never a blank column; export prints the name and notes and
   an explicit "no schedule" line.
3. **Carry-forward rows with dead ids** pass the restoreSnapshot reference guard (D4.6).
4. **The replace prompt names its undo:** "Week 2 Tuesday already uses Color War. Use Visiting Day instead?
   (Color War stays saved; bind it again to undo.)" - matching the restore decision in D8.

## Consequences

- **Positive.** The product gap closes with no engine rewrite: a small change at the two engine entries, one new table, one pure
  resolver. Reuse of a special day across weeks works. The cross-device clash is a first-class `conflicts`
  row instead of silent last-write-wins. Unbinding is lossless.
- **Costs.** A genesis regeneration (D3): every paired device re-pairs; accepted pre-production. One table = the full registration surface (projections, campScopedEntities, campDocument,
  projector, permissions, mock client, undoReferences, restore, cascades, recordLabels) and the schema:check
  family. A replaced day changes goal arithmetic (D4.3). Group view must display a column whose rows are a
  different time-block structure than its neighbours, which is the one genuinely hard UI problem.
- **Reversibility.** Additive table, lossless rollback of everything else (vN_down). The semantic choice
  (week, day) over calendar dates is the part that is expensive to reverse; see confidence.
- **Not a canonical-schedule decision.** The binding names no route. Nothing here picks a schedule.

## Confidence and evidence

- Table-not-columns (B over A): **0.75.** Evidence: the documented reuse intent, the T241 history of UNIQUE
  collisions, and `week_activity_exclusions` as an exact structural precedent. What would change it: the
  owner saying a special day is single-use, which makes A a smaller migration.
- (week, day) over calendar date: **0.85.** Evidence: no week has a date in schema.sql; every existing
  week-scoped fact keys on `(week_id, day_id)`.
- Engine-entry choke point (D4): **0.75.** Evidence: grep shows exactly two engine entries (`buildSchedule`,
  `computeFindings`) and eight call paths, pinned by an enumerating test. The first draft's 0.8 rested on a
  transitive graph count and is withdrawn.
- Unbind-vs-rebind rule (D5, add-wins): **0.7.** The mechanism is verified in `applyOneWriteInto`; the
  product semantics (rebind beats a concurrent unbind) is a judgement the two-document test makes visible.

## Open questions for the owner

1. Can one special day be placed on more than one day (for example Visiting Day in every week)? The design
   allows it and the recommendation is yes; if you say no, it becomes a one-line check in the bind action.
2. Do printouts need real calendar dates ("Tue, July 8"), or is "Week 2 - Tuesday" enough? The
   recommendation is week and weekday only. Dates would need a start date on each week and are a separate
   ticket; nothing here blocks adding them.

Defaults decided here without asking: replacing keeps the old day's schedule intact and restorable; a
duplicated week keeps its special-day placements; a half-day takeover is not a special day (use an Event,
per the override-family ADR).
