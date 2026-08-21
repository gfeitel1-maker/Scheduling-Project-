---
title: 2026-08-21-special-day-author-ui-design
document_type: spec
status: draft
created: 2026-08-21
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md]
related_tickets: [docs/work/tickets/T106-special-day-author-ui.md, docs/work/tickets/T40-one-day-special-event-schedule.md]
archive_when: T106 ships and merges; the screen/IPC described here matches the merged implementation
---

# Special Day author UI — design (T106)

This is the design pass for the ADR's D1 "single construction surface," built on the shipped v34
`special_days` data shape. It is a design doc, not code — it hands Red Hat and Maker a concrete,
file-cited plan with no further architectural judgment calls needed.

## Candidate approaches considered

The one genuinely open architectural call in this ticket is **how much of the existing weekly
`ScheduleScreen` machinery to reuse for the special-day grid**. Divergent exploration (`adhd`,
hardware-engineer / 3am-on-call / game-designer frames) surfaced these distinct shapes:

- **A — Route the special-day grid through `ScheduleScreen.jsx` itself** (a third `route` value
  alongside `manual`/`generated`). Rejected: `ScheduleScreen.jsx` is 1357 lines and its co-located
  hooks (`useSlotMutations`, `useUndoRedo`, `useOverlayFillStamp`, `useClipboardSelection`,
  `useContentRaceFlag`) are saturated with route/span/elective/engine/flag logic a special day
  explicitly has none of (per spec: no spans, no electives, no engine, no `UNFILLABLE`/`OVERLAP`).
  Threading a third route through that file multiplies its branching for a strictly simpler case —
  the wrong direction for a file already flagged as the app's most complex.
- **B — Build a special-day-specific grid from scratch** (new cell components, new geometry math).
  Rejected: research confirms `SlotCell.jsx`, `EmptyCell.jsx`, `CellInlineEditor.jsx` are *already*
  fully generic — they take a plain `slot` object and caller-supplied callbacks
  (`onPlace`/`onCreateNew`/`onCellClick`), with zero reference to `schedule_templates`/
  `template_slots` anywhere in any of the three files. `gridPlacement.js` and `gridTracks.js` are
  pure functions over `(blockIndex, columnIndex)`/`timeBlocks` — no week-specific coupling either.
  Rebuilding this layer would duplicate already-generic, already-tested code for no reason.
- **C — Reuse the generic leaf/geometry layer inside a new, lean, special-day-only screen; do not
  touch `ScheduleScreen.jsx` or its hooks (chosen).** Matches the hardware-engineer frame's "leanest
  circuit": SlotCell/EmptyCell/CellInlineEditor as leaf renderers, gridPlacement/gridTracks for
  layout math, `scheduleGrid.css` for styling — wired up by a new, much smaller container component
  that owns only `special_day_slots` state and simple field writes. No undo/redo, no clipboard, no
  content-race detection, no merge/span UI — those props on `SlotCell` (`onMergeDown`, `hasMergeDown`,
  `isMerged`, `rowSpan`, `pasteMode`, etc.) are simply never passed, which the components already
  default to off (`rowSpan=1`, `isMerged` undefined→falsy, etc.), so nothing needs stripping out.
- **D — A grid built from `<table>` + native `<select>` per cell (the `DayOverridesScreen.jsx`
  pattern: checkbox+select flat list, not a true `SlotCell` grid).** Rejected as the primary shape:
  it is simpler to build but throws away the inline-create-activity interaction (`CellInlineEditor`'s
  typeahead + create-new, which the ticket explicitly requires reusing) and the visual grid layout a
  director already recognizes from the weekly screen. Noted only as a fallback if C proves to need
  disproportionate new code in Red Hat/Maker review — it should not.

**Chosen: C.** It is the smallest responsible design: it reuses everything that is already
data-shape-agnostic and builds only what is genuinely new (a lean container, not a grid engine).

## Approach

### 1. Standalone single-day schedule surface

A special day's grid is `groups` (columns, reused live from the camp) × `special_day_time_blocks`
(rows, owned by the special day) → `special_day_slots` cells (`activity_id`/`location_id`,
nullable). This is exactly the v34 data shape — no new entity, no new column.

### 2. List screen + grid editor

**List screen** (`src/screens/SpecialDaysScreen.jsx`, new): a flat CRUD list over `special_days`
(`id, camp_id, name, sort_order`), directly analogous to the other seven setup screens. Use
`useCrudScreen` (`src/hooks/useCrudScreen.js:15-139`) for the list itself — its
`{ rows, loading, error, adding, add, save, deleteAll, reload }` surface fits a flat camp-scoped
table with no opinion on child-grid editing (its own header comment says as much), which is exactly
the split this screen needs: `useCrudScreen` for `special_days` rows, hand-rolled state for the grid
editor, matching how `DayOverridesScreen.jsx` already splits "parent list" from "child editor
modal/screen."

Each list row: name, edit action (opens the grid editor), delete action (confirms, then calls the
new `deleteSpecialDay` IPC — see §6).

**Create flow**: "New Special Day" prompts for a name, writes the `special_days` row
(`buildCreateFields` per `useCrudScreen`'s contract), then immediately offers **seed time blocks
from the camp's `time_blocks`** — a one-shot copy: read the camp's `time_blocks` rows and write an
equivalent `special_day_time_blocks` row per camp time block (`name`, `sort_order`, `start_time`,
`end_time` copied verbatim, new minted ids). This is a plain client-side loop of ordinary field
writes through the existing generic write path — **not** a new storage relationship, matching the
spec's explicit "convenience copy, not a storage branch" (`special-days-data-shape-design.md:84-89`).
A director can decline seeding and start with zero time blocks, adding them one at a time (see next).

**Grid editor** (`src/screens/specialDay/SpecialDayGridEditor.jsx`, new, or a `specialDay/` subfolder
mirroring `screens/schedule/`): the special day's own time blocks (rows) × the camp's groups
(columns). Per-row controls to add/rename/reorder/remove a `special_day_time_blocks` row (simple
inline text inputs + up/down or drag reorder — no need for a separate time-block editor screen,
matching the "leanest circuit" frame). Cells render via `EmptyCell`/`SlotCell` (empty vs filled),
passing:
- `groupId`/`dayId` (special-day id, reusing the prop name; there is no real "day" concept here so
  the special day's own id fills that slot)/`blockId` (the `special_day_time_blocks.id`)
- `onPlace(slot, activityId)` → write `special_day_slots.activity_id`
- `onCreateNew(slot, name)` → `createActivityFromCell(name, { groupId, dayId, blockId })`
  (`src/screens/schedule/useSlotMutations.js:1026`) reused as-is — it already only depends on
  `{ groupId, dayId, blockId }` shape + a `repo`, not on `schedule_templates`. The grid editor's own
  "place" step then needs one extra write (`special_day_slots.activity_id = newActivityId`) since
  `createActivityFromCell`'s existing "then places it" step calls `placeActivityManual`, which is
  `schedule_templates`-specific — **do not reuse that inner placement call**; call the special-day
  slot writer directly with the returned activity id instead. This is the one seam that needs a thin
  adapter, not a fork of the whole function.
- `eligibleActivities` = the camp's full activity list (no route/tier/eligibility filtering — a
  special day has no eligibility engine)
- location: a simple `<select>` of the camp's `locations` next to/below the cell, writing
  `special_day_slots.location_id`. (`SlotCell`'s existing location affordances, if any, can be reused
  if trivial; otherwise a lightweight sibling control is acceptable — this is a Designer-owned polish
  call, not an architectural one.)

No merge/span/elective props are passed — `SlotCell`'s existing defaults (`rowSpan=1`,
`isMerged`/`hasMergeDown` undefined) mean this "just works" without modification to the component.

### 3. Component reuse (the key call)

| Layer | File | Reuse |
|---|---|---|
| Cell rendering | `src/components/schedule/SlotCell.jsx`, `EmptyCell.jsx`, `CellInlineEditor.jsx` | **Reused unmodified.** Already generic. |
| Grid geometry | `src/screens/schedule/gridPlacement.js`, `gridTracks.js` | **Reused unmodified.** Pure functions. |
| Grid styling | `src/components/schedule/scheduleGrid.css` | **Reused unmodified.** Generic class selectors; per the file's own scope comment this is exactly the kind of consumer it's meant to serve. |
| Inline activity create | `src/screens/schedule/useSlotMutations.js:1026` `createActivityFromCell` | **Reused with one adapter seam** — see above; the activity-minting half is reused, the placement half is not (it's `schedule_templates`-specific). |
| Screen orchestration | `ScheduleScreen.jsx` + its hooks (`useUndoRedo`, `useOverlayFillStamp`, `useClipboardSelection`, `useContentRaceFlag`) | **Not reused.** None of these concerns exist for a special day in this slice (no undo/redo per the "throwaway, delete-the-day" model; no overlay stamps; no clipboard; no content-race — single small grid, low edit volume). |
| List CRUD | `src/hooks/useCrudScreen.js` | **Reused for the parent list only.** |
| List+editor split precedent | `src/screens/DayOverridesScreen.jsx` | **Pattern reused** (parent list + separate child editor), code not shared (its editor is a flat checkbox list, not a `SlotCell` grid). |

This keeps the special-day grid genuinely simpler than the weekly one, as the ticket anticipates: no
routes, no engine, no spans/merges, no electives — while inheriting the interaction the ticket cares
most about (typed inline activity creation) with essentially no new grid-rendering code.

### 4. Record/print notes (ADR D2)

Add `notes` (TEXT, nullable) to `special_days`. **This is a schema field addition to an already-v34
table, decided in the ADR (D2) — flagged in §"ADR required" below for why it doesn't need a new
migration-worthy ADR of its own.** Render as a single controlled `<textarea>` on the list-item edit
view or a "Notes" tab on the grid editor screen, following the exact existing pattern in
`src/screens/ActivitiesScreen.jsx:447-449` and `src/screens/AnchorsScreen.jsx:185` (plain
`useState` + `onChange` + inclusion in the same per-field write call as every other field on that
screen). No shorthand parsing, no structured sub-fields — per the ADR's explicit trigger ("only when
a concrete downstream behavior must read a field"), which this design doc does not introduce.

### 5. Navigation/routing

- `src/App.jsx` `SCREENS` map: add `specialdays: SpecialDaysScreen` alongside the existing
  `dayoverrides: DayOverridesScreen` entry (`src/App.jsx:31-63`).
- `src/components/layout/navSections.js`: add `{ key: 'specialdays', label: 'Special Days', area:
  'specialdays', optional: true }` to the `setup` section's `items` array (same shape as the
  `dayoverrides` row at line 47), and add a `specialdays: 'special_days'` entry to `AREA_TABLE`
  (lines 80-89) so the sidebar's completion mark counts against the right table.
- The grid editor is reached by clicking a row in the list screen — it can be a client-side
  sub-view of `SpecialDaysScreen` (an `editingId` state, no new `SCREENS` entry needed) rather than
  its own routed screen, consistent with how `DayOverridesScreen` opens its editor as a modal rather
  than a route. Recommend a **full sub-view, not a modal** — a groups×time-blocks grid needs the
  width a modal doesn't comfortably give; this is a Designer call to confirm, not blocking Maker.

### 6. IPC surface

**Field writes** (special_days name/sort_order/notes; special_day_time_blocks name/sort_order/
start_time/end_time; special_day_slots activity_id/location_id): route through the **existing
generic per-field write path** (`localClient.write(token, entity, id, field, value)` →
`electron/main.js`'s generic write handler → `electron/ops/projections.js`'s `ensureExists`, already
registered for all three tables per the shipped v34 design). **No new per-entity IPC methods needed
for ordinary field writes** — this is already-built plumbing; T106's IPC work is additive, not new
machinery.

**Delete cascade** (the one genuinely new IPC surface): wire the existing
`electron/ops/deleteSpecialDay.js:26-55` (`deleteSpecialDay(db, { specialDayId }, { author_user_id,
device_id })`, already transactional, already tombstones children-before-parent via `appendOp`) to:
- `electron/main.js`: a new IPC handler, e.g. `deleteSpecialDay`, calling the existing function —
  thin wiring only, the cascade logic itself needs no changes.
- `electron/preload.js`: expose `deleteSpecialDay` on the `window.shoresh` bridge.
- `src/localClient.js` **and** `src/localClient.mock.js`: add a `deleteSpecialDay(specialDayId)`
  wrapper to both — the mock parity requirement the codebase has been bitten by before
  (`src/localClient.mock.specialDays.test.js` already exists per the research pass and should be
  extended to cover the delete path, not just create/read).

Rejected as unnecessary machinery for this slice (surfaced by the 3am-on-call divergence, then
pruned): a soft-tombstone-then-sweep delete (the op-log delete *is* already the tombstone — this
codebase's delete model doesn't do two-phase deletes anywhere else, and inventing one here for a
low-stakes pre-production feature is exactly the over-engineering `karpathy-guidelines` warns
against); a dry-run/preview endpoint before delete (no other delete path in the app has one; a
"Delete this special day? — N time blocks, M slots will be removed" confirm dialog string, computed
client-side from already-loaded state, gets the same director-facing safety for free); per-write
idempotency keys beyond what the op-log already provides (writes are already field-level with
`client_write_id`-based idempotent retry per the existing sync model — this is inherited for free by
reusing the generic write path, not something this slice needs to add).

One idea from the 3am-on-call divergence worth keeping as a **cheap, non-architectural addition**:
grid-cell writes should be logged with a human-readable one-line summary in whatever debug logging
`electron/ops/projections.js` writes already carry (if that pattern exists elsewhere) — flag to
Maker as a nice-to-have, not a requirement.

### 7. Terminology

No centralized strings/glossary module exists yet in this codebase (confirmed by search — no
`glossary`/`terminology` file under `src/`). Per the ticket's dependency note, the peer's glossary
ADR may not have landed by the time T106 starts. **Recommendation:** define the screen's user-facing
strings ("Special Days", "Notes", seed-prompt copy, delete-confirm copy) as named exports at the top
of `SpecialDaysScreen.jsx`/`SpecialDayGridEditor.jsx` (a local `const LABELS = { ... }` object), not
inline JSX literals scattered through the render tree. This costs nothing architecturally and makes
a later glossary-ADR swap a find-and-replace inside one object per file rather than a hunt through
JSX. Do not invent a cross-screen strings module for this ticket alone — that would be building
infrastructure for a decision (the glossary ADR's shape) that hasn't landed yet.

## Files/modules affected

**New:**
- `src/screens/SpecialDaysScreen.jsx` — list screen (uses `useCrudScreen`)
- `src/screens/specialDay/SpecialDayGridEditor.jsx` — grid editor sub-view
- (possibly) `src/screens/specialDay/useSpecialDaySlots.js` — small hook for grid state + field
  writes, kept intentionally thin vs. `useSlotMutations.js`'s 1300+ lines
- `electron/main.js` — one new IPC handler wiring `deleteSpecialDay`
- Tests: `SpecialDaysScreen` characterization test, grid editor test, `deleteSpecialDay` IPC test,
  `localClient.mock` delete-path parity test

**Modified:**
- `src/App.jsx` — `SCREENS` map entry
- `src/components/layout/navSections.js` — sidebar item + `AREA_TABLE` entry
- `electron/preload.js` — expose `deleteSpecialDay`
- `src/localClient.js`, `src/localClient.mock.js` — `deleteSpecialDay` wrapper
- `electron/db/schema.sql` + migration — add `notes TEXT` to `special_days` (see migration note
  below)
- `electron/ops/projections.js` — extend `special_days`' field list to include `notes` if the
  projection enumerates fields explicitly (check against current v34 registration)

**Not touched:** `ScheduleScreen.jsx` and its hooks; `SlotCell.jsx`/`EmptyCell.jsx`/
`CellInlineEditor.jsx`/`gridPlacement.js`/`gridTracks.js`/`scheduleGrid.css` (used, not modified);
`electron/ops/deleteSpecialDay.js` (used as-is); `buildSchedule.js` (special days are authored-only,
per spec, never touched by the engine).

## Reused vs. new

**Reused:** the entire generic grid leaf/geometry/styling layer (§3 table); the generic per-field
write IPC path; `createActivityFromCell`'s activity-minting half; `useCrudScreen` for the parent
list; the `DayOverridesScreen` list+editor split pattern; the plain-textarea notes pattern from
`ActivitiesScreen`/`AnchorsScreen`; the already-shipped v34 schema/sync/permissions/mock
registration (no changes needed there except the `notes` column).

**New:** the list screen and grid editor components themselves (thin containers, not a grid engine);
the seed-from-camp-time-blocks copy action; the `deleteSpecialDay` IPC wiring (three files, no logic
change); the `notes` column; the adapter seam between `createActivityFromCell`'s minting step and
special-day-specific placement (since the function's built-in placement call is
`schedule_templates`-specific and must not be reused for this table).

Nothing in this design needs a genuinely new grid-rendering primitive — the "missing" gap identified
in the ADR (author UI + IPC + render) is smaller than the ADR's total-page-count treatment might
imply, largely because the grid-rendering layer was already built generic for the weekly screen.

## Test seams

- **Grid editor unit tests**: cell create/place/clear round-trips against a stubbed `special_day_slots`
  repo, mirroring existing `SlotCell`/`EmptyCell` interaction tests already in the schedule test
  suite (reuse test patterns, not necessarily test code).
- **List screen**: characterization test for create/rename/delete-list-row, following the pattern of
  the other `useCrudScreen`-based setup screen tests (e.g. `DaysScreen.test.jsx` if one exists —
  Maker should confirm the closest existing precedent at implementation time).
- **Seed action**: a test asserting seeding copies `time_blocks` rows into
  `special_day_time_blocks` with new ids and no ongoing link (mutating the camp's `time_blocks`
  afterward must NOT affect the already-seeded special day — this is the "convenience copy, not a
  storage branch" invariant and is the single highest-value assertion in this slice).
- **`createActivityFromCell` adapter seam**: a test proving the special-day flow does **not** call
  `placeActivityManual` (or otherwise touch `schedule_templates`) — this guards the one seam flagged
  above as needing care, and is exactly the kind of thing Red Hat should be pointed at explicitly.
- **`deleteSpecialDay` IPC**: an integration test that the IPC handler → op-log path produces the
  same cascade (children-before-parent tombstones) as the existing unit test
  (`electron/ops/deleteSpecialDay.test.js`) already proves for the bare function — i.e. the new test
  is "does IPC correctly call the existing verified function," not a re-verification of cascade
  correctness.
- **Mock parity**: extend `src/localClient.mock.specialDays.test.js` to cover the delete path
  (currently, per research, it covers create/read/delete of rows generically but should be checked
  against whether it exercises the *cascade* specifically once `deleteSpecialDay` is wired).
- **Permissions**: staff can create/edit/notes-write; delete remains admin-only, per
  `electron/auth/permissions.js`'s existing `special_days`/`special_day_time_blocks`/
  `special_day_slots` registration (already shipped in v34 — confirm the new IPC handler for delete
  is gated the same way the generic delete path already is, not a new permission rule).

## Migration implications

**Expected: none for the core tables** — v34 shipped with `special_days`/`special_day_time_blocks`/
`special_day_slots` already migrated, projected, synced, and permissioned. The only schema change
this design introduces is **one additive column**: `special_days.notes TEXT` (nullable, no default
needed beyond NULL). This is a small additive migration (v35, or whatever the next open version is
— check `electron/db/schema.sql` current `getSchemaVersion()` at implementation time since other
in-flight work, per PLATFORM_STATE, has also been bumping schema version), following the same
pattern as every other additive-column migration in this codebase (mirroring the v30/v31 rollback
precedent the data-shape spec itself cites). `deleteSpecialDay`'s IPC wiring is new plumbing, not a
schema change.

## ADR required: no

This is slice 2 of the work the ADR (`docs/adr/2026-08-20-special-days-authoring-and-day-override-
repoint.md`) already ratified as D1 ("build the author-UI follow-on... already scoped") and D2 (the
notes field, including its storage recommendation and structure-trigger). Nothing in this design
introduces a new persistent data shape beyond the one additive `notes` column the ADR already named,
changes a contract other modules depend on, or makes an irreversible tradeoff — it is an
implementation plan for a decision already recorded. The `notes` column addition is exactly the kind
of small additive migration the ADR anticipated ("Migration: Special Days needs none (v34 shipped)"
plus D2's already-decided storage choice) and does not independently clear the ADR bar (constitution:
new persistent shape *other code will depend on*, a changed existing contract, or a non-obviously-
reversible tradeoff — an optional nullable text column nothing else reads yet is none of those).

## Open questions for Governor

1. **Modal vs. full sub-view for the grid editor** (§5) — this design recommends a full sub-view for
   width, but it's a product/UX call, not a technical one; confirm with Designer before Maker
   commits to a layout.
2. **Location affordance per cell** — whether to extend `SlotCell` with a location control or add a
   lightweight sibling control is a small UI decision that affects whether `SlotCell.jsx` itself
   needs a (backward-compatible, opt-in) prop addition. Recommend Designer decide during the design
   pass that follows this doc; flagging here so Maker doesn't have to guess mid-implementation.
3. **Glossary timing** — if the terminology-unification ADR from the `camp-setup-ingestion` peer
   lands before Maker starts, Maker should pull the ratified terms directly rather than using this
   doc's placeholder strings ("Special Days", "Notes", etc.); if it lands after, the `LABELS` object
   pattern (§7) makes the swap contained. No blocking decision needed now — noting the dependency so
   it isn't lost between this doc and the Maker brief.
3. **Schema version number for the `notes` column** — depends on what else has landed on `main` by
   implementation time; Governor/Maker should read `getSchemaVersion()` fresh rather than hardcoding
   v35 here.

## Governor decisions on open questions (2026-08-21)

1. **Full sub-view, NOT a modal.** The special-day grid is groups × its-own-time-blocks — too large for a
   modal, and a full SCREENS-routed sub-view matches how every other schedule grid renders. The list
   screen and the grid editor are both full views (list → open one → grid editor sub-view).
2. **Keep the shared SlotCell PURE — do NOT add a location-control prop to it.** A special-day cell needs
   an activity + optional location; the weekly SlotCell has no per-cell location (locations live on
   activities there). Handle the per-cell location affordance in the SPECIAL-DAY cell layer (a thin
   wrapper/editor around the reused leaf), so the shared component stays uncoupled. Exact affordance is a
   Designer call (see Designer pass).
3. **Glossary:** centralize all user-facing strings so they swap when the terminology ADR lands; not
   blocking. Proceed.
