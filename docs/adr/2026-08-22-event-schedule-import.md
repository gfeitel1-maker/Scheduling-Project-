---
title: "Grid-schedule import — shared parser, consumer 1 (events) built now"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-22
approved: 2026-08-22 (owner — pivot away from a global reconciliation-pipeline event detector, to "surface it globally, build it locally": global upload only creates an empty nested-schedule container; a shared parser populates its detail on the container's own screen. This ADR pins the technical model and the shared/consumer split.)
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_specs:
  - docs/adr/2026-08-22-events-overlay-placement.md
  - docs/adr/2026-08-22-event-internal-subschedule.md
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
  - docs/work/specs/2026-08-22-event-schedule-import-slices.md
archive_when: this ADR's Consumer 1 (events) ships, or the shared parser is superseded
---

# Grid-schedule import — shared parser, consumer 1 (events) built now

## Context

Two nested-schedule containers now exist under one general shape: a
director creates the container once, places it on the campwide schedule as
an opaque cell (`elective_sets`/`events` → `template_slots`), and
separately fills in what's *inside* it:

- **Events** — `docs/adr/2026-08-22-event-internal-subschedule.md` (Slice
  2) shipped `event_time_blocks`/`event_groups`/`event_slots`, an editable
  2D grid authored by hand through
  `src/screens/event/EventGridEditor.jsx`.
- **Electives** — `elective_sets`/`elective_set_activities`
  (`docs/adr/2026-08-22-nested-schedules-electives-and-events.md` §2), a
  flat list of member activities a director builds by hand on
  `ElectivesScreen` (or its equivalent authoring surface).

Both are currently hand-built only. A director who already has the detail
as a document — a Sports Day grid, a color-war sheet, a chugim/electives
roster — has no way in but retyping it.

An earlier proposal routed this through the global upload/reconciliation
pipeline (`src/screens/ImportScreen.jsx` → `extractEntities` →
`ReconciliationScreen`), the same pipeline that proposes camp-wide
`groups`/`activities`/`time_blocks`. The owner rejected it and set the
governing shape instead: **"surface it globally, build it locally."**
Global upload may only *surface* a nested-schedule container — propose an
elective period or an event cell, created **empty** — and must never
reconstruct its internal detail. The detail is built on the container's
own screen, by hand or by importing a file **there**, where the import is
explicit, scoped to one container, and lands in a surface the director
already treats as the review step.

This ADR designs that capability as **one shared, reusable parser** with
**per-consumer populate logic** — not an events-only feature — because the
same file shape (a grid: a time axis, a group/column axis, activity cells,
an optional location key) is what both consumers need to read, and only
what each does with the *result* differs.

### Reconciling with "authored, not reconstructed"

`electron/ops/durableElectiveSets.js` (line ~9) states electives are
"authored, never reconstructed from a file," extended by the events ADRs
to cover event internals generally. This feature **does** reconstruct
structured detail from a file, and that is not a violation — the
invariant is narrower than "no file may ever populate a container." Read
against its own purpose:

- **What it forbids**: the **global reconciliation pipeline** silently
  manufacturing structured detail (elective membership, event station
  plans) from an **ambiguous** upload, across the **whole camp**, where
  the director did not point at a specific target and may not review
  every row it produced.
- **What this feature is**: a director opens **one specific container**
  (one event, one elective set), clicks an **explicit** "import this
  schedule from a file" affordance, uploads **one file** they know is that
  container's own document, and the result lands in the **same editable
  surface** they already use to hand-build it. No separate confirm/triage
  screen, no silent commit — every row the parser produces is exactly as
  editable and exactly as visible as one the director typed.

Deliberate + per-container + scoped + editable-after is authored. Silent +
global + ambiguous is what the invariant exists to prevent. This import
never touches `ReconciliationScreen`, `buildPlan.js`, or the camp-wide
lanes/triage machinery, for either consumer.

## Decision

### 0. Two layers: shared parse, per-consumer populate

```
file (.xlsx/.pdf-text/.txt)
        │
        ▼
existing file→grid extraction (REUSED, unchanged)   ← §1
        │  { title, columns, rows: [{ label, cells }] }  (one or more pages)
        ▼
parseGridSchedule(pages)  — NEW, SHARED, pure           ← §2
        │  { orientation, timeAxis[], groupAxis[], cells[], locationKey?, unmapped[] }
        ▼
   ┌────────────────────────┬─────────────────────────────┐
   │ populateEventGrid(...)  │ populateElectiveSet(...)     │
   │ CONSUMER 1 — BUILD NOW  │ CONSUMER 2 — NAMED, NOT BUILT │
   │ → event_time_blocks/    │ → elective_set_activities     │
   │   event_groups/         │   (distinct activities from   │
   │   event_slots           │   the cell set — one axis,    │
   │                         │   not the 2D grid)             │
   └────────────────────────┴─────────────────────────────┘
```

The shared layer knows nothing about `event_*` or `elective_*` tables. It
turns a page (or pages) into a **normalized grid** — two labeled axes plus
cells, each cell already resolved to a matched-or-created activity and an
optional location. Everything table-shaped is the consumer's job.

### 1. Reuse the existing file→grid extraction, unchanged

Traced the live ingest pipeline (`src/screens/ImportScreen.jsx` lines
~190–230), reused as-is by the shared parser:

- **xlsx/xlsm/xls** → `XLSX.read` → `XLSX.utils.sheet_to_json(ws,
  {header:1, blankrows:false, defval:'', raw:false})` per sheet →
  `workbookToPages` (`src/ingest/sheetGrid.js`). `sheetToPage` already
  excel-decodes time serials (`excelSerialToTime`), finds the header row,
  strips trailing empty columns, and returns `{ title, columns: string[],
  rows: [{ label, cells: string[] }] }`. Byte-for-byte reusable.
- **txt/pdf-extracted-text** → `parseTextGrid`
  (`src/ingest/textGrid.js`) → same `{ title, columns, rows }` shape.
- **Size/complexity guardrails**: `assertImportFileSize` /
  `assertWorkbookComplexity` (`src/utils/exportSanitize.js` lines
  ~55–86, `IMPORT_LIMITS`) run before/after `XLSX.read`. Reused verbatim.

Not reused: `extractEntities.js` (`detectOrientation`, `extractEntities`
proper). It solves **days vs. groups** across a possibly-multi-page,
camp-wide corpus, feeding the `INGESTIBLE_ENTITIES` whitelist. This
parser solves **time vs. group/column** for a single container's own
document (typically one page, occasionally a grid page plus a location-key
page). Different axis, different target shape, different (much smaller)
scope — see "Reused vs. new" for why adapting `extractEntities` in place
was rejected.

**Flag for Maker**: `sheetToPage` assumes the label axis is column 0. A
grid with time as the *column* axis (header row = times, first column =
group/grade-band) still parses fine through `sheetToPage` — `columns` =
times, `row.label` = group — because orientation is read downstream (§2),
same as the campwide pipeline's own design.

### 2. New shared module: `src/ingest/parseGridSchedule.js`

```
parseGridSchedule(pages) → {
  orientation: { axis: 'rows-are-time' | 'columns-are-time', confident: boolean },
  timeAxis: [{ name, start_time, end_time, sourceLabel, sourceIndex }],
  groupAxis: [{ name, sourceLabel, sourceIndex }],
  cells: [{ timeIndex, groupIndex, activityName, locationName }],
  unmapped: [{ sourceExcerpt, reason }],
}
```

Pure. No entity/table knowledge, no writes, no `campId`/`eventId`/
`electiveSetId` parameter — those belong to the consumer layer (§3, §4).

- **Orientation** is a time-name majority test on each axis's labels —
  the import analogue of `detectOrientation`'s day-name test: a header
  token matches a time-like pattern ("9:30", "9:30-10:10", "9:30 AM") at
  ≥0.6 of that axis (mirrors `isDayHeader`'s threshold). Whichever axis
  clears it is `timeAxis`; the other is `groupAxis`. Neither axis
  clearing it → `confident: false`, `timeAxis`/`groupAxis`/`cells` empty
  — no guess is committed (§5).
- **Time-range parsing** ("9:30-10:10" → `start_time`/`end_time`) reuses
  the `\d{1,2}[:.]\d{2}` shape `extractEntities.js`/`textGrid.js` already
  use for `looksLikeTime`/`stripTimes`. If not already exported, promote
  the regex to a shared export rather than duplicating the pattern
  (`codebase-design`) — verify exports at Maker time.
- **Cell activity text** reuses `cleanCellValue` (exported from
  `extractEntities.js`) — handles the same "time leaked into the cell" /
  repeated-word noise this file shape produces.
- **Location key**: when a second page (or a clearly separate section) maps
  activity name → place name ("WHERE TO GO"), each cell's `locationName`
  is filled by majority vote per activity name — reimplement the ~10-line
  tally locally (same idea as `extractEntities.js`'s
  `activityLocationVotes`, not imported — coupling this module to
  `extractEntities`'s internals for one small helper isn't worth it).
  Detecting *which* page is the location key vs. the schedule grid is an
  open product question — see Open Questions §2.
- **Zero rows, or zero confident orientation** → returned with empty
  `timeAxis`/`groupAxis`/`cells` and `orientation.confident: false`; the
  consumer decides how to surface that as a failure (§5) — the shared
  parser never throws for "this wasn't a grid," only for programmer-error
  inputs (e.g. `pages` not an array).

This output contract is designed so Consumer 2 (electives) is a **trivial
future adoption**: the distinct-activity list an elective set needs is
`[...new Set(cells.map(c => c.activityName))]` filtered through the same
create-if-new matching (§3) — no second parse, no second orientation
detector, nothing about `parseGridSchedule` changes when that consumer is
built.

### 3. Activity matching: shared helper, reused by both consumers

`src/screens/schedule/createActivityHelper.js`'s `createActivity({ name,
campId, activities }, repo)` already does "match by `normalizeName`,
create-if-new with full provenance defaults" — the same helper the weekly
grid, elective creation, and the special-day adapter share (T105/T106).
Both consumers call it once per distinct `activityName` the parse
produced, threading their own `repo.writeActivityFields` shim (Consumer 1
reuses `EventGridEditor.jsx`'s existing shim, lines ~55–60 verbatim; a
future Consumer 2 would build the equivalent for whatever repo it writes
through). No new activity-create path, and this call happens in the
*consumer* layer, not in `parseGridSchedule` — the shared parser returns
`activityName` strings, never activity ids, keeping it free of any
`campId`/db dependency.

Location matching (Consumer 1 only, in this slice): `locationName` is
looked up in the event's already-loaded `locations` list by
`recognitionKey('locations', name)` — `locations` is the one entity keyed
trim-only/case-sensitive (`preview.js`), not `normalizeName`. No location
is created by import; a `locationName` with no match is reported in the
consumer's own `unmapped` surfacing (§5.3), not silently dropped. A
future Consumer 2 has no location column on `elective_set_activities` at
all, so it simply never reads `cells[].locationName`.

### 4. Consumer 1 — events (BUILD NOW): `populateEventGrid`

Lives in `src/screens/event/EventGridEditor.jsx` (or a small colocated
helper it imports) as the glue between `parseGridSchedule`'s output and
the three Slice-2 tables:

- `timeAxis[i]` → `event_time_blocks` row (`name`, `start_time`,
  `end_time`).
- `groupAxis[j]` → `event_groups` row (`name`).
- `cells[]` → `event_slots` row (`activity_id` from §3's match/create,
  `location_id` from §3's location match).

**Deterministic ids**, mirroring `EventGridEditor.jsx`'s own
`deriveEventSeedId(eventId, axis, sourceId)` (lines ~46–53, itself modeled
on `electron/ops/locationId.js`'s `deriveLocationId`, INV-1: two devices
performing "the same" mutation from the same inputs must mint
byte-identical ids, or the op-log converges on duplicate rows instead of
one):

```
deriveEventImportId(eventId, axis, sourceSignature)
  = `event-import:${eventId}:${axis}:${sourceSignature}`
```

- `event_time_blocks` row: `sourceSignature = timeAxis[i].sourceIndex`
  (position after orientation resolution, **not** the raw label text, so
  a whitespace/casing difference between two exports of the "same" file
  doesn't mint a second row).
- `event_groups` row: `sourceSignature = groupAxis[j].sourceIndex`.
- `event_slots` row: `sourceSignature = `${timeIndex}:${groupIndex}``
  (composite, mirrors `event_slots`' own natural key).

This makes a **re-import of the byte-identical file** (retry after a
crash, or a second device importing the same document before syncing)
converge on the same rows instead of duplicating — the class of bug
T85/the `deriveEventSeedId` comment both call out. It does **not** make
two *different* files converge on the same rows, which is correct (§6).
Newly-created activities are excluded from this id scheme (§3) — matched
by name on next read, not by position.

This idempotency is narrower than "re-import is safe": it holds only when
the source file's rows/columns are in the SAME positions as the prior
import. Editing the file between imports — inserting a row, reordering a
column, deleting a period — shifts `sourceIndex` for everything after the
edit, so a naive re-import against the same event would orphan the old
positional rows rather than update them in place. We do not attempt
content-addressed convergence across an edited file; that is out of
scope here. In practice this gap is closed by §6's refuse-on-nonempty
gate, not by the id scheme: because import is only offered when the
event's schedule is empty, the supported path for importing an EDITED
file is **Clear schedule** (the control added alongside this feature) →
empty grid → fresh import, not an in-place re-import over stale
positional ids.

Writes go field-at-a-time via the existing `writeField` helper
(`EventGridEditor.jsx` lines ~37–44), same as every other Slice-2 write —
per `docs/adr/2026-08-22-event-internal-subschedule.md` §3,
`event_slots`/`event_groups` are deliberately **not**
`BULK_REPLACE_ENTITIES`-registered, and this import does not change that;
it is authored cell-by-cell like every other write this screen makes, just
looped over the parsed cells instead of one click at a time.

### 5. Error handling — fail closed, write nothing (both consumers)

Three failure classes, surfaced by the consumer, all writing zero ops
when they fire:

1. **Not a parseable grid at all** (`pages.length === 0`, or the parser's
   one page has no rows past a header) — reuse the message shape
   `ImportScreen.jsx` already uses: "No schedule could be read out of
   that. It may be a scan rather than a document with text in it."
2. **Orientation not confident** (`parseGridSchedule`'s
   `orientation.confident === false`) — "Couldn't tell which side of this
   file is the schedule's times. Check that the file has a clear time
   column or time row, and try again." Nothing written.
3. **Partial parse** (confident orientation, some cells/locations
   unmapped) — **not** a failure. Confidently-parsed rows are written;
   `unmapped` entries surface in a small post-import summary ("3 cells
   couldn't be matched to a location — you can fill those in below"),
   mirroring T36's "residual" transparency posture in
   `sheetGrid.js`/`extractEntities.js`. The container's own editable
   surface is the review step — no separate confirm screen, consistent
   with "authored, not reconstructed" above.

Every write goes through `writeField`/`describeWriteFailure` — a failure
mid-import surfaces the same way Slice 2's existing seed logic already
does (`EventGridEditor.jsx` lines ~139–141, ~156–158), never a bare catch.

### 6. Import into a non-empty container: **refuse, direct to clear first**

Considered: silent replace, cell-level merge (fill only empty
cells/slots), refuse outright.

**Decision: refuse** when the container already has content — for events,
any `event_slots` row with non-null `activity_id`; for a future electives
consumer, any existing `elective_set_activities` row. Show: "This
[event's schedule / elective set] already has entries. Clear it first if
you want to replace it with an import, or add to it by hand." No merge,
no silent overwrite.

Rationale: a cell-level merge silently privileges the file over whatever
the director already typed, based only on which cells happen to be
empty — the kind of silent reconstruction "authored, not reconstructed"
warns against, reintroduced through a side door. A silent full replace is
worse (destroys hand-edits with no confirmation). Refuse-and-direct costs
one extra click but never surprises the director.

Import is therefore available only when the container is empty of
authored content. For events, the existing first-open seed
(`EventGridEditor.jsx` lines ~105–159, which pre-populates
`event_time_blocks`/`event_groups` from the camp's current defaults) is
not a conflict — the nonempty check is against `event_slots.activity_id`,
not against whether seeded (empty) rows/columns exist. Import writes its
own rows at the ids from §4 alongside any seeded ones; seeded empty rows
are not deleted (harmless; see Non-goals for a deferred "replace seed axis
on import" refinement).

### 7. Affordance placement (Consumer 1)

`EventGridEditor.jsx`'s existing empty state (`LABELS.emptyBlocksTitle` /
`emptyBlocksBody`, "No time blocks yet. Add your first block and group to
start building this schedule.") gets a second option: "or import this
event's schedule from a file." Both paths lead to the same populated,
fully-editable grid. No second grid component — reuses `EventCell`,
`gridTracks`, `gridPlacement` exactly as they already render hand-authored
cells.

### 8. Consumer 2 — electives (NAMED, NOT BUILT): shape for the record

Not built in this slice. Documented so the shared parser's boundary is
provable, not just claimed:

- Input: the same `parseGridSchedule(pages)` output — an electives roster
  document (a chugim sheet) is a grid exactly like a Sports Day sheet:
  periods (or a single "electives" pseudo-axis) by activity-offering
  columns, or a simple list.
- `populateElectiveSet` would read only `cells[].activityName` (ignoring
  `timeIndex`/`groupIndex`/`locationName` — an elective set is a flat
  membership list, not a 2D grid) — `[...new Set(cells.map(c =>
  c.activityName))]` — run each through the same `createActivity` match
  (§3), and write one `elective_set_activities` row per distinct activity
  (`elective_set_id`, `activity_id`, `camper_headcount: null`).
  Deterministic id would follow the same shape: `elective-import:
  ${electiveSetId}:${activitySourceIndex}` (position of first occurrence
  in `cells`).
  the same nonempty-refuse rule (§6) applies against
  `elective_set_activities` rows.
- This requires **zero changes** to `parseGridSchedule` or to §3's
  activity-matching helper when it's eventually built — confirming the
  shared/consumer split is real, not aspirational.

**Addendum (Code Reviewer, electives slice shipped):** the built consumer
(`src/ingest/electiveSetPopulate.js`) keys the deterministic id on the
RESOLVED `activity_id` — `deriveElectiveImportId(electiveSetId, activityId)`
— not on the `activitySourceIndex` sketched above. Deliberate improvement:
a flat membership set has no meaningful cell position, and keying on the
resolved activity id converges both a byte-identical re-import AND a
different file naming the same activities onto the same row, instead of
depending on cell order matching across files.

## Files/modules affected

- **New**: `src/ingest/parseGridSchedule.js` — `parseGridSchedule(pages)`
  (pure, shared), local `activityLocationTally` helper.
- **New**: `src/ingest/parseGridSchedule.test.js` — orientation detection
  both ways, time-range parsing, activity/location mapping, unmapped
  reporting, empty/degenerate input.
- **New**: `src/ingest/eventGridPopulate.js` (or colocated in
  `EventGridEditor.jsx` if small enough — Maker's call, per
  `codebase-design`'s deep-module guidance, keep it out of the component
  if it grows past a screenful) — `deriveEventImportId`,
  `populateEventGrid(parsed, { eventId, campId, existing... }, repo)`.
- **New**: `src/ingest/eventGridPopulate.test.js` — id determinism across
  re-parse, activity create-if-new, location match/unmapped, nonempty
  refuse.
- **Changed**: `src/screens/event/EventGridEditor.jsx` — import
  affordance in the empty state; a `runImport(file)` handler wiring
  `parseGridSchedule` → `populateEventGrid`; the `unmapped` summary
  surface (§5.3).
- **Reused, unchanged**: `src/ingest/sheetGrid.js` (`workbookToPages`,
  `sheetToPage`), `src/ingest/textGrid.js` (`parseTextGrid`),
  `src/utils/exportSanitize.js` (`assertImportFileSize`,
  `assertWorkbookComplexity`), `src/ingest/extractEntities.js`
  (`cleanCellValue`, exported — imported, not copied),
  `src/ingest/preview.js` (`normalizeName`, `recognitionKey`),
  `src/screens/schedule/createActivityHelper.js` (`createActivity`,
  `newActivityDefaultFields`), `electron/db/schema.sql`
  (`event_time_blocks`/`event_groups`/`event_slots` — no schema change).
- **Not touched**: `src/screens/ImportScreen.jsx`,
  `src/ingest/buildPlan.js`, `ReconciliationScreen` (or equivalent
  triage), `electron/ops/ingest.js`, `electron/main.js`'s
  `shoresh:ingest-*` IPC handlers. No IPC handler added or needed — file
  reading (`file.arrayBuffer()`/`file.text()`, `XLSX.read`) and parsing
  are pure renderer-side JS today, and stay renderer-side here, for both
  consumers.
- **Not built this slice**: `elective_set_activities` populate wiring,
  any `ElectivesScreen` import affordance — see §8.

## Reused vs. new

**Reused**: the entire file→tabular-grid extraction layer
(`sheetToPage`/`workbookToPages`/`parseTextGrid`), size/complexity
guardrails, `cleanCellValue`, `normalizeName`/`recognitionKey`,
`createActivity`, and every existing Slice-2 write path (`writeField`,
`describeWriteFailure`, grid rendering components). No new grid UI, no new
activity-matching logic, no new IPC surface, no schema change.

**New, and why nothing existing covers it**: `parseGridSchedule`'s
time-vs-group/column orientation detector and its normalized
`timeAxis`/`groupAxis`/`cells` output — a deliberately different, smaller
shape than `extractEntities.js`'s days-vs-groups detector and
`INGESTIBLE_ENTITIES` whitelist, which is tuned for a camp-wide,
multi-page corpus feeding flat camp tables. Adapting `extractEntities` in
place would mean threading a second orientation axis and a second
target-table set through code that already carries real complexity for
its actual job — see the ADR's own §1 note. `deriveEventImportId` is new
because `deriveEventSeedId` is keyed by a *pre-existing camp entity id*
(the seed's source); import rows have none, so position-in-parsed-source
is the closest stable substitute (§4). The shared/consumer split itself
(§0) is the one genuinely new architectural idea here — everything below
it is composition of existing pieces.

## ADR required: yes

Filed at `docs/adr/2026-08-22-event-schedule-import.md` (this document).
Meets the bar on three counts: it introduces a new write pattern into an
existing schema (bulk-minted `event_time_blocks`/`event_groups`/
`event_slots` rows via a new deterministic-id scheme,
`deriveEventImportId`) that future code (a re-import affordance, a "clear
and re-import" control, and eventually Consumer 2) will depend on; it
fixes the shape of a shared module (`parseGridSchedule`'s output contract)
that a second consumer is explicitly planned to build against, so the
contract needs to be right now, not renegotiated later; and it makes a
non-obviously-reversible tradeoff (refuse-on-nonempty, §6) that shapes the
UX contract both consumers build against. It also documents a scoped
exception to the "authored, not reconstructed" invariant — exactly the
kind of durable, dated record the constitution's ADR bar asks for, so a
future reader (including whoever builds Consumer 2) doesn't have to
re-derive why this doesn't contradict that invariant from first
principles.

## Non-goals (this slice)

- Global-ingest event/elective detection (owner moved away from it — see
  Context).
- Campwide overlay auto-placement from the file — the director places the
  event/elective-period cell on the campwide schedule by hand; import only
  populates the container's internal detail.
- Consumer 2 (electives) wiring — named and shaped (§8), not built.
- Teams/scoring/stations/materials/program-narrative for events.
- Multi-file merge (a schedule-grid file plus a separately-uploaded
  location-key file as two files in one import) — see Open Questions §3.
- A bulk "clear this container" affordance — needed to make §6 usable in
  practice; flagged as an open product question below, not assumed in
  scope.

## Open questions for Governor

1. **"Clear this container" affordance.** §6's refuse-on-nonempty is only
   usable if a director can get back to empty. No such control exists on
   `EventGridEditor.jsx` today (deleting cells one at a time is tedious for
   a full grid). In scope for this slice, or is "clear by hand, or delete
   and recreate the container" acceptable for v1? Recommend a minimal
   "Clear all" button behind a confirm, scoped to this event's three
   tables only — small, but it's a destructive-action UX call, a product
   decision, not a technical one.
2. **Location-key detection.** The target file's "WHERE TO GO" key is a
   second page/section within the same document. Should the parser
   auto-detect which page is the key (a page whose content shape is
   "name → name" rather than a time grid), or should the director
   explicitly mark it? Recommend auto-detect with the same
   "do-nothing-if-ambiguous" posture as orientation detection, but this
   is a product call on how much a director should have to babysit.
3. **Multi-file** (Non-goals) — if real camp documents split the grid and
   the location key into two separate files rather than two
   sheets/sections of one file, this non-goal may need revisiting before
   Maker starts. Worth confirming against the real Sports Day artifact in
   the scratchpad before coding.
4. **Consumer 2 timing.** This ADR shapes `parseGridSchedule`'s contract
   partly to keep electives adoption trivial later. Confirm that's still
   the right sequencing (events now, electives as a follow-up ticket) and
   not something the owner wants pulled into this same slice.
