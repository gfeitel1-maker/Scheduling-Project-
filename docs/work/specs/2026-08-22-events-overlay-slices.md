---
title: Events overlay placement — implementation slices
document_type: spec
status: draft
created: 2026-08-22
archive_when: Slice 1 ships (merged/deferred) or the parent ADR is superseded
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-events-overlay-placement.md]
---

# Events overlay placement — implementation slices

Implements `docs/adr/2026-08-22-events-overlay-placement.md`. The campwide
cell stays opaque (event name), the drill-in screen edits name/notes and
shows a read-only placement summary, and the engine skips event slots — same
posture as electives. No internal sub-schedule, no ingest, no
stations/teams/scoring/materials/program-doc in this slice.

## Ground-truth first (do before Slice 1)
Confirm against the live tree before writing anything (the electives mirror
is close but not exact — see the ADR's §4):
- `electron/db/schema.sql` — confirm `CURRENT_SCHEMA_VERSION` in
  `electron/db/localDb.js` is still 39 (next migration is v40); confirm
  `template_slots`' drifted-table comment block still ends at
  `elective_set_id` (v35) with nothing added since this design pass.
- `electron/ops/projections.js` — confirm `MUTUALLY_EXCLUSIVE_FIELDS` is
  still the two-entry pair-dict described in the ADR (no one has already
  generalized it for an unrelated reason).
- `src/screens/schedule/useSlotMutations.js` — confirm `collectSpanTails`'s
  guard/match condition still literally reads `activity_id` (line numbers in
  the ADR are approximate; re-grep before editing).

## Slice 1 — Events entity, slot reference, opaque placement, drill-in, engine skip

### Step 1 — `events` table + registries (test-first)
- Write `electron/db/events.migration.test.js` (red first), mirroring
  `electron/db/electives.migration.test.js`'s structure: assert a pre-v40 db
  has no `events` table and `template_slots` has no `event_id` column;
  migrate; assert `events` exists with columns
  `id, camp_id, name, sort_order, notes` and `UNIQUE(camp_id, name)`; assert
  `template_slots` gains `event_id` as its new last column (12th on a fully
  migrated db); assert an existing camp starts with zero events and every
  existing slot's `event_id` is NULL (no backfill).
- Implement: add `events` `CREATE TABLE` to `electron/db/schema.sql`
  (alongside `elective_sets`, with a comment cross-referencing this ADR);
  extend the `template_slots` drifted-table comment block with the `event_id`
  (v40) line; add the migration block to `electron/db/localDb.js`
  (`getSchemaVersion(db) >= 39 && getSchemaVersion(db) < 40`), guarding both
  the `CREATE TABLE IF NOT EXISTS events` and the `ALTER TABLE template_slots
  ADD COLUMN event_id TEXT`; bump `CURRENT_SCHEMA_VERSION` to 40; write
  `electron/db/rollback/v40_down.js` mirroring `v35_down.js`.
- Register: `UNIQUE_FIELD_ENTITIES.events` (`electron/ops/operations.js`),
  `UNIQUE_FIRST_FIELD.events = 'name'` (`src/data/setupCrudRepository.js`),
  `'event_id'` added to `BULK_REPLACE_ENTITIES.template_slots.columns`
  (`electron/ops/operations.js`).
- **Success:** `events.migration.test.js` green; a `createRecord('events', id,
  { name, ... })` call rejects if `name` isn't first (mirrors
  `ElectivesScreen.test.jsx`'s equivalent assertion); a cross-device
  same-named-event create resolves through the existing
  `detectUniqueFieldCollision` path (add one test alongside the existing
  `elective_sets` collision test, same shape).

### Step 2 — Three-way exclusivity (test-first)
- Write a unit test for `sanitizeMutuallyExclusiveRow` (or wherever
  `projections.test.js`/equivalent already covers the two-way case) asserting:
  a row with `activity_id` + `event_id` both set clears `event_id`; a row with
  `elective_set_id` + `event_id` both set clears `event_id`; a row with all
  three set clears both `elective_set_id` and `event_id`, keeping
  `activity_id`.
- Implement: change `MUTUALLY_EXCLUSIVE_FIELDS` (`electron/ops/projections.js`)
  from the pair-dict to `{ template_slots: [['activity_id', 'elective_set_id', 'event_id']] }`
  and rewrite `sanitizeMutuallyExclusiveRow` to walk each group in order,
  keeping the first non-null field and nulling the rest. Re-run the existing
  two-way tests unchanged (activity vs. elective) to confirm no regression.
- **Success:** old two-way tests still green; new three-way tests green;
  `applyProjection`'s per-field eviction step and the bulk-write sanitizer
  both exercise the new shape (check both call sites, not just one).

### Step 3 — Span-merge generalization (test-first)
- Write a unit test for a new `refField(row)` helper (co-located with
  `collectSpanTails` in `useSlotMutations.js`, or extracted to a small
  testable module if that's cleaner): returns `'activity_id'` /
  `'event_id'` / `null` per the ADR §4 rule.
- Write `collectSpanTails` tests: an event-headed span (head `event_id: X`,
  `is_span_head: true`; tail `event_id: X, is_span_head: false`) returns the
  tail; an elective-headed row (unaffected — `activity_id` null,
  `elective_set_id` set) still returns `[]` (proves electives are untouched).
- Implement: generalize `collectSpanTails`'s guard and match condition per
  the ADR; generalize the tail-write call sites (`expandSlot`, `splitSlot`,
  the drag-replace flow) to write `{ [refField(freshHeadSlot)]: value,
  is_span_head: false, flags }` instead of the hardcoded `activity_id` key.
- **Success:** all existing activity-span tests (expand/split/merge) green
  unchanged; new event-span tests green; an elective cell (never spans)
  provably unaffected.

### Step 4 — Opaque render + placement (drag/drop reuse, no new DnD code)
- Extend `gridGeometry.js`'s `hasContent`, `SlotCell.jsx`'s label/dangling-
  reference fallback (`data-event` attribute, "Event (removed)" text),
  `exportSchedule.js`'s cell-label branch, and `useContentRaceFlag.js`'s
  `contentKind()` per the ADR §3 precedence order.
- Placement: an event cell is created/edited via the same drag/drop +
  click-to-write flow electives use in `useSlotMutations.js` (the write path
  that currently does `{ elective_set_id: X, activity_id: null, flags: {} }`
  gets an event-placement counterpart doing `{ event_id: X, activity_id: null,
  elective_set_id: null, flags: {} }` — explicit triple-null on write, not
  relying solely on the Step 2 sanitizer, matching the existing
  belt-and-suspenders posture other mutation call sites already use).
- **Success:** dragging an event onto a cell (or the equivalent click-to-write
  entry) renders the opaque event name on both routes (Manual/Generated);
  the engine never assigns into it (Step 5); export renders the event name
  the same way it renders "Electives".

### Step 5 — Engine skip
- Add `eventLookup` to `src/engine/buildSchedule.js`, threaded through
  `preplacedSlots` entries carrying an `eventId`, precedence `anchor → event
  → elective → open`, per the ADR §6. Update `useGeneration.js`'s
  elective no-op comment/filter to also pass through `event_id`.
- **Success:** `buildSchedule.test.js` gets a new case — a preplaced event
  slot is never in `openSlots`, never eligibility-checked, never flagged
  UNFILLABLE, identical assertions to the existing elective case.

### Step 6 — `EventScreen` drill-in
- New screen mirroring `ElectivesScreen.jsx`'s CRUD shell (name/notes edit,
  `setupCrudRepository`) minus the offerings sub-table. Read-only placement
  summary queries `template_slots WHERE event_id = ?`, resolves day/block/
  group names via whatever helper `ElectivesScreen`/`exportSchedule.js`
  already use.
- A clear affordance from an event cell (mirroring the elective cell's
  drill-in affordance) opens this screen for that event.
- **Success:** a director can create "Color War", place it on several
  campwide cells across two days, open the drill-in from any of those cells,
  see all placements listed, and edit name/notes; no coming-soon controls
  anywhere on the screen; gate green (`npm run verify`).

## Slice 2 (named, not built here) — internal event sub-schedule
Own time bands / stations / rotation-by-team-or-group within an event,
plugging into the already-shipped `special_days` (full takeover) or
`day_overrides` (partial splice) objects rather than a new schedule shape.
Needs its own design pass once overlay placement (this slice) is proven —
explicitly deferred by the parent ADR, not scoped here.

## Later slice (named, not built here) — ingest + nudge for events
Mirrors electives' Slice 3a (`docs/work/specs/2026-08-22-electives-nested-schedule-slices.md`):
detect an event-shaped period/grid on upload, nudge, confirm → create-empty
via the authored `campScopedEntities.js` path (never bypass "authored, not
reconstructed"). Per the background brief, an ingested event candidate is
scoped "as an activity scoped to that week spanning day(s)/groups" — i.e.
the ingest-side representation targets the overlay placement this slice
builds, not the Slice 2 sub-schedule. Not built here; tracked as a follow-on
ticket once Slice 1 ships.

## Non-goals / guardrails
- No internal sub-schedule, stations, rotations, teams, scoring, materials,
  or program narrative (deferred objects, likely their own ADRs).
- No replacement grid — `special_days` already is that object; untouched.
- No ingest/nudge for events (later slice).
- No `campers` roster, no staffing model (mirrors electives' posture; a real
  staffing model is flagged as its own future initiative).
- No day-range primitive — multi-day placement is per-day, same `event_id`
  referenced independently on each day's cells.
- No palette/token changes; Operate restraint on `EventScreen`.
