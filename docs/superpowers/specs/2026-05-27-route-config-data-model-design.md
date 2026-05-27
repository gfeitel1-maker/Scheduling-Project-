# Route Configuration Data Model — Design Spec

**Date:** 2026-05-27  
**Status:** Approved  
**Sub-project:** 1 of 3 (Data Model → UI → Engine Evolution)

---

## Overview

This spec covers the schema changes needed to support a configurable scheduling engine — one that can express a wide range of camp structures through a single general model rather than being hard-coded to any one camp's setup. The central new concept is the **cohort**: a cluster of groups that share a time structure, week range, anchor model, and capacity rules.

---

## Organizational Hierarchy

The hierarchy changes from two levels to four:

```
camp → cohort → tier → group
```

| Level | Table | Notes |
|---|---|---|
| camp | `camps` | Unchanged. Owns the activity library and days of operation. |
| cohort | `cohorts` | **New.** Owns time blocks and anchor activities. Defines scheduling dimensions. |
| tier | `tiers` | Existing. Now scoped to a cohort instead of just a camp. |
| group | `groups` | Unchanged. Cohort membership inferred via `tier → cohort`. |

A camp with traditional age divisions and a separate specialty program has two cohorts — each with its own tiers and groups — both under the same camp.

---

## New Table: `cohorts`

```sql
CREATE TABLE cohorts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id              uuid NOT NULL REFERENCES camps(id),
  name                 text NOT NULL,
  -- Dimension: Temporal scope
  session_week_start   integer NOT NULL DEFAULT 1,
  session_week_end     integer NOT NULL DEFAULT 1,
  -- Dimension: Capacity source
  capacity_source      text NOT NULL DEFAULT 'groups_per_slot'
    CHECK (capacity_source IN ('groups_per_slot', 'camper_headcount')),
  -- Dimension: Anchor model
  anchor_model         text NOT NULL DEFAULT 'none'
    CHECK (anchor_model IN ('none', 'fixed', 'floating')),
  sort_order           integer DEFAULT 0,
  created_at           timestamptz DEFAULT now()
);
```

### Four dimensions

| Column | Dimension | Meaning |
|---|---|---|
| `session_week_start` / `session_week_end` | Temporal scope | Ordinal weeks within the session this cohort is active. Main camp = 1–5. A 2-week mid-session specialty = 3–4. |
| `cohort_id` on `time_blocks` | Time structure | Each cohort defines its own time blocks. Cross-cohort conflict detection uses `start_time`/`end_time` ranges, not FK. |
| `capacity_source` | Capacity source | `'groups_per_slot'` = current model (max N groups simultaneously). `'camper_headcount'` = location person-limit with group headcounts. |
| `anchor_model` | Anchor model | `'none'` = no anchors. `'fixed'` = anchors locked to specific day + block. `'floating'` = anchors constrained to a day window, engine places within it. |

---

## Existing Tables — Changes

### `tiers`
- Add `cohort_id uuid NOT NULL REFERENCES cohorts(id)`.
- Tiers are now cohort-scoped. A specialty cohort has its own tiers; the traditional cohort has its own tiers.
- `camp_id` stays — used for RLS.

### `time_blocks`
- Add `cohort_id uuid NOT NULL REFERENCES cohorts(id)`.
- Each cohort defines its own set of time blocks. Two cohorts running the same schedule will have matching rows — fully self-contained per cohort.
- `camp_id` stays — used for RLS.

### `anchor_activities`
- Add `cohort_id uuid NOT NULL REFERENCES cohorts(id)`.
- Anchors are scoped to a cohort and reference that cohort's time blocks.
- A camp-wide concept (e.g. Opening) becomes one anchor row per cohort, each pointing to its cohort's equivalent time block.
- `camp_id` stays — used for RLS.

### `activities`
- Add `span_blocks integer NOT NULL DEFAULT 1`.
- An activity that always occupies 2 consecutive blocks (swim, Theater Production, Sport Workshop) has `span_blocks = 2`. The engine reserves N contiguous blocks when placing it.
- Sub-labels within a multi-block activity (e.g. Change, Instructional Swim, Recreational Swim) are internal to the activity name — not separate DB entities.

### `schedule_slots` and `template_slots`
- Add `is_span_head boolean NOT NULL DEFAULT true`.
- For a `span_blocks = 2` activity, two slot rows are created — one per block. The first block has `is_span_head = true`; the second has `is_span_head = false`.
- The UI uses `is_span_head` to render a visual double-block and to keep drag-and-drop coherent (moving the head moves the pair).

### `groups`
- No change. Cohort membership is inferred via `tier_id → tiers.cohort_id`.

---

## New Tables: Day-Type Overrides

Week-to-week exceptions (field trips, color war, special events). Not recurring day-of-week patterns — those are anchors.

### `day_override_templates`

Reusable named override configuration, scoped to a cohort.

```sql
CREATE TABLE day_override_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id          uuid NOT NULL REFERENCES camps(id),
  cohort_id        uuid NOT NULL REFERENCES cohorts(id),
  name             text NOT NULL,
  frequency_mode   text NOT NULL DEFAULT 'reduced'
    CHECK (frequency_mode IN ('reduced', 'best_effort')),
  created_at       timestamptz DEFAULT now()
);
```

`frequency_mode`:
- `'reduced'` — `min_per_week` / `max_per_week` targets scale proportionally to the available slots remaining after override blocks are removed. Field trip weeks are lighter weeks.
- `'best_effort'` — targets unchanged; engine does what it can without forcing.

### `day_override_template_slots`

Which blocks are replaced and what they become.

```sql
CREATE TABLE day_override_template_slots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES day_override_templates(id),
  time_block_id   uuid NOT NULL REFERENCES time_blocks(id),
  activity_id     uuid REFERENCES activities(id)  -- NULL = clear/free this block
);
```

### `schedule_day_overrides`

Applies a template to a specific calendar date in a specific schedule run.

```sql
CREATE TABLE schedule_day_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id      uuid NOT NULL REFERENCES camps(id),
  schedule_id  uuid NOT NULL REFERENCES schedules(id),
  override_date date NOT NULL,
  template_id  uuid NOT NULL REFERENCES day_override_templates(id)
);
```

---

## Engine Contract

### Caller's responsibility (before engine call)

The engine stays pure — no DB queries, no resolution logic. The caller:

1. Queries cohorts, their tiers, groups, time blocks, and anchor activities.
2. Resolves `anchor_activities` → pre-placed slots per cohort.
3. Resolves `schedule_day_overrides` for the target week → additional pre-placed slots; scales `min/max_per_week` targets proportionally if `frequency_mode = 'reduced'`.
4. Calls `buildSchedule()` with assembled inputs.

### New signature

```js
buildSchedule({
  cohorts: [
    {
      cohort,          // { id, anchor_model, capacity_source, session_week_start, session_week_end }
      timeBlocks,      // cohort's own time blocks
      tiers,           // cohort's tiers
      groups,          // cohort's groups
      preplacedSlots,  // anchors + day overrides, already resolved
      activityTargets, // min/max per week, already scaled for override weeks
    },
    // ...one entry per cohort
  ],
  days,       // camp-wide days of operation (unchanged)
  activities, // camp-wide activity library (unchanged)
  campId,
}) → { slots, stats, conflicts }
```

`anchors` is removed from the top-level input — fully resolved into `preplacedSlots` by the caller.

### Three-pass processing

**Pass 1 — Per-cohort independent scheduling**  
Run the existing group-first seeded-PRNG scheduler for each cohort in isolation using that cohort's time blocks, groups, tiers, and pre-placed slots. `span_blocks` activities reserve N contiguous blocks before placement. Activity targets use the caller-provided scaled values.

**Pass 2 — Cross-cohort resource conflict detection**  
Merge draft slots from all cohorts. Group by `activity_id` + overlapping time range (compare `start_time`/`end_time` — not FK). If the combined group count across cohorts exceeds `max_groups_per_slot`, flag affected slots with `cross_cohort_conflict`. Conflicts are flagged, not auto-resolved.

**Pass 3 — Audit + output**  
Existing audit pass runs per-cohort. Combined output is the union of all cohort slots.

### Output shape

- `slots` — union of all cohort slots. Each slot carries `cohort_id` (denormalized). `flags` JSONB gains `cross_cohort_conflict` key.
- `stats` — per-cohort stats array + combined summary.
- `conflicts` — new. Array of `{ activity_id, time_range, cohort_ids, group_ids, over_by }`. Empty for single-cohort runs.

### Backward compatibility

Single-cohort camps pass `cohorts` as a one-element array. Engine behaviour is identical to today — Pass 2 is a no-op, `conflicts` is always `[]`.

---

## Migration Path

Run once per existing camp. All steps are additive — no existing data is modified or removed.

> **Migration note:** Columns added as `NOT NULL` must follow the nullable-first pattern: add column as nullable → backfill all rows → add `NOT NULL` constraint. This is how all three FK columns (`cohort_id` on `tiers`, `time_blocks`, `anchor_activities`) must be added in practice.

| Step | SQL summary |
|---|---|
| 1 | `INSERT INTO cohorts` — one "Main" cohort per existing camp (`session_week_start = 1`, `session_week_end = 1`, defaults for all dimensions) |
| 2 | Add nullable `cohort_id` to `tiers`, backfill via JOIN to camps, then `SET NOT NULL` |
| 3 | Add nullable `cohort_id` to `time_blocks`, backfill, then `SET NOT NULL` |
| 4 | Add nullable `cohort_id` to `anchor_activities`, backfill, then `SET NOT NULL` |
| 5 | `span_blocks integer DEFAULT 1` added to `activities` — no backfill needed |
| 6 | `is_span_head boolean DEFAULT true` added to `schedule_slots` and `template_slots` — no backfill needed; existing single-block slots are trivially the head of a 1-block span |
| 7 | Day override tables created empty — no migration data needed |

After migration every existing camp is a valid single-cohort camp. All current screens, queries, and the engine continue to work unchanged.

---

## RLS Policies

All new tables follow existing patterns.

| Table | Policy |
|---|---|
| `cohorts` | `camp_id = get_my_camp_id()` |
| `day_override_templates` | `camp_id = get_my_camp_id()` |
| `day_override_template_slots` | Join through template: `template_id IN (SELECT id FROM day_override_templates WHERE camp_id = get_my_camp_id())` |
| `schedule_day_overrides` | `camp_id = get_my_camp_id()` |

---

## What This Spec Does Not Cover

- **Sub-project 2:** Route Configurator UI — the screen(s) that let a camp admin define and manage cohorts, assign tiers, configure time blocks per cohort, and set up day override templates.
- **Sub-project 3:** Engine Evolution — the full implementation of multi-cohort scheduling in `buildSchedule.js`, including the cross-cohort conflict resolution UI in ScheduleScreen.
