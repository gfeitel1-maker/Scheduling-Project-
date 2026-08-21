---
title: "T108 — Day-Overrides re-point: design"
document_type: spec
status: draft
created: 2026-08-21
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related_adrs:
  - docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
related_tickets:
  - docs/work/tickets/T108-day-overrides-repoint.md
archive_when: T108 ships and merges; fold the shipped shape into PLATFORM_STATE
---

# T108 — Day-Overrides re-point: design

Architect design pass, Red-Hat-gated before Maker, per the ticket's own review loop. This document is the
technical design; it does not settle product questions the ADR left open, and it does not write code.

## 0. Candidate approaches considered (divergent pass)

Ran 5 parallel isolated frames (regulator, hostile-competitor, logistics, inversion, remove-the-load-bearing-
assumption) against the same problem statement — see session record for the full pool. Four of five frames
independently converged on the same shape without seeing each other's output: a **separate table, keyed by
(week, day, group), composed at render time through the existing `decideCell` dispatch, and never read by
the engine**. That convergence — not picked because it's the default, but because four independent framings
of "what must be provable" (regulator), "how does this get exploited" (competitor), "what if the entity/grid
constraints are gone" (inversion, remove-assumption) all rejected the alternatives — is the strongest signal
in this design.

Rejected candidates, and why:

- **Radical: no separate entity — express the override as an op-log delta absorbed directly into `template_slots`.**
  (surfaced by the remove-assumption frame). Rejected: this makes an override indistinguishable from a real
  placement at the storage layer, which is exactly the "third canonical schedule by stealth" failure the
  competitor frame flagged independently (a cell with no provenance stamp is a cell a director starts trusting
  as ground truth, and it becomes unrecoverable — you can't tell "director placed this" from "override says
  this" once it's the same row). It also makes the override load-bearing to the engine, which the remove-
  assumption and regulator frames both name as the thing to avoid.
- **Radical: override as a free-text expression evaluated live ("group X: swim→art, Thu").** Rejected: fails
  the regulator frame's "must be provable, traceable, refusable" test outright — untyped, unindexable, can't
  compose with `group_id`/`activity_id` FKs the rest of the schema uses, can't be validated at write time.
- **Radical: override as a pointer living on the group ("today I am elsewhere"), not the grid.** Rejected on
  fit: T108 explicitly requires block-level and activity-level granularity (a swim→art swap for one group),
  not just a group's whereabouts; a single pointer per group per day can't express "block 3 becomes art,
  block 4 stays swim."
- **Sync/conflict-resolution routing through the full `conflicts` table + `resolveConflict` machinery**
  (competitor frame). Not rejected outright — flagged as real risk (§3.4) — but scoped out of v1: the app is
  pre-production with no live camp data (per standing owner guidance), the existing manual-route write-queue
  serialization already narrows the concurrent-edit window for same-cell writes, and building full conflict
  UX for a feature that doesn't exist yet is speculative ahead of real multi-device override usage. Recorded
  as an explicit follow-up trigger in §7, not silently dropped.
- **Group roster-drift resolution via alias/membership lookup at render time** (competitor frame). Rejected
  as premature: groups are not merged/split/renamed with any regularity documented in this codebase (no
  existing alias mechanism for `groups`, unlike the S1b camper-alias system built for reconciliation), and
  building one for a hypothetical is exactly the over-engineering `karpathy-guidelines` warns against. If it
  becomes a real problem, the group_id FK plus a "referenced group no longer exists" render-time check (which
  this design already needs, see §2) surfaces it rather than silently misapplying.

## 1. Deterministic evidence this design is built on

Established by direct code reading (Explore agent), cited here as facts, not judgment:

- `day_override_templates` / `day_override_template_slots`: `electron/db/schema.sql:549-562`. No `group_id`
  anywhere; parent is `cohort_id` (FK to `cohorts`), not a rendered-day binding. No indexes declared.
- `CURRENT_SCHEMA_VERSION = 37` in `electron/db/localDb.js`; the most recent migration (v37) is T106/special-
  days-notes. **The next version for this work is v38.**
- `DayOverridesScreen.jsx` (`src/screens/DayOverridesScreen.jsx`, 459 lines) is pure CRUD over those two
  tables via `localClient` field writes, delete-all-slots-then-recreate on save, reachable from the sidebar
  (`src/components/layout/navSections.js`). `frequency_mode` is dead: default `'reduced'`, persisted, never
  surfaced in UI, documented at lines 10-15 as forward-compat scaffolding for a mode that was never built.
- Confirmed by full-repo grep: **nothing under `src/screens/ScheduleScreen.jsx`, `src/components/schedule/`,
  `src/engine/buildSchedule.js`, or `src/engine/weekCatalog.js` reads `day_override_template*`.** Every other
  hit is generic entity plumbing (sync, import, permissions, op-log projection) or the CRUD screen itself.
- `template_slots` (the real per-cell schedule row): `id, template_id, group_id, activity_id, day_id,
  time_block_id` (+ `flags, is_released, is_span_head, anchor_id, is_anchor, elective_set_id`) —
  `electron/db/schema.sql:304-321`.
- `template_overlays` (the existing "field trip stamp" feature — **the direct precedent this design reuses**):
  `id, template_id, unit_id, day_id, from_block_order, to_block_order, label` —
  `electron/db/schema.sql:519-527`. Rendered by `overlayForCell(...)` in
  `src/screens/schedule/gridGeometry.js:64-99`, dispatched in each view's `decideCell(...)`
  (e.g. `ScheduleGroupView.jsx:166-186`) which already branches `empty | overlay | slot`.
- `schedule_weeks`: `id, camp_id, name, sort_order, is_archived` (`electron/db/schema.sql:470-476`).
  `days_of_operation`: `id, camp_id, label, day_of_week, sort_order` (`:412-418`) — **camp-global, not
  week-scoped.** There is no existing first-class `(week_id, day_id)` join row anywhere; that pairing exists
  today only implicitly, at the child level (`template_slots.day_id` + the parent template's `week_id`).
- `week_activity_exclusions` / `week_group_exclusions` / `week_location_exclusions`: all `week_id`-scoped
  only, no `day_id` — an exclusion today is whole-week, never one day within it. Materially different shape
  from what T108 needs.
- Flag composition seam, confirmed exact: `src/screens/ScheduleScreen.jsx:163-176` — `slots` is a `useMemo`
  pipe: `withWeekClosureFlags(rawSlots, {...})` (line 163), then `withOverlapFlags(...)` only when
  `route === 'manual'` (172-173). UNFILLABLE is persisted at generate time by the engine, not derived here.
- Engine precedent for "authored week-scoped modifier, engine must not fight it": `src/engine/weekCatalog.js`
  (`resolveWeekCatalog`, lines 18-74) filters excluded activities/groups/locations **out of the catalog before
  the engine runs** — the GENERATE route's mechanism. The MANUAL route has a structurally different, parallel
  mechanism: `src/utils/computeWeekClosures.js` derives a soft `WEEK_CLOSED` flag **after** placement, because
  manual placements can't be gated the way the generate catalog can (file header, lines 1-21, states this
  explicitly). Two different mechanisms, same concept, wired together at the one `ScheduleScreen.jsx` seam
  above. This is the load-bearing precedent for §2 below: T108 needs an analogous pair, not one unified
  mechanism.
- `buildSchedule.js`: confirmed zero references to exclusions or day-override tables; takes `preplacedSlots`
  (signature comment lines 10-13, consumed at 68, 81, 158, 344-346).
- Leaf grid layer: `src/components/schedule/{SlotCell,EmptyCell,CellInlineEditor,SpecialDayCell}.jsx`.
  `CellInlineEditor` is mounted by both `SlotCell.jsx:353` and `EmptyCell.jsx:77` — confirmed as the one
  shared inline-write target (point-of-intent authoring, T112). `EmptyCell.jsx:7-10` documents it as the
  post-T112 dedupe of three prior per-view copies, sharing `onPlace` / `onCreateNew` / `onCreateElective`
  commit props across `SlotCell` and `EmptyCell`.

## 2. The (week, day) binding

**Recommendation: bind the override to `(schedule_week_id, day_id, group_id)`, all real foreign keys — not
a raw recurring `day_of_week` integer.**

This directly resolves a risk four separate divergent frames raised in different words (competitor: "an
override outlives the week it was authored for and ambient-resurrects for an unrelated future cohort";
inversion: "bind by composite FK with cascade from schedule_week, not a freestanding date"): `schedule_weeks`
rows are already camp/season-scoped, non-recurring entities — a specific week 3 of a specific camp's
schedule, not "Tuesdays in general." Binding to `schedule_week_id` (FK, `ON DELETE CASCADE`) plus `day_id` (FK
to `days_of_operation`) inherits that scoping for free; there is no separate expiry mechanism to build,
because the week itself is the expiry boundary. `day_of_week` integers were considered and rejected — they
recur every year, which is exactly the "ambient resurrection" failure mode surfaced independently.

Render composition, not a separate slot set: the override is a **diff overlaid on the existing route's
already-resolved slots at render time**, reusing the `template_overlays` precedent exactly (§1). It is not
a third table of full replacement rows and it is not a third route. Concretely:

- New table `day_overrides` (see §4) holds one row per `(schedule_week_id, day_id, group_id, time_block_id)`
  — the finest grain the grid already renders at (one cell). Each row is a **diff-intent**: `swap` (new
  `activity_id`) or `pull` (`activity_id = NULL`, cell renders as explicitly-pulled, not "not yet filled").
- At render time, `decideCell(...)` in each view gains one more branch, evaluated **after** the existing
  `empty | overlay | slot` resolution and **before** flag computation: if an override row exists for this
  `(week, day, group, block)`, its diff-intent is applied to whichever slot is already there (Manual's
  director-placed slot, or Generated's engine-placed slot) to produce the rendered cell. This is engine-blind
  by construction (remove-assumption frame, competitor frame, regulator frame all independently named this
  as required): `buildSchedule.js` is never touched and never queries `day_overrides`.
- Because the override is a diff against "whatever is there," it survives regeneration without needing a
  reconciliation step: regenerating the Generated route replaces the underlying `template_slots` row, the
  override still applies on top of whatever the engine placed next. This is deliberately simpler than the
  regulator frame's "detect staleness via a snapshot hash" idea — that idea is real but is over-engineering
  for a diff-based (not replacement-based) design: a `swap` override does not care what was underneath, only
  what replaces it, so there is nothing to go stale. The one case that *is* worth surfacing is named in §3.3.

## 3. The group axis

**Recommendation: `day_overrides.group_id`, a plain FK to `groups(id)` — the same axis `template_slots`
already uses, not a new cohort-resolution layer.**

This is the concrete gap named in the ticket (`day_override_template_slots` has no `group_id` at all today;
its only scoping is `day_override_templates.cohort_id`, one level up and coarser than the grid's real
per-group axis). Making the new table's grain match `template_slots`'s grain — one row addressable by
`(group_id, day_id, time_block_id)` — is not a new structural idea, it is copying the axis the grid, the
engine, and every other schedule-adjacent table (`week_group_exclusions`) already use. No new lookup
mechanism, no alias/membership resolution (rejected in §0): `group_id` is looked up the same way every other
table's `group_id` is.

### 3.1 Whole-day pulls vs single-block swaps

"Pull one group for a trip" (whole day, every block) and "swap one block's activity" (single block) are both
expressible as N rows of the same shape — one row per affected `time_block_id`, `activity_id = NULL` for a
pull, an activity id for a swap. A "pull the whole day" author action is a UI convenience (write one row per
block in that day for that group) over the same table, not a distinct schema shape. This mirrors how
`template_overlays` already represents a block-range as `from_block_order`/`to_block_order` — but the override
table does **not** need a range column, because unlike an overlay (a label with no per-block content), a
diff-intent's content genuinely differs block to block (block 3 becomes art, block 4 stays swim), so one row
per block is the correct grain, not a compressed range.

### 3.2 Multiple groups affected by one authored action

A director pulling three groups for one trip authors three (or more) rows in one save, exactly as
`DayOverridesScreen.jsx`'s existing save flow already does today (delete-all-then-recreate for the set being
edited, `src/screens/DayOverridesScreen.jsx:138-176`) — that batching pattern is reused, just re-scoped to a
`(week, day)` instead of a template. No new batching mechanism is needed.

### 3.3 What "engine-blind" costs at the group axis specifically

One hardening item surfaced independently by the competitor frame and folded in here rather than deferred:
a `swap` override that changes a group's activity for a block changes that block's capacity/contention
picture (the group now competes for the swapped-to activity's location/staff capacity), which the existing
per-route flag mechanisms (`OVERLAP` on Manual, `UNFILLABLE`-at-generate-time on Generated) were never told
about, because they run before the override diff is applied. **Fix: apply the override diff to `slots`
*before* `withOverlapFlags`/`withWeekClosureFlags` run in the `ScheduleScreen.jsx:163-176` pipe, not after.**
Both existing flag functions already operate on a plain `slots` array and don't know or care whether a given
row came from a real placement or an applied override — feeding them the post-override array is sufficient
and requires no change to either function. This composition order is the one substantive constraint Maker
must not get backwards; get it right and OVERLAP correctly fires against a swapped-in activity's contention on
the Manual route for free.

## 4. Data model: additive migration v38, not a re-shape of the existing tables

**Recommendation: new tables, old tables emptied of responsibility but not dropped in this migration.**

`day_override_templates`/`day_override_template_slots` cannot cleanly carry the `(week, day, group)` binding —
they are structurally a *template* (reusable, detached, cohort-scoped), and the ADR's own D5 language is "an
override becomes a set of block-level swaps/cancels bound to a `(week, day)`," which is a different shape, not
a widened one. Retrofitting `week_id`/`day_id`/`group_id` columns onto the existing tables while `cohort_id`
and the template/parent-child structure remain would leave three ways to scope the same row (cohort, template
grouping, and the new week/day/group binding) — a shallow, confusing shape the codebase-design skill's "can I
simplify the parameters" test rejects outright. New tables keep the seam clean and match the "delete-old"
pattern this codebase already uses for schema-shape changes (v23's `kind` column addition being the
counter-example: v23 *added a column* because the old and new concepts were the same entity with a new
distinguishing field; here the old and new concepts are genuinely different entities, so the plural-candidate
ADR's own precedent of a new table, not a widened one, is the closer fit).

```sql
-- v38
CREATE TABLE IF NOT EXISTS day_overrides (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  schedule_week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  day_id TEXT NOT NULL REFERENCES days_of_operation(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  time_block_id TEXT NOT NULL,
  activity_id TEXT REFERENCES activities(id),   -- NULL = pull (cell renders "pulled", not "not filled yet")
  kind TEXT NOT NULL DEFAULT 'swap',             -- 'swap' | 'pull' — explicit, not inferred from activity_id NULLness
  note TEXT,                                     -- optional director-facing reason ("Trip to lake"), record-and-print, D2 precedent
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_day_overrides_cell
  ON day_overrides(schedule_week_id, day_id, group_id, time_block_id);
```

Notes on choices, each stated so Red Hat can challenge them directly:

- `kind` is explicit rather than inferred from `activity_id IS NULL`, matching this codebase's own stated
  reason for `schedule_templates.kind` being load-bearing rather than inferred (plural-candidates ADR, "the
  route must be recoverable from the row itself, not inferred"). The same argument applies here: inferring
  `pull` from a NULL activity is one accidental `NULL` write away from being silently indistinguishable from
  "no override, nothing to apply" — actually inferable but confusable, so keep it explicit and cheap.
  **This is a deliberate, cheap departure from strict minimalism** (karpathy-guidelines: "no configurability
  that wasn't requested") because it forecloses a real, adjacent-precedent-verified failure mode rather than
  hypothetical flexibility — the T108 ticket already asks for both swap and pull as first-class behaviors, so
  this is not speculative.
- No FK from `time_block_id` to a `time_blocks` table — matches the existing (unenforced) pattern in both
  `template_slots.time_block_id` and the old `day_override_template_slots.time_block_id`. Not introduced by
  this migration; not fixed by this migration either (out of scope, karpathy "surgical changes").
- No `template_id` column at all. This is the mechanism by which the override stays route-agnostic: it never
  points at a `schedule_templates` row (Manual's or Generated's), only at `(week, day, group, block)`. The
  render composition in §2/§3 resolves it against **whichever route's slots are on screen** at render time —
  this is what lets one authored override apply identically to both routes without ever picking one as
  canonical, satisfying the plural-candidates ADR by construction rather than by a per-route opt-in flag
  (an idea one divergent branch raised and this design rejects as unnecessary complexity: nothing here needs a
  route to be told about, because the override never stores a route).
- The unique index enforces "at most one override per cell" — a second write to the same cell overwrites
  (same UI pattern `DayOverridesScreen.jsx` already uses: save is delete-then-recreate for the edited set).

**`day_override_templates`/`day_override_template_slots`: not dropped in v38.** Per the ADR's own migration
note ("Day-Overrides re-point may need a small additive `(week,day)` binding column; pre-production, low
risk") and Article IV's destructive-operation gate, dropping tables that (per the ADR context) may have real
authored rows on some dev/test database is a separate, explicit decision, not a side effect of this migration.
Recommendation: leave the two old tables in schema, stop routing any UI or read path to them, and file their
removal as a follow-up migration once Red Hat/Grader confirm the new path is live and no data depends on the
old one. This keeps v38 purely additive — no `DELETE`, no `DROP TABLE` — which is the same "no Article IV gate
reached" property the plural-candidates ADR's own migration used as its design goal.

`frequency_mode` removal (owner-ratified conscious reversal, per the ADR) happens as part of retiring
`day_override_templates` from the read/write paths — since nothing reads `day_override_templates` after this
ticket ships, the field's removal is moot in the new schema and does not need its own migration step; it
simply isn't carried into `day_overrides`.

**Projection registration:** `day_overrides` must be added to `electron/ops/projections.js`'s field list and
to `campScopedEntities.js`'s parent-scoping (parent = `camp_id`, matching `week_activity_exclusions`'s pattern
of being camp-scoped-not-template-scoped — an override is scoped to the week/day/group, never to a specific
template row, consistent with §4's "no `template_id` column" decision above). It must also be added to
`electron/auth/permissions.js` alongside the other schedule-adjacent camp-scoped entities.

**Rollback:** additive-only migration, same shape as v23's "leave the column, don't reverse the ALTER"
guidance — leave `day_overrides` in place on a downgrade (empty table costs nothing), do not attempt to
resurrect `day_override_templates` as the active path. If a downgrade must run on a database with real
`day_overrides` rows, that data is not recoverable by the old screen (different shape) — same Article IV
stop-and-consult-director pattern the plural-candidates ADR uses for its own rollback, not a new pattern.

## 5. Two-route render + flag composition

Composition point is exactly `src/screens/ScheduleScreen.jsx:163-176`, one more stage in the existing
`useMemo` pipe, **before** `withWeekClosureFlags`/`withOverlapFlags` (§3.3):

```
rawSlots → applyDayOverrides(rawSlots, overridesForThisWeekDay) → withWeekClosureFlags(...) → [manual: withOverlapFlags(...)]
```

`applyDayOverrides` is a new pure function (precedent: `computeWeekClosures.js`, `withOverlapFlags` — both
already pure, render-time, `slots`-in/`slots`-out functions with no IPC or React dependency), living beside
them, e.g. `src/utils/applyDayOverrides.js`. It takes the resolved `slots` array plus the `day_overrides` rows
for the current `(schedule_week_id, day_id)` and returns a new `slots` array where matching cells are
rewritten per `kind` (`swap`: replace `activity_id`; `pull`: `activity_id = NULL` and a distinguishing marker,
see below) — same shape contract every other stage in this pipe already honors, so nothing downstream (grid
render, flag functions) needs to know the concept "override" exists.

**Visual distinction — "changed for this day."** Every overridden cell carries a provenance marker through the
pipe, not just a paint-time lookup: `applyDayOverrides` stamps `is_overridden: true` (and, for audit/print,
`day_override_id`) onto the row it rewrites. This directly answers the inversion frame's "a UI that lets you
edit an overridden cell without a distinct marker produces a slot indistinguishable from a real placement" —
the marker travels with the row through both `decideCell` and, later, any export/print surface, not only the
live grid. `SlotCell.jsx` gains one more conditional visual treatment keyed on `is_overridden`, following the
existing `scheduleGrid.css` data-attribute pattern (per CLAUDE.md's documented exception for that one file):
`data-overridden="true"` → a border/background treatment distinct from `OVERLAP`'s existing flag styling, so
the two don't visually collide. This is a **new ephemeral-but-persisted cell state** — per CLAUDE.md's own
rule, it belongs as a data attribute + CSS rule inside `scheduleGrid.css`'s already-scoped boundary, not new
React state and not a new inline style.

**Flag composition, concretely, per route:**

- Manual: an overridden cell still gets `WEEK_CLOSED` and `OVERLAP` evaluated normally against its
  post-override content (§3.3) — an override does not suppress those flags, it changes what they evaluate.
- Generated: `UNFILLABLE` is persisted at generate time and is evaluated **before** the override composition
  stage runs (it's baked into `rawSlots` already). An overridden cell therefore can carry both `UNFILLABLE`
  (the engine couldn't fill it) and `is_overridden` (the director then hand-fixed it) simultaneously — this
  is correct and desired: it shows the director both "the engine gave up here" and "you fixed it," not one
  overwriting the other. No special-case code needed; this falls out of the two markers being independent
  boolean-ish flags on the same row.

**DESIGN_STANDARD §5/§8 (UI-significant change):** the override render is not a new screen, it's a new visual
state on the existing leaf grid layer plus a new authoring interaction (§6). Loading/error states: applying an
override is a local IPC write through the existing `writeFields`/`bulkReplace` path already used by every
other schedule mutation — no new async state machine, inherits the existing write-failure surfacing
(`describeWriteFailure`, per the "surface every write failure" standing rule) and the existing per-cell write
queue (`DnD FSM`/write-serialization work already shipped) rather than introducing a second one. Motion: the
override marker should use the same transition treatment `OVERLAP`/flag-appearance already gets on write
(no new animation vocabulary needed — reuse, don't invent). Reduced motion: inherits whatever the existing
flag-appearance transition already does for `prefers-reduced-motion`, since this is the same visual layer, not
a new one — if that flag transition currently has no reduced-motion fallback, that is a pre-existing gap
outside this ticket's scope, not one this design introduces or is responsible for fixing.

## 6. Authoring surface

**Recommendation: retire `DayOversScreen.jsx`'s CRUD-template model; author in place on the rendered day.**
The ADR's own language leans this way ("open a day and just start changing it") and the codebase already has
the exact mechanism this needs: T112's point-of-intent inline authoring (`CellInlineEditor`, shared by
`SlotCell`/`EmptyCell`, §1). Concretely:

- Opening any cell on a rendered day (either route) via the existing `CellInlineEditor` path, when that cell's
  content differs from what the director types/picks, **is** the authoring action — no separate "override
  editor" screen. Committing through `onPlace`/`onCreateNew` (existing props) writes a `day_overrides` row
  scoped to that `(week, day, group, block)` instead of (or in addition to, per route) mutating
  `template_slots` directly. This reuses 100% of the existing leaf-layer commit path; the only new code is
  which table the commit writes to, decided by call-site context ("I am editing inside an override-authoring
  interaction" vs "I am placing normally").
- Open question for Governor (see §8): whether *every* manual edit on a day should become an override row
  (which would blur "manual editing" and "override authoring" into one concept — likely wrong, since Manual
  route edits are already first-class `template_slots` writes with their own semantics) or whether override
  authoring needs a distinct, explicit gesture (e.g., a per-day "Override this day" toggle that puts the
  grid into override-authoring mode, after which cell edits on that day write to `day_overrides` instead of
  `template_slots`). This document recommends the latter — an explicit mode — because conflating the two
  would mean every ordinary Manual-route edit silently becomes a `day_overrides` row for that week's real,
  first-class candidate schedule, which is a category error (Manual route edits are not overrides; they are
  the schedule). **This is a product-shape call the design cannot make silently** (see §8).
- `DayOversScreen.jsx`'s standalone CRUD, its cohort/frequency_mode model, and its sidebar nav entry are
  removed (not kept as a parallel path — an unused parallel authoring surface is the exact "detached template
  nothing renders" failure mode this ticket exists to fix, just relocated).

## 7. Interaction with the engine

Confirmed by §1: `buildSchedule.js` has zero references to override or exclusion tables today, and the
exclusion precedent shows this codebase's existing pattern for "authored week-scoped modifier the engine
must not fight" is **pre-filtering the catalog, not runtime awareness inside the engine.** Applied here:

- The engine **never reads `day_overrides`** and is not modified by this ticket. This was independently named
  as required by three divergent frames (regulator: "engine-blind by construction... buildSchedule.js never
  queries the override tables at all"; remove-assumption: same; inversion: same) and matches §1's confirmed
  fact that `weekCatalog.js`, not the engine itself, is where exclusions are handled.
- **Regeneration does not need to "interact" with an active override at all**, because the override is a diff
  applied at render time over whatever `template_slots` currently holds (§2) — regenerating the Generated
  route replaces the underlying row; the override reapplies against the new row automatically, with no
  reconciliation step, no staleness check, and no engine change. This is the direct payoff of choosing
  diff-over-replacement in §0/§2 rather than the regulator frame's snapshot-hash staleness-detection idea: that
  idea solves a problem this design doesn't have, because a `swap`/`pull` diff has no notion of "the thing
  underneath changed" — it just always applies to whatever is there. Recorded here as considered-and-not-
  needed, not silently dropped.
- One consequence worth stating plainly for Maker: if a regenerate changes a block's activity underneath a
  `swap` override to something that itself makes the swap meaningless (e.g., the engine now also assigns art
  to that block for that group, and the override was "swap swim→art"), the override still applies — the
  rendered cell is still art, just for a possibly-redundant reason. This is not a bug to fix; it is the
  correct behavior of an engine-blind diff layer, and it is self-correcting the moment a director opens Manual
  Build or re-inspects the day, because the override is visibly marked (§5) rather than silently absorbed.

## 8. Terminology dependency

The setup/ingestion peer's glossary ADR (referenced by the ticket) should own the user-facing noun for this
feature. This design uses "Day Override" / "override" throughout as the working term already established by
the ADR and ticket titles, and defers final copy to that glossary work rather than inventing parallel
vocabulary. No code in this design hardcodes user-facing strings outside the normal `recordLabels.js`-style
lookup table already used for this entity family (`src/screens/recordLabels.js`, confirmed in §1's grep) —
that file's existing `day_override_template` entries should be updated to `day_overrides` and centralized
there, not duplicated inline in the grid components.

## Files/modules affected

**New:**
- `electron/db/schema.sql` — `day_overrides` table (v38 position), replacing the `day_override_templates`/
  `day_override_template_slots` block's role (old tables stay declared, unused).
- `electron/db/localDb.js` — migration v38 block; `CURRENT_SCHEMA_VERSION` 37 → 38.
- `src/utils/applyDayOverrides.js` — pure render-time composition function (new file, sibling to
  `computeWeekClosures.js`).
- `src/utils/applyDayOverrides.test.js` — unit tests (swap, pull, multi-group, engine-blind-on-regenerate
  scenario, flag-composition-order scenario from §3.3).

**Modified:**
- `electron/ops/projections.js` — register `day_overrides` fields.
- `electron/ops/campScopedEntities.js` — parent-scope `day_overrides` to `camp_id`.
- `electron/auth/permissions.js` — add `day_overrides` alongside other schedule-adjacent entities.
- `src/screens/ScheduleScreen.jsx:163-176` — insert `applyDayOverrides(...)` stage in the `slots` pipe, before
  `withWeekClosureFlags`.
- `src/components/schedule/ScheduleGroupView.jsx`, `ManualBuildView.jsx`, `ScheduleDayView.jsx` —
  `decideCell(...)` gains override-awareness (reads the already-composed `is_overridden` marker; no new branch
  logic needed here since composition happens upstream in §5's pipe, not per-view).
- `src/components/schedule/SlotCell.jsx` — `data-overridden` attribute + visual treatment.
- `src/components/schedule/scheduleGrid.css` — new rule for `[data-overridden="true"]`.
- `src/components/schedule/EmptyCell.jsx` / `CellInlineEditor.jsx` — override-authoring-mode commit routing
  (writes `day_overrides` instead of `template_slots` when the day is in override-authoring mode, per §6's
  open question — exact prop/mode name is a Maker decision once §8's product question is answered).
- `src/screens/recordLabels.js` — update entity label entries.
- `src/components/layout/navSections.js` — remove the standalone Day Overrides sidebar entry.

**Removed:**
- `src/screens/DayOverridesScreen.jsx` and its test.
- Any route wiring that renders `DayOverridesScreen` as a screen (`src/App.jsx`'s `SCREENS` map entry).

**Not touched:** `src/engine/buildSchedule.js`, `src/engine/weekCatalog.js` (confirmed no engine change
needed, §7).

## Reused vs. new

**Reused:** the `template_overlays`/`decideCell` render-composition pattern (§1, §5); the `ScheduleScreen.jsx`
`useMemo` flag-pipe seam (§3.3, §5); `computeWeekClosures.js`/`withOverlapFlags`'s pure-function shape as the
template for `applyDayOverrides`; the `CellInlineEditor` point-of-intent authoring path (§6); the
`scheduleGrid.css` data-attribute pattern for new ephemeral cell state (§5, per CLAUDE.md's documented
exception); the camp-scoped-entity/projection/permissions registration pattern every other entity already
follows; `DayOverridesScreen.jsx`'s existing delete-then-recreate batch-save shape, re-scoped (§3.2).

**New:** the `day_overrides` table and its `(week_id, day_id, group_id, block)` grain (the actual gap named
by the ticket); `applyDayOverrides.js`; the override-authoring-mode toggle/gesture on the grid (§6, pending
§8's open question); the `is_overridden` visual marker and its CSS rule. Nothing here duplicates an existing
mechanism — the new pieces are exactly the "new group axis" and "live two-route render" the ticket names as
the real gap, sized to that gap and no larger.

## ADR required: yes

This changes a shipped table's meaning (per the ticket's own review-loop line) and introduces a new persistent
data shape other code will depend on (the override diff-composition contract other schedule code must not
violate — e.g., any future feature that reads `slots` downstream of `applyDayOverrides` must know overridden
rows carry `is_overridden`/`day_override_id`, the same way code today must know about `is_span_head`). It also
makes a non-obviously-reversible product-shape choice: route-agnostic binding (no `template_id`) versus
per-route opt-in, which this design picks and defends in §4 but which is exactly the kind of tradeoff the
ADR bar names ("a tradeoff that isn't obviously reversible"). Recommend filing as
`docs/adr/2026-08-2X-day-overrides-repoint-shape.md`, scoped narrowly to: the `day_overrides` table shape and
its route-agnostic binding, the diff-vs-replacement choice and why regeneration doesn't need reconciliation,
and the engine-blind constraint. It should record this design's §0 divergence-convergence explicitly (four
independent frames converging on the same shape is worth preserving as the "why," not just the "what") and
supersede exactly the parts of the 2026-08-20 ADR's D5 that this document resolves — that ADR ratified only
the *direction* and explicitly deferred the shape to this pass.

## Open questions for Governor

1. **Override-authoring gesture (§6).** Does opening a day for override-authoring need an explicit mode
   toggle (this design's recommendation), or should there be some other clearly-scoped entry point (e.g., a
   button on the day header, "Override this day," that scopes every subsequent edit on that day/route view to
   `day_overrides` until closed)? This is a UX-shape decision, not a technical one — Designer should weigh in
   before Maker, since it's the one part of this design without a concrete existing precedent to point to.
2. **Whether a `pull` override should also clear the group's assignment for print/export purposes** (i.e.,
   does "pulled" mean "shown as pulled" or "omitted entirely" on a printed/exported day) — a product framing
   question the D2 record-and-print precedent doesn't directly answer, since `day_overrides` is schedule data,
   not the special-day notes field D2 covers.
3. **Whether the old `day_override_templates`/`day_override_template_slots` tables should be dropped in a
   follow-up migration immediately after this ships, or left indefinitely** — recommend Governor set a
   concrete trigger (e.g., "next schema-touching ticket after T108 ships and Grader confirms the new path is
   live") rather than leaving it open-ended, matching this codebase's stated preference for explicit triggers
   over speculative retention (D2's own "structure only when a concrete behavior needs it" reasoning applies
   symmetrically to removal).
4. **Confirm scope: sync-conflict handling for concurrent overrides on the same cell across two devices is
   explicitly deferred to a follow-up** (§0), relying on the existing per-cell write-queue serialization and
   last-write-wins at the op-log level, consistent with how `template_slots` writes already behave today for
   the same race. If Governor wants this hardened as part of T108 rather than after, that changes the
   estimate materially (it is the one candidate this design deliberately did not adopt into scope).
