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
- The engine already receives a per-week pre-pass: `resolveWeekCatalog()` (src/engine/weekCatalog.js),
  called by `generate()`, `placeFixedEvents()`, `computeFindings()`, `recalcFindings()` and
  `restoreSnapshot()` (graph: `graphify affected "resolveWeekCatalog()"`, 19 nodes, all five behavioural
  callers confirmed above). `buildSchedule()` is already `weekId`-aware.
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
| `week_id TEXT NOT NULL REFERENCES schedule_weeks(id)` | hard FK, same as `week_activity_exclusions`. |
| `day_id TEXT NOT NULL` | **soft** reference to `days_of_operation` (no SQL REFERENCES): days are deterministic camp-wide rows and a placement whose day later disappears is ignored at resolution, not a constraint failure. |
| `special_day_id TEXT NOT NULL REFERENCES special_days(id)` | the one mutable field; this is where a cross-device clash lives. |

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
- A freshly-created column order question does not arise (new table, free order, fixed in the DDL).
- **Version collision risk:** v91 is already claimed twice (#772 / T311 pending-tables drop; #762 / T348). N is chosen only when slice 1 starts, after #772 lands (expected v92), re-checked against #762 and every local worktree. Re-check `origin/main`'s
  `CURRENT_SCHEMA_VERSION` and open PRs at Slice 1 start; renumber the guard if it moved.

### D4 - Engine interaction: one choke point, `resolveWeekCatalog`

`buildSchedule` stays unmodified and ignorant of special days. `resolveWeekCatalog` already runs before
every engine entry and findings recompute, so it gains two inputs (`dayPlacements`, `days`) and one output
(`days`, the effective days with replaced ones removed, plus `replacedDayIds`). All five callers pass the
effective `days` on to `buildSchedule`/`computeFindings`. Consequences, each pinned by a test:

1. The engine generates nothing on a replaced day, for Generated. Manual builds nothing up front so there
   is nothing to skip; its replaced day is simply not a drop target (D6).
2. Locked/electives/events pre-placement and fixed events that fall on a replaced day are dropped from
   the engine's input for that day (their stored rows are untouched).
3. Findings (UNFILLABLE, FIXED_EVENT_DUPLICATE, min_per_week/prefer_before_day goals) are computed against
   the effective days, so a replaced Tuesday does not produce "unfilled" noise and a min_per_week goal is
   judged against the days that actually run. This is a behaviour change worth a visible test and a
   Tester pass: a goal that needed Tuesday may now be unmeetable and must say so rather than vanish.
4. **Non-destructive:** the stored `template_slots` rows for a replaced day are retained, hidden at render.
   `generate()` writes via a bulk replace of the whole template, so it must carry forward the existing
   rows for replaced days into its payload; otherwise unbinding after a regeneration would silently
   leave the day empty. Unbinding therefore restores exactly what the director had.
5. Resolution ignores placements whose `week_id` differs, whose `day_id` is not in `days`, or whose
   `special_day_id` no longer resolves (orphan = no replacement; the normal day shows).

### D5 - Conflicts

| Case | Behaviour |
|---|---|
| Two devices bind **different** special days to the same (week, day) offline | Same derived id on both. They merge into one row with two concurrent writes to `special_day_id`; the existing field-level mechanism records a `conflicts` row and a human resolves it with `resolveConflict`. Until resolved, Automerge's deterministic winner renders, and the day is marked as having an unresolved conflict. Neither device silently wins forever. |
| One special day bound to **two** days (or two weeks) | Allowed and intended: two rows. Deleting the special day cascades both. |
| Same-device bind to an occupied (week, day) | Not a conflict: it is a *replace*. The UI asks once ("Week 2 Tuesday already uses Color War. Use Visiting Day instead?") and writes the existing id's `special_day_id`. |
| Concurrent *creation* of the same derived id | **Load-bearing risk.** If Automerge treats two concurrent inserts of the same map key as distinct objects, the loser's fields could be dropped rather than recorded as a field conflict. The existing derived-id entities (`days_of_operation`, `schedule_templates`, `locations`) rely on the same property, so a precedent exists, but Slice 1 MUST begin with a two-document concurrent-create test asserting the outcome and the `conflicts` row. If it fails, the fallback is a random-id row plus a deterministic "lowest id wins at read" rule, recorded as a decision update here. |

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

`exportToExcel`, the JSON export and `exportWorkbook` receive the resolved replacements and print the
special day's grid (its own blocks x groups) and its notes in place of the normal day, identically for
whichever route the director chooses at export time (the route choice is not remembered; unchanged).
`exportScheduleRoundTrip.test.js` gains a replaced-day case.

### D8 - Undo, history, unbinding

Binding and unbinding are single `appendOp` writes (create/field-set and delete), so they are in the
device-local history ledger, appear in entity history, and unbinding is a delete that is restorable from
Trash through the generic `restoreEntity` path once the entity is registered in `undoReferences.js` and
`restore.js`. Unbinding is one action on the special day ("Unbind from Week 2 Tuesday") and one on the
replaced lane; neither destroys the day's stored slots (D4.4). Cascades: `deleteWeek` removes a week's
placements; `deleteSpecialDay` removes its placements; `duplicateWeek` copies them (a duplicated week keeps
its shape, recommendation; flagged to the owner below). Cascade order follows deleteWeek's documented
children-before-parents rule.

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
  unknown `special_day_id` is tolerated (D4.5), never thrown.

## Consequences

- **Positive.** The product gap closes with no engine rewrite: one choke point, one new table, one pure
  resolver. Reuse of a special day across weeks works. The cross-device clash is a first-class `conflicts`
  row instead of silent last-write-wins. Unbinding is lossless.
- **Costs.** One table = the full registration surface (projections, campScopedEntities, campDocument,
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
- One resolution choke point: **0.8.** Evidence: graph shows five callers of `resolveWeekCatalog`, all
  already week-aware. Unverified: the concurrent same-key creation behaviour (D5) - tested first.

## Open questions for the owner

1. Can one special day be placed on more than one day (for example Visiting Day in every week)? The design
   allows it and the recommendation is yes; if you say no, it becomes a one-line check in the bind action.
2. Do printouts need real calendar dates ("Tue, July 8"), or is "Week 2 - Tuesday" enough? The
   recommendation is week and weekday only. Dates would need a start date on each week and are a separate
   ticket; nothing here blocks adding them.

Defaults decided here without asking: replacing keeps the old day's schedule intact and restorable; a
duplicated week keeps its special-day placements; a half-day takeover is not a special day (use an Event,
per the override-family ADR).
