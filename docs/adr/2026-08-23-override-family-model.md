---
title: "Override family model — is Special Days/Events/Day Overrides/Field-Trip stamps one entity?"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-23
approved: "Owner-approved 2026-08-23 — OQ1 resolved: accept the 2×2 distinguisher, keep the four tables separate, unify Special Days + Events at the DISPLAY layer only (Roots heading). Drop the confirmed-dead day_override_templates pair. No schema merge."
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/camp-setup-ingestion-program.md
  - docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md
related_adrs:
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md
  - docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
  - docs/adr/2026-08-22-events-overlay-placement.md
  - docs/adr/2026-08-22-event-internal-subschedule.md
  - docs/adr/2026-08-21-day-overrides-repoint-shape.md
  - docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md
amends:
  - docs/adr/2026-08-21-day-overrides-repoint-shape.md (§Q3 — fires the drop trigger for day_override_templates/day_override_template_slots)
archive_when: owner approves or rejects the recommendation below and, if approved, the IA/cleanup slice ships
---

# Override family model — is Special Days/Events/Day Overrides/Field-Trip stamps one entity?

## 0. The question

The owner keeps sensing that "event" and "special day" (and their siblings) are the same underlying
thing the app has split apart, and that the only distinguisher ever articulated is **span** — a block
overlay vs. a whole-day override vs. "could be either" (a field trip). Their instinct: one `override`
object parametrized by span, with "event"/"special day" as span labels. Governor's prior read agreed.
This ADR pressure-tests that hypothesis against the live schema, the live rendering/engine code, and
four real camp artifacts, and recommends a position with confidence.

**Answer up front: keep the tables separate, but replace the fuzzy "we've always done it this way"
justification with a crisp, testable, non-span distinguisher — a 2×2 of two real properties
(interior structure, main-grid presence) that the existing four live tables already exactly fill.
Confidence: high (0.8).** One dead table pair is confirmed and should be dropped in this same PR
(its removal trigger, set in `2026-08-21-day-overrides-repoint-shape.md` §Q3, is "next schema-touching
PR" — this is that PR). One IA change is recommended alongside the schema decision: visually unify
Special Days and Events under one Roots setup entry, because the owner's confusion is real and is an
IA problem, not a schema problem — see §6.

## 1. Current-state audit — all six tables

| # | Table(s) | schema.sql | Status | What it actually is |
|---|---|---|---|---|
| 1 | `template_overlays` | :554 | **LIVE** | A free-text **label stamped across a block-span** on the main grid, **generated route only**. `(template_id, unit_id, day_id, from_block_order, to_block_order, label)`. No `activity_id`, no entity link — it is not "an activity," it is a caption. UI: `EmptyCell.jsx:27-31` "stamp mode (field-trip overlay tool)", rendered by `src/components/schedule/OverlayCell.jsx`, painted via `ScheduleGroupView.jsx:211-221`/`ScheduleDayView.jsx:170-180` fill-handle drag, mutated through `scheduleRepository.js:277-350` (`writeOverlayFields`, `updateOverlayRange`, snapshot restore). This is the original "special event" stamp the owner is remembering — it predates both `special_days` and `events`. |
| 2 | `special_days` + `special_day_slots` (+ `special_day_time_blocks`) | :710, :763, :746 | **LIVE** | A **fully detached, whole-day, own-grid document**. Own screen `SpecialDaysScreen.jsx`, own time blocks (seeded from camp time blocks but independently owned), own slots keyed `(special_day_id, group_id, time_block_id)`. **Never placed as a cell on the main weekly grid** — no binding to any `schedule_week_id`/`template_id` at all (confirmed: `day_id`/`schedule_week_id` columns don't exist on this table). Free-text `notes` for rosters/points/staffing, explicitly "recorded and printed, never solved/parsed" (schema.sql comment above :710). **Author-only by design** — `2026-08-20-special-days-authoring-and-day-override-repoint.md` §D3b forbids adding it to `INGESTIBLE_ENTITIES`. |
| 3 | `events` + `event_slots` (+ `event_time_blocks`, `event_groups`) | :853, :912, :892, :904 | **LIVE, two-mode** | The `events` row is placed as an **opaque cell on the main grid** via `template_slots.event_id` — a contend-and-coexist citizen per `2026-08-23-unified-schedule-overlay-model.md` D2, one of `MUTUALLY_EXCLUSIVE_FIELDS` (`electron/ops/projections.js`), span-mergeable (Arbitrary-Length Activity Span, PR #145), engine-tracked via `eventLookup` (`src/engine/buildSchedule.js:176-182,246,372,435`). Drilling into that cell opens `event_slots`, a **structural mirror of `special_day_slots`** but with the event's own regroupable `event_groups` as columns instead of camp groups. Own screen `EventScreen.jsx`. So `events` is genuinely two things wearing one name: a main-grid occupant (like an activity) *and* a detached interior sub-schedule (like a special day) reached by drilling in. |
| 4 | `day_overrides` | :936 | **LIVE** | A **single-cell swap/pull marker** directly on the main grid. `UNIQUE(schedule_week_id, day_id, group_id, time_block_id)` — one row per overridden cell, `kind` = `'swap'`\|`'pull'`. Merged into rendered slots by `applyDayOverrides` (`ScheduleScreen.jsx:184`, loaded via `useScheduleData`, restored on snapshot restore `ScheduleScreen.jsx:424`). Route-agnostic by construction (no `template_id` column — composed as a render-time diff, per `2026-08-21-day-overrides-repoint-shape.md` D2). No interior, no owned time-block/group structure — it is a pointer, not a document. |
| 5 | `day_override_templates` + `day_override_template_slots` | schema.sql (search hit only; no line audited separately, same region as #4) | **DEAD** | The pre-repoint shape `day_overrides` (#4) replaced. Confirmed dead: no screen writes to it (`grep -rl day_override_templates src --include=*.jsx` → only `ImportScreen.jsx` and `ReconciliationScreen.jsx`, both read-only best-effort list calls with `.catch(() => [])`; `readiness.js:29` only comments on its cohort_id shape). schema.sql's own comment at the table says "retained, unused — see Q3 in the ADR for the removal trigger," and `2026-08-21-day-overrides-repoint-shape.md` §Q3 sets the trigger explicitly: **"retire now (v38 additive, no DROP), drop in the NEXT schema-touching migration."** This ADR is that migration. **Recommendation: drop both tables in the implementation slice below.** |

Six tables, five live concepts (four distinct behaviors + one two-mode entity), one dead pair.

### How the engine and grid treat each

- **Main-grid-occupying, capacity-contending** (`2026-08-23-unified-schedule-overlay-model.md` D2's "contend-and-coexist" family): `events`-as-placed-cell (`eventLookup`), alongside anchors/electives. These reserve a `(group, day, block)` slot other placements can't also use.
- **Main-grid-occupying, non-contending**: `day_overrides` (a swap/pull is a correction to what's already there, not a fresh capacity claim) and `template_overlays` (a label has no activity, so capacity accounting is moot — confirmed by the unified-overlay ADR's own scope note: "This does not touch `special_days`/`day_overrides`/`template_overlays`").
- **Off-grid entirely**: `special_days` (never touches `template_slots`/`schedule_week_id`) and `event_slots` (the drilled-into interior, once you're inside an event cell).

This is exactly the "override-and-replace" side of D2 in the prior ADR (`special_days` + `event_slots` + `day_overrides` + `template_overlays`, explicitly named as a group there but not further decomposed). This ADR picks up where that one stopped: within that named group, is it one thing or four?

## 2. Grounding against real data

Two real artifacts bear directly on this:

- **Owner's 2 per-group xlsx**: "All Camp Activity" (Tue) reads as a **recurring event** (contend-and-coexist, handled by `anchor_activities`/`events`-as-cell) — no special day involved. Confirms the contend-family already covers the common "everyone does one big thing at once" case without needing the override-and-replace family at all.
- **Camp Aaron bunk-schedule PDF, Friday "Special Event and Mitzvah Project"**: takes over the **afternoon only** (morning is a normal grid), spanning **multiple blocks × all groups**. Pressure-testing this against today's four mechanisms:
  - Not `special_days` — that's whole-day-only by construction (no partial-day binding exists), and this is an afternoon, not a day.
  - Not a single `day_overrides` row — that's one `(group, day, block)` cell; this is many groups × many blocks, and there is no first-class grouping that says "these N override rows are one thing."
  - Not `template_overlays` — that's a caption with no activity/structure; a mitzvah project plausibly needs its own interior (who's doing what, at least at the free-text level).
  - **Closest fit today: `events`-as-placed-cell**, using the existing span-merge capability (PR #145) to cover the whole afternoon across every group's row, with `event_slots` as the interior if the mitzvah project itself has structure worth recording. This is the pattern that already exists and already handles it — the gap is not a missing table, it's that a director building this by hand has to notice "oh, this is an Event" rather than reaching for "Special Day" first (the more familiar-sounding name for "not a normal day").

So the real-data boundary **holds**, but only because `events` already absorbed the partial-day, multi-block, multi-group case — it does not blur into needing `special_days` and `events` to become the same table. It does confirm the IA-level confusion the owner is sensing: a director hunting for "how do I record Friday afternoon" has two plausibly-named entry points (Special Days, Events) and no guidance on which one fits a partial-day takeover. That is a naming/navigation problem, not evidence the tables are redundant.

## 3. Steelman: KEEP separate

The four live override-and-replace tables are not four arbitrary variations of one span-parametrized
thing. They are the four cells of a real 2×2 formed by two independent, load-bearing properties:

|                              | **Has an interior** (owns its own time-block/group sub-schedule) | **Flat marker** (no interior) |
|---|---|---|
| **Occupies a main-grid cell** (contends for capacity, per D2) | `events` (placed cell + `event_slots` drill-in) | `day_overrides` (single-cell swap/pull) |
| **Fully detached** (no `schedule_week_id`/`template_id` binding at all) | `special_days` (own day, own grid, printed) | `template_overlays` (span label, generated route only) |

Both axes are already architecturally consequential, not incidental:

- **Main-grid presence** is exactly D2 from `2026-08-23-unified-schedule-overlay-model.md`, approved one day before this ADR: whether a placement must flow through `template_slots`, `MUTUALLY_EXCLUSIVE_FIELDS`, and the engine's `locationCapById`/`eventLookup` capacity accounting, or whether it sits entirely outside that machinery. Collapsing `special_days` and `events` into one table would either (a) force `special_days` through capacity accounting it was deliberately exempted from (2026-08-20 §D3b: author-only, never ingested, never contends), or (b) require a runtime branch inside the merged table's write path keyed on whether a row happens to have a `template_slots` binding — which is a worse shape than two tables, not a better one.
- **Interior vs. flat-marker** determines whether a `time_blocks`/`groups`-shaped child schema is needed at all. `day_overrides` and `template_overlays` are single rows with no children; forcing them to carry the same optional interior tables `events`/`special_days` need (even as nullable/unused) is the "flexibility nobody asked for" anti-pattern (karpathy-guidelines) — most `day_overrides`/`template_overlays` rows would never populate it.

**Span is a real, visible difference between these four, but it is downstream of these two properties, not the cause of the split.** `day_overrides` and `template_overlays` are both flat markers — one is single-cell, one is multi-block, but they differ in span *within* the same "flat marker, on-grid-ish" cell, not because span alone justified two tables. The genuine architectural reason two markers exist rather than one is a smaller, second-order question (see §6, not in scope for a merge decision).

**Additional case for keeping separate**: this is a **stored-data-shape change on synced (op-log) tables**. `special_days`/`events`/`day_overrides`/`template_overlays` are all in `campScopedEntities.js`, `projections.js`, `undoReferences.js`, `restore.js`, `deleteWeek.js`, `syncClient.js` — a merge touches every one of those plumbing modules plus the engine (`eventLookup`/`anchorLookup` conditionals in `buildSchedule.js`), `applyDayOverrides`, snapshot restore (`schedule_snapshots.overlays`/`day_overrides_json`), two screens, and ingest. The last three schema-touching PRs (v43/v44/v45, per project memory) each failed a gate on a missed sibling test, a mirror-constant drift, or a version canary — exactly the failure class a four-table merge would multiply, not the class a same-shaped-but-renamed table would avoid.

## 4. Steelman: MERGE into one `overrides` object

The strongest case for merging, taken seriously:

- **Director mental model**: nobody who runs a camp thinks in "contend-and-coexist" vs. "override-and-replace." They think "this day/period is different from normal." A single `overrides` table with `span_kind` (`'block'`\|`'span'`\|`'day'`) and `label`/`activity_id`/nullable-interior-FK would let one setup screen, one list, one create flow serve all four cases, directly answering the owner's and Governor's shared instinct and simplifying the Roots setup IA (§6) at the schema level instead of only the display level.
- **Shared columns already**: all four have `id`, `camp_id`-reachable scope, a name/label, and some notion of span (block range, or whole day). The overlap is real, not imagined — the owner is not wrong that there's a common shape.
- **Fewer places to teach the same lesson**: one write path, one undo/restore/sync integration to get right, instead of four (and the historical gate failures in §3 are partly evidence that four parallel shapes are error-prone to maintain in lockstep).
- **Migration would be additive-only, pre-production**: per project bias (accepted tradeoff, no real camp data yet), a merge could in principle be a clean cutover rather than a dual-write period — lowering the usual migration-risk objection somewhat.

Where this steelman breaks: it has to explain away D2, approved literally one day prior, which says the contend/override split is the load-bearing one for the *engine* — and a director-facing `overrides` table spanning both sides of D2 either re-introduces a runtime branch the engine has to test on every read (defeating the purpose of the unified-overlay ADR's `template_slots` cell-content model), or the "merge" is actually a UI-only illusion over four still-separate tables, in which case it isn't a schema merge at all — it's the IA recommendation in §6, arrived at from the other direction.

## 5. Recommendation, with confidence

**Keep the four tables separate. Confidence: high (0.8).** The 2×2 in §3 is a genuine, testable, non-span distinguisher (ask of any new "not a normal day" case: does it need its own interior? does it sit on the main grid?) — not a post-hoc rationalization of history. The merge case in §4 is real but its actual payload is a director-facing IA improvement, which is cheaper and lower-risk to deliver without touching the schema (§6) than by merging synced tables one day after the axis that would be erased was just approved.

**Operational tradeoff for the owner**: keeping four tables means four places a future feature request ("can a day override have a sub-schedule too?") has to be evaluated against the 2×2 rather than assumed inherited from a merged base — slightly more design overhead per future request, in exchange for not re-litigating D2's capacity-accounting boundary and not re-running the sync/op-log/migration risk that has burned the last three schema PRs. Given no real camp is on this data yet but the sync/op-log machinery itself is real and load-bearing regardless of camp count, this ADR weighs the migration-discipline cost as still applying in full (per the prompt's own framing) — that is the deciding factor over the "pre-production, bias bold" default.

**What should still change**: drop the confirmed-dead `day_override_templates`/`day_override_template_slots` pair now (§1 row 5; this is that table's already-declared removal trigger), and ship the IA unification in §6 as a separate, schema-free slice.

## 6. Consequences

### 6a. Dead-table removal (do now, this PR)

- Drop `day_override_templates` and `day_override_template_slots` from `schema.sql`.
- Remove their references from `campScopedEntities.js`, `projections.js`, `undoReferences.js`, `restore.js`, `deleteWeek.js`, `syncClient.js`, `permissions.js`, `localClient.mock.js`, `existingSnapshot.js`, `recordLabels.js`.
- `ImportScreen.jsx` and `ReconciliationScreen.jsx`'s best-effort `.list('day_override_templates').catch(() => [])` calls become dead reads — remove them (their `.catch` already tolerates the table not existing, so removal is safe, not just inert).
- `readiness.js:29`'s comment referencing `day_override_templates`'s cohort_id shape needs updating to drop the now-removed table from the enumerated list.
- Add a rollback migration (`electron/db/rollback/`) mirroring the existing `v24_down.js`/`v26_down.js` pattern, since those precedents exist for exactly this kind of table-level rollback.
- **Standing hazard to test against** (per the v43/v44/v45 gate failures cited in §3): a sibling test asserting on the full table list, a mirror DDL constant (if `localDb.js` has a `DAY_OVERRIDE_TEMPLATES_DDL`-style constant, per the `EVENTS_DDL`/`ELECTIVE_SETS_DDL` precedent visible at :853/:1 in schema.sql), and any version-canary test asserting current schema version — all three classes must be swept, not just the CREATE TABLE statement.

### 6b. Slice 5 (deferred override-class ingest surfacing)

Unaffected in shape — the four-table model this ADR affirms is exactly what Slice 5 was scoped against. No rework.

### 6c. Post-4b backlog: Roots setup order lists Special Days and Events separately

**Recommend: unify at the display layer, not the schema layer.** Roots' setup-order list can group Special Days and Events under one visual heading ("Special Schedule Things" or similar — Designer's call, not this ADR's) while the underlying entities, screens, and write paths stay separate. This directly answers the owner's felt "these are the same thing" without inheriting the migration/engine risk in §3. If Designer/Governor pursue this, the concrete change is confined to the Roots setup-order component and its label data — no `.claude/agents` architectural change, no ADR-level decision beyond this one.

## 7. Open questions for Governor / owner

1. Does the owner accept the 2×2 distinguisher in §3 as the crisp, non-span answer they asked for, or does the director-mental-model argument in §4 outweigh it regardless of the engine-side cost? This is the single highest-stakes decision in this ADR — everything else (dead-table drop, IA unification) is uncontroversial and can proceed either way.

   > **RESOLVED 2026-08-23 (owner):** accept the 2×2 — keep the four tables separate; deliver the "these feel like one thing" experience at the **display layer** (unify Special Days + Events under one Roots heading, §6c), **not** a schema merge. Drop the confirmed-dead `day_override_templates`/`day_override_template_slots` pair now (§6a).
2. Should the Roots setup-order IA unification (§6c) be scoped as its own ticket now, or held until a director-facing signal (real camp data) confirms the confusion is worth spending a Designer pass on?
3. Is dropping `day_override_templates`/`day_override_template_slots` (§6a) wanted in this same PR, or should it be split into its own small, easily-verified PR given it touches ~10 plumbing files across `electron/ops/*` and `electron/sync/*`?
