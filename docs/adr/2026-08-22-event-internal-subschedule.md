---
title: "Events — internal sub-schedule (Slice 2)"
document_type: adr
status: accepted
authority: normative
implementation_state: planned
date: 2026-08-22
approved: 2026-08-22 (owner — decomposition pre-settled in the parent ADR; this ADR pins the technical model for the deferred internal sub-schedule)
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_specs:
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
  - docs/adr/2026-08-22-events-overlay-placement.md
  - docs/work/specs/2026-08-22-events-overlay-slices.md
  - docs/work/specs/2026-08-22-event-internal-subschedule-slices.md
  - docs/work/specs/2026-08-20-special-days-data-shape-design.md
  - docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md
related_tickets:
  - docs/work/tickets/T106-special-day-author-ui.md
archive_when: event internal-subschedule (this ADR) ships, or this abstraction is superseded
---

# Events — internal sub-schedule (Slice 2)

## Context

`docs/adr/2026-08-22-events-overlay-placement.md` shipped Slice 1: a
camp-scoped `events` table and a nullable `template_slots.event_id`, so an
event can sit as an opaque, named block on the campwide grid — verified live
at `CURRENT_SCHEMA_VERSION = 40` (`electron/db/localDb.js` L17), the `events`
table (`electron/db/schema.sql` L795-802, `EVENTS_DDL` L1860 in
`electron/db/localDb.js`), and `EventScreen.jsx` (`src/screens/EventScreen.jsx`),
which today shows only name/notes + a read-only placement summary — deferred
"the internal sub-schedule (Slice 2) is simply absent, not shown disabled"
(file header comment, L11-12).

That ADR's Decision §5 called for Slice 2 to plug into the **already-shipped**
`special_days`/`day_overrides` objects rather than invent a fourth schedule
shape. Concretely, this app already has exactly the shape an event's internal
sub-schedule needs — **`special_days`** (T40, `docs/work/specs/2026-08-20-special-days-data-shape-design.md`)
is a camp-scoped parent owning its own time blocks and grid cells,
independent of the campwide week. `special_day_time_blocks` +
`special_day_slots` (schema.sql L687-721) are that grid's two parent-scoped
children, and `SpecialDayGridEditor.jsx`/`SpecialDayCell.jsx`
(`src/screens/specialDay/`) are the authoring screen built on top of them,
reusing the campwide grid's own geometry primitives
(`gridTracks`/`gridPlacement`/`scheduleGrid.css`/`SlotCell`'s leaf
components) rather than inventing new grid rendering.

**An event's internal sub-schedule is structurally identical to a special
day's grid**: a named parent, its own time blocks (a color-war afternoon's
stations aren't the camp's regular periods), a group × time-block grid of
cells each carrying an activity/location. The only difference is which
parent entity the children hang off — `event_id` instead of
`special_day_id`. This ADR is therefore a **mirror of the `special_days` →
`special_day_time_blocks`/`special_day_slots` pattern**, parent-scoped under
`events` instead of a new `special_days` row, not a mirror of Slice 1's
camp-scoped `elective_sets`/`events` pattern — the two existing patterns in
this codebase solve different problems (`elective_sets` has ONE
parent-scoped child; `special_days` has TWO, and IS a grid rather than a
single opaque reference), and Slice 2 needs the two-child grid shape.

## Decision

### 1. Three new parent-scoped tables: `event_time_blocks`, `event_groups`, `event_slots`

Structural mirror of `special_day_time_blocks`/`special_day_slots`
(`electron/db/schema.sql` L687-721), parent-scoped under `events` — **with
one deliberate, owner-driven divergence: the grid COLUMNS are the event's
OWN groups (`event_groups`), not the camp's fixed `groups`.** A special day
runs the camp's real groups through a special grid; a special *event* often
regroups campers entirely (grade bands, combined units, custom teams for the
day). The owner confirmed this explicitly ("define groups AND times as
wanted"), and a real prior-year artifact (a camp Sports Day grid) proves it —
its columns were "1st Grade / 3rd-4th / 5th-6th", event-specific bands, not
the season's groups. So Slice 2 adds a third parent-scoped child that
`special_days` does not have — an editable column set — and `event_slots`
references it, not `groups`:

```sql
CREATE TABLE IF NOT EXISTS event_time_blocks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  start_time TEXT,
  end_time TEXT
);

CREATE TABLE IF NOT EXISTS event_groups (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_slots (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  event_group_id TEXT NOT NULL,
  time_block_id TEXT NOT NULL,
  activity_id TEXT,
  location_id TEXT
);
```

`event_groups` mirrors `event_time_blocks`' shape (parent-scoped, name +
sort_order); like `special_day_time_blocks` it carries **no `UNIQUE` on
name** — duplicate column labels are allowed and distinguished by
`sort_order`, avoiding cross-device UNIQUE-collision machinery for a
child entity. `event_slots.event_group_id` and `time_block_id` are the two
grid axes; both point at this event's OWN children (`event_groups` /
`event_time_blocks`), not camp entities.

Same deliberate omissions as `special_day_slots`: `event_group_id`/
`time_block_id`/`activity_id`/`location_id` carry **no SQL `REFERENCES`**
clause — soft references resolved by projection/render, not DB-level FK
enforcement, per this app's established op-log model (schema.sql's comment
above `special_day_slots`, L706-712). No `is_span_head`/spanning column in
this slice (mirrors `special_day_slots`' note, L711) and no person/staff
column (mirrors electives' staff-deferred posture). **`event_groups` are the
event's own grid COLUMNS, seedable from the camp's `groups` at first entry as
a UI convenience (like special_days seed time_blocks from the camp), then
edited freely — add/rename/reorder.** They are NOT the deferred event-scoped
*teams+scoring* object (parent ADR §3/Context object #3): `event_groups` are
plain column labels with no scoring, no camper roster, no membership — the
minimum needed to let the director define the grid's columns. Teams-with-
scoring remain deferred; see Non-goals.

All three tables are brand-new (not drifted), so column order is free — no
column-order-trap discipline needed for these three, only for the DRIFTED
`template_slots` in the parent Slice 1 ADR (already shipped, untouched here).

### 2. Migration: v41

`electron/db/localDb.js`'s `CURRENT_SCHEMA_VERSION` (currently 40) bumps to
41. New DDL constants `EVENT_TIME_BLOCKS_DDL` / `EVENT_GROUPS_DDL` /
`EVENT_SLOTS_DDL`, placed alongside `EVENTS_DDL` (L1860) the way
`SPECIAL_DAY_TIME_BLOCKS_DDL`/`SPECIAL_DAY_SLOTS_DDL` sit alongside
`SPECIAL_DAYS_DDL` (L1807-1837) — verbatim duplicate of the schema.sql DDL
text, asserted byte-identical (all THREE constants, not two) by a new
`eventSubschedule.migration.test.js` (mirroring
`electron/db/specialDays.migration.test.js`'s structure). Migration block:

```js
// v41 — event internal sub-schedule (Slice 2, docs/adr/2026-08-22-event-
// internal-subschedule.md). Three new tables, no backfill: every existing
// event starts with zero time blocks / zero groups / zero slots. No
// DDL-time side effect, so this block emits no op, same posture as v33-v40.
if (getSchemaVersion(db) >= 40 && getSchemaVersion(db) < 41) {
  db.transaction(() => {
    db.exec(EVENT_TIME_BLOCKS_DDL)
    db.exec(EVENT_GROUPS_DDL)
    db.exec(EVENT_SLOTS_DDL)
  })()

  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (41, ?)').run(
    new Date().toISOString()
  )
}
```

A `docs/adr/.../rollback/v41_down.js` companion mirrors `v35_down.js`'s
shape: drop **children before parent** — `event_slots` first (it FKs to
both `event_groups` and `event_time_blocks`), then `event_time_blocks` and
`event_groups` (the two axis tables, order between them doesn't matter —
neither FKs the other), then stop; `events` itself is Slice 1's table and is
untouched by this migration or its rollback. No un-drifting needed since
none of the three is an ALTER on an existing table; no data-at-risk warning
needed beyond the standard one (every event's sub-schedule rows are lost,
same as `v34_down.js` for `special_days`).

### 3. Registration — mirror every place `special_day_time_blocks`/`special_day_slots` are registered, for THREE children not two

This is a **six-file checklist**, traced live against the special_days
precedent (all citations verified against the current tree). `event_groups`
joins wherever the two axis-children (`event_time_blocks`/the old
`event_slots`) go — it is a third parent-scoped child of `events`, not a
camp-scoped entity and not a child of `event_time_blocks`:

| Registry | special_days precedent | events equivalent |
|---|---|---|
| `electron/ops/campScopedEntities.js` `PARENT_SCOPED_ENTITIES` (L363-373) | `special_day_time_blocks: { parentTable: 'special_days', parentKey: 'special_day_id' }`, same for `special_day_slots` | add `event_time_blocks: { table: 'event_time_blocks', parentTable: 'events', parentKey: 'event_id' }`, `event_groups: { table: 'event_groups', parentTable: 'events', parentKey: 'event_id' }`, and `event_slots: { table: 'event_slots', parentTable: 'events', parentKey: 'event_id' }` |
| same file, `DOMAIN_SNAPSHOT_ORDER` (L395-419) | `'special_day_time_blocks'` and `'special_day_slots'` positioned after `'special_days'` | add `'event_time_blocks'` and `'event_groups'` positioned after the existing `'events'` entry (either order between these two — neither FKs the other), then `'event_slots'` positioned AFTER both (it references `event_groups.id` NOT NULL and `time_block_id` referencing `event_time_blocks` NOT NULL — both must already exist under `foreign_keys=ON`), each commented with its FK per this array's own convention |
| `electron/ops/projections.js` `PROJECTIONS` (L339-395 for the special_days pair) | `special_day_time_blocks.ensureExists` stub-seeds `special_day_id` only when that field lands (3 required NOT NULL columns reconstructed from op-log order, whichever of `event_id`/`group_id`/`time_block_id` arrives last creates the row) | `event_time_blocks` mirrors the two-field ensureExists (`event_id`, stub name `''`/sort_order `0`); **`event_groups` gets the identical simple ensureExists shape** (`event_id`, stub name `''`/sort_order `0`) — it is structurally just a second `event_time_blocks`-shaped child, not the slots table; `event_slots` mirrors the **three-NOT-NULL reconstruction** exactly, with `event_group_id` replacing `group_id` as the second required column (`event_id`/`event_group_id`/`time_block_id`, `readField` helper reading prior op-log values, insert only once all three are known, whichever lands last creates the row) — this is the one non-trivial piece of logic to port faithfully, not simplify |
| `electron/auth/permissions.js` `ENTITIES` (L52-54 for special_days' pair) | staff read/write; delete/bulk_replace admin-only via default-deny (no explicit staff grant) | add `'event_time_blocks'`, `'event_groups'`, `'event_slots'` with the same posture — guarded by `permissionsEntityParity.test.js`'s parity check against `campScopedEntities.js`'s union |
| `src/localClient.mock.js` (two places: L219-221-style entity-fields registry at ~L331-332, and the delete-cascade block at ~L1481-1495) | `special_day_time_blocks: ['special_day_id', 'name', 'sort_order', 'start_time', 'end_time']`, `special_day_slots: ['special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id']`; a `deleteSpecialDayCascade`-style helper deletes slots, then time_blocks, then the parent | add three field arrays: `event_time_blocks: ['event_id', 'name', 'sort_order', 'start_time', 'end_time']`, `event_groups: ['event_id', 'name', 'sort_order']`, `event_slots: ['event_id', 'event_group_id', 'time_block_id', 'activity_id', 'location_id']`; extend the cascade ordering for `deleteEvent` to delete `event_slots` first, then `event_time_blocks` AND `event_groups` (both parents of nothing else), then the `events` row itself — if/when a delete affordance exists (see Non-goals — Slice 1 has none yet) |
| `electron/ops/operations.js` `BULK_REPLACE_ENTITIES` | **special_day_slots is NOT bulk-replace-registered** (verified: no entry in `BULK_REPLACE_ENTITIES`, L240-271 — special-day placement writes field-at-a-time via `writeField`, never bulk_replace) | **event_slots likewise gets no `BULK_REPLACE_ENTITIES` entry**, and neither does `event_groups` — placement and column-editing in Slice 2's grid editor mirror `SpecialDayGridEditor.jsx`'s field-at-a-time writes, not `ScheduleScreen.jsx`'s bulk-replace generate/restore paths. This is a real divergence from the *Slice 1* checklist (which DID need a `BULK_REPLACE_ENTITIES` entry for `template_slots.event_id`, since the campwide grid's generate/restore-snapshot flows go through bulk_replace) — Slice 2's grid is authored cell-by-cell (and column-by-column) only, so no bulk path exists to register into. |

Additionally, mirroring the surrounding infrastructure that treats
`special_day_slots`' soft references and restore/delete posture as a unit:
- `electron/ops/undoReferences.js` (L74-80): add
  `{ fromTable: 'event_slots', fromColumn: 'event_group_id', toEntity: 'event_groups', kind: 'scalar', enforced: false }`
  — **not** `toEntity: 'groups'`, since this column now points at the
  event's own groups, never the camp's — and the same shape for
  `activity_id`→`activities`, `location_id`→`locations` (those two are
  unchanged, still camp entities). This file's existing entries record
  child→parent references generally (e.g. the elective comment at L83-85
  for `elective_set_activities`→`elective_sets`), so also add the two
  ordinary parent-link entries this pattern implies:
  `{ fromTable: 'event_time_blocks', fromColumn: 'event_id', toEntity: 'events', kind: 'scalar', enforced: true }`
  and the same for `event_groups`/`event_slots` (all three carry a real SQL
  `REFERENCES events(id)`, so `enforced: true`, unlike the soft
  `event_group_id`/`activity_id`/`location_id` columns above) — check
  against however the existing `special_day_time_blocks`→`special_days` /
  `special_day_slots`→`special_days` entries are actually recorded (or not)
  in this file before adding new ones; mirror whatever that precedent does,
  don't invent a shape it doesn't already use.
- `electron/ops/restore.js` (L54-56): add
  `event_time_blocks: 'refused: rebuilt with its parent event, not on its own'`
  and the same text for `event_groups` and `event_slots`, matching
  `special_day_time_blocks`/`special_day_slots`' refusal text verbatim
  (restore only ever targets the parent).
- `electron/ops/deleteRecord.js` (L60-65's comment describes the accepted
  gap for `special_day_slots`: a deleted group leaves its
  `special_day_slots` rows inert/unreachable rather than cascading): the
  analogous accepted gap now applies to `event_slots.event_group_id` when an
  `event_group` row is deleted (not to camp `groups` deletion, since
  `event_slots` no longer references camp groups at all) — no new cascade is
  built here, consistent with the precedent this ADR is mirroring.
- A new `electron/ops/deleteEvent.js`, mirroring `electron/ops/deleteSpecialDay.js`
  exactly, extended to three children: delete `event_slots` rows for the
  event first, then `event_time_blocks` AND `event_groups` rows (order
  between these two is unconstrained — neither FKs the other), in that
  order — children before parent, same ordering comment) — **built but not
  wired to any UI affordance in this slice**, since Slice 1 shipped with no
  event-delete UI at all (`restore.js` L69: `events: 'refused: no delete UI
  yet'`). This keeps the op-log-side machinery consistent with
  `special_days`' own precedent (T40 shipped `deleteSpecialDay.js` before
  T106 added the author UI that calls it) without expanding this slice's
  own UI scope.

### 4. Authoring screen: `EventGridEditor.jsx` + `EventCell.jsx`

Structural mirror of `SpecialDayGridEditor.jsx` + `SpecialDayCell.jsx`
(`src/screens/specialDay/`), reusing the **same geometry primitives** that
file already reuses from the campwide grid — `buildRowTracks`/`columnTracks`
(`src/screens/schedule/gridTracks.js`), `placeCell`/`placeRowHeader`
(`src/screens/schedule/gridPlacement.js`), `blockNamesForSpan`
(`src/components/schedule/cellLabel.js`), and `scheduleGrid.css` — **no new
grid-rendering primitive**, matching `SpecialDayGridEditor.jsx`'s own header
comment ("Reuses the generic SlotCell/EmptyCell/CellInlineEditor leaf layer
and gridPlacement/gridTracks geometry... no new grid-rendering primitive").

**The one real addition beyond a straight mirror: column (`event_groups`)
editing.** `SpecialDayGridEditor.jsx` only lets the director add/rename/
reorder/remove **rows** (`special_day_time_blocks`, via `addBlock`/
`renameBlock`/`moveBlock`/`removeBlock`, L175-231) because its columns are
the camp's fixed `groups` — there is nothing to edit on that axis. Because
`event_groups` is now a real editable child table, `EventGridEditor` needs
the identical add/rename/reorder/remove quartet **on both axes**:
`addTimeBlock`/`renameTimeBlock`/`moveTimeBlock`/`removeTimeBlock` (verbatim
port of `SpecialDayGridEditor.jsx`'s four block functions, `event_id`
replacing `special_day_id`) and a new, structurally identical
`addEventGroup`/`renameEventGroup`/`moveEventGroup`/`removeEventGroup`
quartet operating on `event_groups` instead of `event_time_blocks` — same
`sort_order`-swap reorder logic, same "has filled cells?" confirm-before-
remove guard (`removeBlock`'s `window.confirm` at L217-218), same shape.
Rendering the column header becomes an editable `EventGroupName` component
(sibling to the existing row-side `BlockName`, L431-457) rather than
`SpecialDayGridEditor.jsx`'s current plain `{g.name}` text (L349).

**Seeding at first entry:** when a director opens `EventGridEditor` for an
event with zero `event_time_blocks` AND zero `event_groups` (a brand-new
internal schedule), a one-time convenience seeds both axes from the camp's
current setup — `event_time_blocks` copied from the camp's `time_blocks`,
`event_groups` copied from the camp's `groups` — writing ordinary rows via
the same per-field `writeField` path the rest of the screen uses (not a
special bulk/import path). This mirrors `special_days`' own stated UI
convenience ("the author UI seeding a special day's time blocks from the
camp's time blocks at creation, a UI convenience, not a storage branch",
schema.sql L692-694 comment) — extended here to run on both axes since both
are now editable, seeded independently (a director may want the camp's real
time blocks but entirely custom event-groups, or vice versa; the seed is an
initial-state offer, not a coupling). After the one-time seed, `event_groups`
and `event_time_blocks` are edited freely and never re-synced from the camp
entities — no "reset to camp defaults" affordance in this slice.

Placement writes `event_slots.activity_id` **directly**, via the same
generic per-field `writeField` helper `SpecialDayGridEditor.jsx` defines
locally (L36-43) — never `placeActivityManual` (which is
`schedule_templates`-specific) and never a bulk path (per the table in §3).
This is explicitly the one seam `SpecialDayGridEditor.jsx`'s own header
comment flags for Red Hat attention ("this is the one seam Red Hat should
check") — the same flag applies here for the same reason, now doubled by
the fact that `event_group_id` (not `group_id`) is the column key threaded
through `slotFor`/`placeActivity`/`changeLocation`.

`EventScreen.jsx`'s `EventDetail` component (currently name/notes +
read-only `PlacementSummary`) gains a third section — "Internal schedule" —
that opens `EventGridEditor` for the selected event, replacing the
"internal sub-schedule (Slice 2) is simply absent" posture from Slice 1 with
the real editor. No coming-soon control is added in the interim; Slice 2
either ships the section or it doesn't exist, matching the no-coming-soon
constraint Slice 1 already established for this exact spot.

### 5. Relationship to the overlay placement (Slice 1)

The internal sub-schedule and the campwide overlay cell are two independent
facts about the same `events` row — an event can be placed on the campwide
grid (Slice 1, `template_slots.event_id`) with or without ever building out
an internal sub-schedule (Slice 2, `event_time_blocks`/`event_groups`/
`event_slots`), and vice versa. Nothing in Slice 2 writes to `template_slots`,
and nothing in Slice 1 reads `event_time_blocks`/`event_groups`/
`event_slots` — they are parallel,
uncoupled facts, exactly as `special_days`' own internal grid is uncoupled
from `day_overrides`' campwide splice (two different mechanisms serving two
different "does this event need its own grid or just a normal-grid label"
answers, per the parent ADR's Context §1/§2 split). The engine continues to
skip `event_id`-bearing `template_slots` cells (Slice 1 §6); it never reads
`event_slots` at all — an event's internal grid is director-authored only,
same posture as `special_day_slots` (no solver, ever).

## Consequences

- **Schema:** three new tables (`event_time_blocks`, `event_groups`,
  `event_slots`), zero ALTERs on existing tables (unlike Slice 1, which
  touched the drifted `template_slots`). One migration (v41) with rollback
  and a byte-identical DDL-triplication test (all three DDL constants, not
  two), mirroring `specialDays.migration.test.js`. `database-sync` gate
  mandatory.
- **Six-file registration checklist** (§3) is the real surface area of this
  ADR — the schema itself is copy-paste from `special_days`' precedent, but
  every registry that lists `special_day_time_blocks`/`special_day_slots`
  needs THREE counterparts (`event_time_blocks`/`event_groups`/`event_slots`)
  or the same default-deny/parity-test failures Slice 1's ADR warned about
  for `events` recur here for its children. `event_groups` is easy to miss
  precisely because it has no analogue in the `special_days` precedent this
  ADR otherwise mirrors — it is new, not a rename.
- **One deliberate non-mirror:** `event_slots` and `event_groups`, like
  `special_day_slots`, get **no** `BULK_REPLACE_ENTITIES` entry — this grid
  (both its rows and its columns) is authored cell-by-cell / column-by-column,
  never bulk-generated/restored. Any future work that tries to add
  bulk-replace to either table should be treated as a scope change requiring
  its own review, not a "completing the mirror" cleanup.
- **New authoring surface:** `EventGridEditor.jsx`/`EventCell.jsx`, wired
  into `EventScreen.jsx`'s existing detail view, reusing the campwide grid's
  geometry primitives verbatim, PLUS a genuinely new capability
  `SpecialDayGridEditor.jsx` doesn't have: full column (event-group)
  editing, symmetric with the existing row (time-block) editing.
- **Reuse:** `special_day_time_blocks`/`special_day_slots`' full registration
  pattern (parent-scoped, now three-child shape), `SpecialDayGridEditor.jsx`/
  `SpecialDayCell.jsx`'s structure, grid-primitive reuse, and row-editing
  quartet (mirrored onto the new column axis), `deleteSpecialDay.js`'s
  cascade-ordering pattern (extended to three children).
- **Deferred further** (beyond this slice):
  - Event-scoped **teams-with-scoring** (a roster/membership + points
    object layered on top of a team concept) — **NOT the same thing as
    `event_groups`**, which Slice 2 DOES build: `event_groups` are plain
    editable column labels (name + sort_order), no roster, no scoring, no
    membership tracking. Teams-with-scoring remain part of the deferred
    "program document" object (parent ADR Context #3), unaddressed here.
  - Rotation rules (rotate-by-team / rotate-by-group) — Slice 2 is a static
    grid the director fills cell-by-cell, same as `special_day_slots`; no
    rotation engine is introduced.
  - Stations-with-materials/description, staff leads, scoring — program-doc
    fields, not schedule-shape; `event_time_blocks`/`event_groups`/
    `event_slots` carry only name/sort_order/timing fields, nothing richer.
  - Event delete UI — `deleteEvent.js` (§3) is built for parity with
    `special_days`' op-log-side machinery but wired to no affordance;
    revisit if/when a delete UI is added to `EventScreen.jsx` (mirrors
    `restore.js`'s existing `events: 'refused: no delete UI yet'` note).

## Non-goals (Slice 2)

- No event-scoped teams-with-scoring/roster/membership — **`event_groups`
  (plain editable column labels) ARE built in this slice**; what's deferred
  is the richer teams object (scoring, roster) layered on top of a grouping
  concept, which `event_groups` deliberately does not attempt.
- No rotation rules / rotation engine.
- No stations (materials/description/staff lead), scoring, or program
  narrative — the "program document" object stays fully deferred.
- No bulk-replace path for `event_groups` or `event_slots` (deliberate,
  mirrors `special_day_slots`).
- No event delete UI (the op-log machinery is built for parity but unwired).
- No "reset event_groups/event_time_blocks to camp defaults" affordance —
  the camp-setup seed (§4) runs once, at first entry, then the two axes are
  independent of the camp's `groups`/`time_blocks` going forward.
- No coupling between this internal grid and the Slice 1 campwide overlay
  cell — the two stay independent facts about the same `events` row.
