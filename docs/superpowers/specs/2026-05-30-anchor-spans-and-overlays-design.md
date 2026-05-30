# Anchor Spans and Field Trip Overlays Design

## Goal

Extend the scheduling system so it can generate and display schedules for all program types in a real camp — specialty programs (multi-block morning/afternoon activities), half-day programs, and field trip days — without redesigning the core architecture.

## Background

The current app handles standard rotation schedules well: a program has time blocks, groups are assigned to units within it, and the engine places activities in open slots. This is the foundation.

Looking at a real camp's schedule (33 groups across ~10 program types), all complexity turns out to be extensions of this same foundation — not separate types:

- **Specialty programs** (Omanut/Habimah/Maccabiah/Kesef) = same rotation, but morning blocks 1–2 and afternoon blocks 7–8 are locked to a fixed activity (Ceramics, Theater Production, Sport Workshop). The engine fills the 3–4 remaining open blocks normally. This is just a **multi-block anchor**.
- **Half-day programs** (Preschool) = same rotation, but the program has only 4 time blocks defined, or a multi-block anchor covers the afternoon. The engine fills what's open.
- **Field trips** = not a scheduling concept at all. They're a **post-generation overlay** that sits on top of an already-generated schedule and negates the slots it covers. The underlying schedule is preserved; the overlay suspends it for display purposes.

The key semantic distinction that shapes everything:

> **Anchors** are part of the activity system — they count toward a group's `min_per_week` / `max_per_week` frequency targets.
> **Overlays** are structural suspensions — they don't count toward frequency, don't reference activities, and don't affect the engine at all.

## Architecture

### What already works (unchanged)

- Standard rotation engine: resolve eligibility → place by priority → audit flags
- Single-block anchors per group or all-groups
- `span_blocks` on **activities** (engine already supports multi-block activity placement)
- Day Overrides: change the time block grid structure for specific dates (short days, different times) — this is a separate concern and stays as-is

### What changes: Anchor improvements

**New fields on anchors:**

```
anchors {
  -- existing --
  id, cohort_id, is_all_groups, group_ids[], day_id, time_block_id, activity_id

  -- new --
  unit_id      unit-scoped: auto-expands to all groups in the unit at engine time
  span_blocks  how many consecutive blocks this anchor claims (default 1)
}
```

**Engine change (small):** When building `anchorLookup`, if `span_blocks > 1`, mark the next `span_blocks - 1` consecutive blocks (by `sort_order`) as occupied by the same anchor. Same logic already exists for activities.

**Scope resolution order:** `unit_id` → `is_all_groups` → `group_ids[]`. If `unit_id` is set, expand to all groups in that unit.

**Display change:** When N consecutive blocks in the same column share the same anchor, ScheduleScreen renders them as one merged cell spanning those rows. No repeated identical rows.

**Workaround note:** Double-assigning the same anchor to two blocks already works today. The `span_blocks` field is a data model improvement that makes it configurable as one definition rather than two manual assignments. Existing double-assigned anchors continue to work.

### What's new: Field trip overlays

Field trips are an overlay applied **after schedule generation**. The schedule is generated clean; overlays are added on top. Removing an overlay instantly restores the underlying schedule — no regeneration needed.

**Data shape:**

```
schedule_overlays {
  id
  snapshot_id         which schedule snapshot this belongs to
  unit_id             which unit is affected
  day_id              which day
  from_block_order    first block claimed (inclusive, by sort_order)
  to_block_order      last block claimed (inclusive, by sort_order)
  label               free text — "Field Trip", "Special Event", "Service Project", etc.
}
```

**Render logic:** Before displaying a slot, check if any overlay covers `(unit_id matches group's unit, day_id, block sort_order within from–to range)`. If yes, render the overlay cell instead of the underlying slot. Underlying slot data is untouched.

**Engine impact:** None. The engine never sees overlays.

**Frequency counts:** Unaffected. The underlying anchors and activity slots retain their counts; overlays don't touch them.

### UI: Field trip pull drawer

A slide-out panel in ScheduleScreen, accessible via a toolbar button. Contains named stamps the user can drag onto the schedule.

**Stamps** are free text with suggestions: "Field Trip", "Special Event", "Service Project". No configuration table needed — the label is entered when applying.

**Placing a stamp:**
1. Drag from the pull drawer onto a slot — creates a 1-block overlay at that position
2. A fill handle appears at the corner/edge of the stamped cell

**Fill handle behavior (Excel-style, view-aware):**

- **Day view** (all groups, one day): Fill handle is in the bottom-right corner. Drag **down** to extend across more blocks. Drag **right** to spread across additional groups in the same unit. The scope is explicit — only groups you visually drag across are stamped.
- **Group view** (one group, all days): Fill handle is at the bottom edge only. Drag **down** to extend across more blocks. No horizontal spread — you are viewing one group, the stamp applies only to that group.

**Resizing:** Drag the fill handle back to shrink the overlay. The underlying schedule reappears in the uncovered cells immediately.

**Removing:** Click the overlay cell; a remove/clear button appears.

## Scope: What this enables

| Program type | Before | After |
|---|---|---|
| Standard rotation (Lavan, Kachol, Adom) | ✅ Works | ✅ Unchanged |
| Specialty morning/afternoon (Omanut, Habimah, Maccabiah, Kesef) | ⚠️ Requires manual double-assign per block per group | ✅ One unit-scoped anchor with `span_blocks=2` |
| Half-day (Preschool) | ⚠️ Requires separate program with fewer blocks | ✅ Define 4-block program, or use large span anchor on afternoon |
| Field trips (Rimon every Thu, Kochavim every Tue, Zahav Mon–Thu) | ❌ No mechanism | ✅ Post-generation overlay stamp with fill handle |
| Partial field trips (Zahav blocks 1–7, block 8 still scheduled) | ❌ No mechanism | ✅ Overlay covers only blocks 1–7; block 8 renders normally |

## What this does NOT change

- Internal variable names, component names, database columns
- The engine's core scheduling logic (three passes: eligibility, placement, audit)
- Day Overrides screen and concept
- Snapshot management
- Activity frequency tracking (`min_per_week`, `max_per_week`)
- Any existing anchors — `span_blocks` defaults to 1, fully backward-compatible

## Future work (out of scope)

- Recurring overlays (applying the same stamp to every Thursday automatically) — handled manually for now by applying stamps after each generation
- Cross-program resource conflict detection (swim pool shared across programs) — Sub-project 3
- True 3-level restructure (Camp → Unit → Group collapsing cohort+tier) — previously scoped as Option B
