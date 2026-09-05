---
title: "Events — overlay placement on the campwide schedule (Slice 1)"
document_type: adr
status: accepted
authority: normative
implementation_state: planned
date: 2026-08-22
approved: 2026-08-22 (owner — decomposition + overlay-only scope pre-settled; this ADR pins the technical model)
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_specs:
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
  - docs/work/specs/2026-08-22-electives-nested-schedule-slices.md
  - docs/work/specs/2026-08-22-events-overlay-slices.md
related_tickets:
  - docs/work/tickets/T40-one-day-special-event-schedule.md
archive_when: events overlay-placement (Slice 1, this ADR) ships, or this abstraction is superseded
---

# Events — overlay placement on the campwide schedule (Slice 1)

## Context

`docs/adr/2026-08-22-nested-schedules-electives-and-events.md` §3 deferred the
event/program layer to its own ADR, calling it "primarily a structured
program, not a schedule." Re-examining the nine real prior-year artifacts
against that framing shows a **special event is three separable objects**,
each isolated by a different artifact in the set:

1. **A schedule layer** — grid cells, a rotation rule, a station→location map,
   its own timing that may replace or splice the normal day. The standalone
   event-grid artifacts (Camp Chai xlsx, MJCC Memphis) are this object. It is
   **mostly already built**: `special_days` (a full replacement grid,
   `electron/db/schema.sql` ~L678) and `day_overrides` (a partial splice,
   ~L796) both shipped under T40/T106/T108.
2. **An event overlay** — the event placed directly ON the normal campwide
   schedule, as an opaque labeled block, with no separate replacement grid.
   No artifact isolates this alone, but it's the shape a director reaches for
   when an event doesn't need its own grid — a color-war afternoon that just
   occupies the normal periods under a different name.
3. **A program document** — theme, stations (location + materials +
   description + staff lead), event-scoped teams, scoring, run-of-show. The
   family-overlay email (Camp Willowbrook) and freeform planning prose (Camp Willowbrook
   "Manor Awakens", 2023 Maccabiah) are this object. Forcing this prose into
   grid cells was already rejected by the parent ADR.

The sharpest seam is **overlay vs. replacement**, not "event vs. elective."
Object 1 (replacement/splice) is done. Object 3 (program document) is a
capture-and-display problem with no schedule-shape dependency and no urgency
against the schedule engine. **Object 2 — overlay placement — is the one
piece with no home yet, and it is a near-exact structural match for how
electives already work**: a period on the campwide schedule that renders as
an opaque, named container instead of a bare activity. Owner decision:
**build only object 2 now.**

### Why mirror electives, and where the mirror holds

Electives (`docs/adr/2026-08-22-nested-schedules-electives-and-events.md` §2,
shipped) proved the "opaque cell + dedicated detail screen" pattern:
`template_slots.elective_set_id` (nullable, ALTER-added, mutually exclusive
with `activity_id`) marks a cell as elective content; the campwide grid shows
only the set's name; the detail lives on `ElectivesScreen`. Events reuse this
exact shape for the container reference and the opaque render. **It does
not fully hold for placement mechanics** — see Decision 4 below, which is the
one place this ADR diverges from "reuse elective wiring unchanged."

## Decision

### 1. New entity: `events`

Camp-scoped, mirroring `elective_sets`' shape and every registry decision
exactly:

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  notes TEXT,
  UNIQUE(camp_id, name)
);
```

New table (not a drifted one) — added in full to `electron/db/schema.sql`,
column order is free to choose here since there is no pre-existing table to
stay compatible with. Created via a new migration
(`getSchemaVersion(db) >= 39 && getSchemaVersion(db) < 40`, mirroring the
`>= 34 && < 35` guard style `electron/db/localDb.js` already uses for
`ELECTIVE_SETS_DDL`/`ELECTIVE_SET_ACTIVITIES_DDL`), `CURRENT_SCHEMA_VERSION`
bumped to 40. A `docs/adr/.../rollback/v40_down.js` companion follows the
`v35_down.js` shape (drop `events`, drop `template_slots.event_id`, no
backfill to undo since a fresh migration starts every camp at zero events).

**Registry parity — do all four, exactly mirroring `elective_sets`:**
- `UNIQUE_FIELD_ENTITIES.events = { table: 'events', field: 'name', scopeColumn: 'camp_id' }`
  in `electron/ops/operations.js` (~L552-560) — covers cross-device
  same-named-event creation the same way `locations`/`elective_sets` are
  covered (`docs/adr/2026-08-15-locations-concurrent-create-collision.md`).
- `UNIQUE_FIRST_FIELD.events = 'name'` in `src/data/setupCrudRepository.js`
  (~L26) — `createRecord('events', id, { name, ... })` MUST write `name`
  first. This is the orphan-row guard (T115's lesson): if `camp_id` or any
  other field wrote first and then `name`'s UNIQUE collided, a blank-name row
  would already be materialized with nothing to finish naming it. Both
  registries are load-bearing together — one without the other reintroduces
  the gap either was built to close.
- CRUD via `setupCrudRepository` / `useCrudScreen`, same as every other
  setup entity (`docs/current/PLATFORM_STATE.md`'s "Setup CRUD Shared Hook").

### 2. `template_slots.event_id` — nullable, ALTER-added last column

`template_slots` is a DRIFTED TABLE (`electron/db/schema.sql` ~L308-317 —
migration-added columns are documented in a comment block, not the base
`CREATE TABLE`, because a fresh install and a migrated install must reach the
identical column SET but not necessarily the identical column ORDER unless
each migration appends last). `event_id` follows the `elective_set_id`
precedent exactly:

- Migration: `ALTER TABLE template_slots ADD COLUMN event_id TEXT` inside the
  same v40 migration block that creates `events`, guarded
  `if (!hasEventId)` the way v35's `elective_set_id` add is guarded.
- Schema.sql: append `event_id` as the new last item in the drifted-table
  comment block (after `elective_set_id`) AND as the physically last column
  in the fresh-install `CREATE TABLE template_slots` body, so
  `PRAGMA table_info` order is byte-identical fresh vs. migrated. This is
  asserted by a new `events.migration.test.js`, structured like
  `electron/db/electives.migration.test.js` (recreate a pre-v40 template_slots
  without `event_id`, migrate, assert `event_id` lands as the 12th column;
  assert a migrated existing camp starts with zero events and every existing
  slot's `event_id` stays NULL — no backfill).
- **`BULK_REPLACE_ENTITIES.template_slots.columns`**
  (`electron/ops/operations.js` ~L246-262) MUST add `'event_id'` — this list
  is a default-deny allowlist; without this entry every bulk_replace write
  (generate/placeAnchors/restoreSnapshot in `ScheduleScreen.jsx`) that
  includes an `event_id` value is rejected by `validateBulkReplaceRows`
  before it reaches the DB. This is the one registration `elective_set_id`
  needed too (it's already in that list, ~L261) that a naive mirror could
  still miss.

### 3. Slot-reference exclusivity — three-way, not two-way

`template_slots` now carries three mutually-exclusive content references:
`activity_id`, `elective_set_id`, `event_id` (plus the orthogonal
`is_anchor`/`anchor_id` pair, which takes precedence over all three per the
existing engine comment at `src/engine/buildSchedule.js` ~L152-175).

**`MUTUALLY_EXCLUSIVE_FIELDS`** (`electron/ops/projections.js` ~L739-744,
T111) is currently pair-shaped:
```js
export const MUTUALLY_EXCLUSIVE_FIELDS = {
  template_slots: { activity_id: 'elective_set_id', elective_set_id: 'activity_id' },
}
```
`sanitizeMutuallyExclusiveRow` walks this as `{field: partner}` pairs and, if
both halves of a pair are non-null, clears the partner — "the field listed
first wins." A three-way group cannot be expressed as two symmetric pairs
without a contradiction (e.g. `activity_id: 'elective_set_id'` says nothing
about `event_id`, and a row could still end up with `activity_id` +
`event_id` both set, unsanitized). **Required change:** generalize
`MUTUALLY_EXCLUSIVE_FIELDS` from a pair-dict to a **group list** —
`template_slots: [['activity_id', 'elective_set_id', 'event_id']]` — and
rewrite `sanitizeMutuallyExclusiveRow` to, per group, keep the first non-null
field in group order and null every other member that is also non-null.
Group order **is** the precedence order: `activity_id` survives over
`elective_set_id` and `event_id`; `elective_set_id` survives over `event_id`.
This is a small, mechanical rewrite of one function plus its one call site's
data shape (`operations.js`'s bulk-write path and `applyProjection`'s
per-field eviction step both consume this export) — not a new mechanism.

**Render precedence** (every consumer that currently branches
`activity_id ? ... : elective_set_id ? ... : empty`) becomes a third
`else if`, in the same precedence order as the exclusivity group:
`activity_id` → `elective_set_id` → `event_id` → empty. Concretely:
`src/screens/schedule/gridGeometry.js`'s `hasContent` (~L158) becomes
`Boolean(slot.activity_id) || Boolean(slot.elective_set_id) || Boolean(slot.event_id)`;
`src/components/schedule/SlotCell.jsx`'s dangling-reference fallback
(~L238-246, currently elective-only: `set ? name : 'Elective (removed)'`)
gets an analogous `event ? name : 'Event (removed)'` branch, same
`data-elective`-style data attribute pattern (add `data-event`); `SlotCell`'s
opaque label uses the event's `name` with no member/offering count (events
have no offerings in Slice 1, unlike electives' `(${count})` suffix);
`src/utils/exportSchedule.js` gets an `event_id` branch parallel to its
existing `elective_set_id` branch (~L10-60); `src/screens/schedule/useContentRaceFlag.js`'s
`contentKind()` (~L20) gets `if (slot.event_id) return \`event:${slot.event_id}\``
ahead of the `elective_set_id` check, matching precedence order.

### 4. Span-merge — the one place the electives mirror breaks, and the precise fix

**Electives never span multiple time blocks in the shipped model.** Every
elective cell the engine or the UI produces is `is_span_head: true` with no
tail row — confirmed in `src/engine/buildSchedule.js`'s elective placement
(~L176-182, `is_span_head: true` hardcoded) and in
`src/screens/schedule/useSlotMutations.js`'s `collectSpanTails` (~L19-33),
which is **hard-keyed to `activity_id`**:
```js
function collectSpanTails(slots, timeBlocks, target, headRow) {
  if (!headRow || headRow.is_span_head === false || headRow.activity_id == null) return []
  ...
  if (!row || row.is_span_head !== false || row.activity_id !== headRow.activity_id) break
  ...
}
```
Events, per the background brief, need multi-block placement (a color-war
afternoon spanning 3 periods within a day) using the existing PR #145
`is_span_head` chain mechanism. Because `collectSpanTails`'s guard requires
`activity_id != null`, an event-only row (`activity_id: null, event_id: X`)
returns `[]` unconditionally today — **span-merge does NOT carry over
"unchanged."** This is the task brief's claim that does not survive contact
with the code; the fix is small and contained, not a new subsystem:

- Add a `refField(row)` helper (co-located with `collectSpanTails`, one new
  unit-tested function): `activity_id != null ? 'activity_id' : event_id != null ? 'event_id' : null`.
  Electives are deliberately excluded from this helper — they don't span, so
  no call site needs to resolve `elective_set_id` through it.
- `collectSpanTails`'s guard becomes
  `if (!headRow || headRow.is_span_head === false) return []; const field = refField(headRow); if (!field) return []`,
  and its match condition becomes `row[field] !== headRow[field]` instead of
  the hardcoded `row.activity_id !== headRow.activity_id`.
- Every tail-write call site in `useSlotMutations.js` that currently writes
  the literal `{ activity_id: X, is_span_head: false, flags }` (there are
  several — `expandSlot`, `splitSlot`, and the drag-replace flow around
  ~L602-716, ~L1079-1150, ~L1205-1246) computes `field = refField(freshHeadSlot)`
  once and writes `{ [field]: X, is_span_head: false, flags }`. This is a
  mechanical generalization of existing call sites, not new merge logic —
  each site already computes the value it writes; only the field name
  becomes a variable.
- **Load-bearing risk (unchanged from the code's own existing shape):** the
  three-way exclusivity invariant must hold on every row `collectSpanTails`
  walks, or `refField` silently picks the wrong field and either breaks a
  chain or (worse) merges across content-type boundaries. This is the same
  risk class `MUTUALLY_EXCLUSIVE_FIELDS`/`sanitizeMutuallyExclusiveRow`
  already exist to bound for activity/elective; extending that sanitizer to
  the three-way group (Decision 3) is what keeps this bounded — the two
  decisions are not independent, and Slice 1 must land both together, not
  the span generalization alone.
- Multi-**day** events are explicitly out of scope for this mechanism per
  the background brief ("multi-day is achieved by span-merge, not a
  day-range model" refers to the existing PR #145 pattern, which is
  within-day/across-time-blocks only); a day-spanning event is a `notes`-only
  fact in Slice 1 (director places the same event on each day's cells
  individually) — no new day-range primitive is introduced here.

### 5. Drill-in: `EventScreen`

A dedicated screen, structurally mirroring `ElectivesScreen.jsx` but with the
sub-schedule table removed (no offerings in Slice 1):
- Editable `name` (via `UNIQUE_FIRST_FIELD`-guarded `createRecord`) and
  `notes` (free text, same posture as `special_days.notes` — recorded and
  printed, never parsed).
- A **read-only** placement summary: query `template_slots` for
  `WHERE event_id = ?`, resolve each row's `day_id`/`time_block_id`/`group_id`
  to names, and render as a plain list ("Week 1 Wed, Group Bnei Mitzvah,
  periods 3-4" style — reuse whatever name-resolution helper
  `ElectivesScreen`/`exportSchedule.js` already use for day/block/group
  labels rather than writing a new one). No internal time-bands, no
  sub-grid, no editing placement from this screen — placement is done from
  the campwide grid via normal drag/drop, same as an elective cell's set
  reference is assigned from the grid, not from `ElectivesScreen`.
- No coming-soon controls (`feedback_no_coming_soon_controls`): if a
  Slice-2-only affordance (internal sub-schedule) isn't built, it isn't
  shown as a disabled button — it's simply absent from this screen.

### 6. Engine posture — skip, same as electives

`src/engine/buildSchedule.js`'s placement pass gets an `eventLookup`
(`Map<"groupId|dayId|blockId", eventId>`) built from `preplacedSlots` entries
carrying an `eventId`, threaded exactly like `electiveLookup` (~L152-182).
Precedence order in the per-cell branch: `anchor` → `event` → `elective` →
open (an explicit, arbitrary-but-documented order, since only one of the
three is ever populated on real data by write-path convention — matching
`MUTUALLY_EXCLUSIVE_FIELDS`' group order in Decision 3). An event slot is
excluded from `openSlots` entirely, never eligibility-checked, never
UNFILLABLE-flagged — identical posture to an elective slot. `src/screens/schedule/useGeneration.js`'s
elective no-op comment (~L85-89) gets the same treatment for `event_id`.

## Consequences

- **Schema:** one new table (`events`), one new nullable drifted-table
  column (`template_slots.event_id`), one migration (v40) with matching
  rollback and fresh-vs-migrated equivalence test. `database-sync` gate
  mandatory (integration suite).
- **Exclusivity mechanism generalizes** from a hardcoded pair to a
  precedence-ordered group — a real, load-bearing schema-adjacent change
  (`MUTUALLY_EXCLUSIVE_FIELDS` shape, `sanitizeMutuallyExclusiveRow` logic)
  that every future opaque-cell content kind (should one ever be added)
  will also need to join, not re-invent.
- **Span-merge generalizes** from activity-only to a `refField`-discriminated
  chain — a small, testable change isolated to `collectSpanTails` and its
  tail-write call sites; electives are provably untouched (they never enter
  the chain).
- **New authoring surface:** `EventScreen`, reusing `setupCrudRepository` /
  the frozen tokens, no new visual language.
- **Reuse:** `setupCrudRepository`/`UNIQUE_FIELD_ENTITIES`/`UNIQUE_FIRST_FIELD`
  registries (locations/elective_sets precedent), the opaque-cell render
  pattern, `special_days`/`day_overrides` for the (already-shipped)
  replacement/splice object, PR #145's span mechanism (generalized, not
  duplicated).
- **Deferred to future ADRs/slices** (see the spec's Slice 2/ingest headers
  for the concrete next steps):
  - Internal event sub-schedule / own time bands (stations, rotations) —
    Slice 2, its own design pass once overlay placement is proven; plugs
    into the *already-shipped* `special_days`/`day_overrides` objects rather
    than inventing a fourth schedule shape.
  - Ingest + nudge for events — a later slice, landing "as an activity
    scoped to that week spanning day(s)/groups," i.e. the ingest-side
    analogue of Slice 3a/3b for electives (`ADR 2026-08-22-nested-schedules...`
    §4), not built here.
  - Stations, rotations, teams, scoring, materials, program narrative — the
    "program document" object (#3 in Context) — each likely its own ADR;
    none is touched by this Slice 1.
  - A real staffing model (a station "lead" is a deferred-object concern
    here) is flagged, as it was for electives, as its own future initiative
    that ordinary `activities` will also eventually need — not invented
    ad hoc for events.

## Non-goals (Slice 1)

- No internal event sub-schedule / own time bands (Slice 2).
- No ingest/nudge for events (later slice).
- No stations, rotations, event-scoped teams, scoring, or materials.
- No program narrative / run-of-show capture.
- No replacement grid — that object is `special_days`, already shipped;
  this ADR does not touch it.
- No `campers` roster (consistent with electives' posture).
- No staffing model.
- No day-range primitive — multi-day is per-day placement, each day's cells
  reference the same `event_id` independently.
