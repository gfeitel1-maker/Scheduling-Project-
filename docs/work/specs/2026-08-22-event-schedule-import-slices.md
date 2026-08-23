---
title: "Grid-schedule import — Slice spec (shared parser + events consumer)"
document_type: spec
status: implemented
authority: implementation
date: 2026-08-22
created: 2026-08-22
archive_when: this slice ships (merged/deferred) or the parent ADR is superseded
governing_docs:
  - docs/adr/2026-08-22-event-schedule-import.md
  - docs/adr/2026-08-22-event-internal-subschedule.md
---

# Grid-schedule import — slice spec

Governing ADR: `docs/adr/2026-08-22-event-schedule-import.md`. Read it
first — this spec assumes its decisions (§0–§8) and only breaks them into
test-first steps. Do not re-litigate the shared/consumer split, the
refuse-on-nonempty rule, or the deterministic-id scheme here; if any of
them looks wrong once you're in the code, stop and report to Governor
rather than silently deviating (per the ADR/Maker boundary).

Every step below is: write the failing test(s) first, make them pass,
then move on. No step writes UI before its data layer is tested.

## Step 0 — Ground the target file against the design

Before writing `parseGridSchedule`, re-open the real Sports Day xlsx
already extracted in the scratchpad (referenced in the ADR's Context) and
confirm, by hand:

- Which axis is time, which is group/grade-band, in the actual file (not
  assumed) — does `sheetToPage` put times in `columns` or in
  `row.label`?
- Whether the "WHERE TO GO" key is a separate sheet, a separate section of
  the same sheet, or absent in this particular fixture.
- The exact time-string format(s) present ("9:30-10:10", "9:30 - 10:10",
  "9:30am", etc.) — feeds the time-range regex in Step 1.

Write this down as a fixture (`test/fixtures/` or inline in the test file,
Maker's call) — every downstream test in Step 1 should include at least
one case built from real cell text out of this file, not only synthetic
examples. If the file's shape contradicts an ADR assumption (e.g. the
location key turns out to be a second *file*, not a second sheet — ADR
Open Question 3), stop and flag to Governor before proceeding past this
step.

## Step 1 — `parseGridSchedule` (pure, shared, no db/UI)

File: `src/ingest/parseGridSchedule.js` + `parseGridSchedule.test.js`.

Test-first, in this order:

1. **Orientation: rows-are-time.** A page whose `row.label`s are
   time-range strings and whose `columns` are group names →
   `orientation = { axis: 'rows-are-time', confident: true }`,
   `timeAxis` built from row labels (parsed into `name`/`start_time`/
   `end_time`), `groupAxis` built from columns, `cells` one per non-empty
   cell with the right `timeIndex`/`groupIndex`.
2. **Orientation: columns-are-time.** The transposed case — header row is
   times, `row.label` is the group. Same output shape, axes swapped.
3. **Orientation: not confident.** A page where neither axis clears the
   time-majority threshold (e.g. both axes are plain names) →
   `orientation.confident === false`, empty `timeAxis`/`groupAxis`/
   `cells`. No throw.
4. **Time-range parsing.** "9:30-10:10" → `{ start_time: '9:30', end_time:
   '10:10' }` (confirm exact format against what `event_time_blocks`
   already stores — check existing rows/tests for the field's expected
   string shape before assuming HH:MM). A label that isn't a clean range
   ("Morning Block") still becomes a `timeAxis` entry with `name` set and
   `start_time`/`end_time` null — never dropped.
5. **Cell text cleaning.** A cell like "Instructional Swim 11:45-12:10-"
   (the exact noise shape `cleanCellValue` already handles) → cleaned
   `activityName`, confirming the import from `extractEntities.js` is
   wired correctly, not reimplemented.
6. **Location key present.** A second page shaped `name → name` present
   in `pages` → cells whose `activityName` matches a key entry get
   `locationName` filled from the majority-vote tally; an activity with no
   key entry gets `locationName: null` (not an `unmapped` entry at this
   layer — unmapped location *matching against real camp locations* is a
   consumer-layer concern, §3 below; this layer only reports what the file
   itself failed to give a name for).
7. **Empty/degenerate input.** `parseGridSchedule([])` and
   `parseGridSchedule([{ title: 'x', columns: [], rows: [] }])` both
   return the empty-but-well-formed shape from case 3, never throw.
8. **Real-fixture case** from Step 0 — at least one test built from the
   actual Sports Day cell text, asserting the full parsed shape end to
   end.

Do not let this module import anything from `electron/`, know about
`campId`/`eventId`, or perform any write. If a test needs one of those, the
logic belongs in Step 3, not here.

## Step 2 — `deriveEventImportId` (pure)

Colocated with Step 3's file or its own tiny module — Maker's call.

1. Same `(eventId, axis, sourceSignature)` input twice → identical output,
   for each of the three axes (`'block'`/`'group'`/`'slot'` or whatever
   axis-naming Maker picks — match `deriveEventSeedId`'s existing
   `'block'`/`'group'` vocabulary rather than inventing new axis names).
2. Different `sourceSignature` (different index) → different id.
3. Confirm no collision with `deriveEventSeedId`'s own id space — the two
   must never produce the same string for plausible inputs (different
   literal prefix, `event-import:` vs `event-seed:`, already guarantees
   this; add a test asserting the prefixes differ so a future refactor
   can't accidentally collapse them).

## Step 3 — `populateEventGrid` (pure logic, mocked repo/db)

File: `src/ingest/eventGridPopulate.js` (or colocated per ADR's Maker-call
note) + test file.

Inputs: `parseGridSchedule`'s output, `{ eventId, campId, existingLocations,
existingActivities, existingEventSlots }`, and a `repo` shim matching
`EventGridEditor.jsx`'s existing `writeField`/`repo.writeActivityFields`
shape (mock it in tests — do not hit real `localClient`/db here).

Test-first:

1. **Happy path.** A confident parse with 2 time blocks × 2 groups, all
   cells filled with existing-activity names → exactly the expected
   `event_time_blocks`/`event_groups`/`event_slots` writes, each keyed by
   `deriveEventImportId`, `activity_id` resolved from `existingActivities`
   by `normalizeName` (no new activity created).
2. **Create-if-new activity.** A cell activity name not in
   `existingActivities` → `createActivity` path taken (assert the mock
   `repo.writeActivityFields` was called with `newActivityDefaultFields`'s
   shape), new id used in the resulting `event_slots` write.
3. **Location match.** A cell with a `locationName` matching an existing
   location (by `recognitionKey('locations', name)`, trim-only
   case-sensitive — include a test where case differs and correctly does
   **not** match, per `locations`' documented case-sensitive identity) →
   `location_id` set.
4. **Location unmapped.** A `locationName` with no match in
   `existingLocations` → `location_id` left null, an `unmapped` entry
   returned describing it — never a created location.
5. **Re-import idempotency.** Running `populateEventGrid` twice with the
   identical parsed input and the identical `eventId` → the second run
   produces the **same** set of ids as the first (assert by comparing the
   full set of `(entity, id)` pairs written) — the sync-convergence
   property from ADR §4.
6. **Different file, same event, second import blocked.** With
   `existingEventSlots` containing at least one row with non-null
   `activity_id`, calling `populateEventGrid` → refuses (returns/throws a
   result the caller surfaces as the ADR §6 message), writes nothing.
   Assert zero calls to the write shim.
7. **Not confident / not a grid.** `orientation.confident === false` input
   → refuses with the ADR §5.2 message, writes nothing.
8. **Partial parse surfaces, doesn't block.** A confident parse with one
   unmapped location and otherwise-complete cells → all mappable rows are
   written, `unmapped` is returned non-empty for the caller to display —
   confirm this is NOT treated as case 7's failure.

## Step 4 — `EventGridEditor.jsx` wiring (component, then visual)

1. **Empty-state affordance.** Extend the existing empty state (`LABELS.
   emptyBlocksTitle`/`emptyBlocksBody`) with an "import this event's
   schedule from a file" control, visible only when the grid has no
   authored `event_slots` (mirrors §6's own gate — the button itself
   should not be reachable when refuse would fire, not merely refuse
   silently after the fact). Component test: renders when empty, absent
   (or replaced by a disabled/explained state — Designer's call if this
   screen gets a design pass) when the grid already has entries.
2. **File → parse → populate wiring.** On file selection: run the same
   size/complexity guards used by `ImportScreen.jsx`
   (`assertImportFileSize`, `assertWorkbookComplexity`) before parsing,
   then `workbookToPages`/`parseTextGrid` → `parseGridSchedule` →
   `populateEventGrid`, then `load()` (existing reload function) to pick
   up the new rows. Component test with a mocked file and mocked
   `localClient` asserting the grid re-renders populated.
3. **Error surfacing.** Each of Step 3's refusal cases (6, 7) renders the
   ADR §5/§6 message via the existing `error` state /
   `describeWriteFailure` pattern already used elsewhere in this file —
   not a new error-display mechanism.
4. **Unmapped summary.** Case 8's `unmapped` result renders a small
   post-import notice (count + what to check) — reuse existing typography/
   spacing tokens from `src/styles/shared.js`'s `S`, no new visual
   language. If this crosses into meaningful new UI surface (more than a
   one-line notice), flag to Governor for a Designer pass per this
   project's UI-significant-work gate — don't freelance a new pattern.
5. **Visual check in the running app** (per this project's "show me the
   running UI" convention) — `npm run electron:dev`, open an event with an
   empty internal grid, run the import against the real Step 0 fixture
   file, confirm the populated grid renders correctly and matches what a
   hand-built equivalent grid would look like (same `EventCell`/
   `gridTracks`/`gridPlacement` rendering, since no new grid component was
   built).

## Step 5 — Gate

`npm run verify` (lint + test + test:integration + check:governance).
Pay particular attention to:

- `check:governance`'s doc-staleness gate — this ADR's
  `implementation_state` must flip from `planned` to `shipped`/whatever
  this project's convention is (verify the exact vocabulary against a
  recently-shipped ADR's frontmatter, e.g.
  `docs/adr/2026-08-22-event-internal-subschedule.md`) in the same commit
  that closes this work.
- No `BULK_REPLACE_ENTITIES` entry was added for `event_slots`/
  `event_groups` — the ADR is explicit this import stays field-at-a-time,
  consistent with Slice 2's existing posture. If a Maker finds themselves
  reaching for bulk-replace for performance, that's a signal to stop and
  raise it, not to add the entry unilaterally.
- `src/localClient.mock.js`'s existing event-entity registration (fields
  list, delete-cascade order) needs no changes for this slice — import
  writes through the same `event_time_blocks`/`event_groups`/
  `event_slots` fields already registered. Confirm this rather than
  assuming it.

## Explicitly out of scope for this slice (do not build)

Per the ADR's Non-goals: global-ingest detection, campwide overlay
auto-placement from the file, Consumer 2 (electives) wiring of any kind
(`ElectivesScreen`, `populateElectiveSet`, or any `elective_set_activities`
writes), teams/scoring/stations/materials, multi-file merge, a bulk
"clear this event's grid" control (Open Question 1 — build only if
Governor confirms it's in scope; without it, refuse-on-nonempty (§6) has
no escape hatch other than deleting cells by hand or recreating the
event, which is an acceptable v1 gap per the ADR but worth flagging in the
PR description so it's a visible, not silent, gap).
