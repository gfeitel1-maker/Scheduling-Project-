# Schedule Iteration Features Design Spec

**Date:** 2026-05-23

---

## Overview

Three features that make the schedule regeneration loop faster and more controllable for camp directors: flag explanations with dismissal, activity-level slot locking, and named schedule snapshots.

---

## Feature 1 — Flag Explainability + Dismissal

### Goal

Directors can see *why* a flag was raised and dismiss it when the situation is intentional.

### Engine Changes

`buildSchedule.js` adds a `_reason` string key alongside each flag it sets during the audit phase. The reason is a short human-readable sentence explaining what triggered the flag.

Flag key pattern:
```js
{ UNDERSERVED: true, UNDERSERVED_reason: "Goal: 3×/wk — 2 eligible blocks remain after anchors" }
{ UNFILLABLE: true, UNFILLABLE_reason: "No eligible groups available for this block" }
{ WEATHER_RISK: true, WEATHER_RISK_reason: "Outdoor activity scheduled during Weather mode" }
{ DISTRIBUTION: true, DISTRIBUTION_reason: "Activity appears in 4 consecutive blocks" }
```

Reasons are written as complete sentences. The engine already knows the data to compute these at flag time.

### FlagDetailModal Changes

- Adds a **Reason** column showing `flags.FLAGNAME_reason` for each flagged slot row.
- Adds a **Dismiss** button per row. Clicking it writes `FLAGNAME_dismissed: true` into that slot's `flags` JSONB in `template_slots` via a Supabase update.
- Dismissed flag rows are hidden from the modal list.
- The topbar flag count excludes dismissed flags.

### SlotCell Changes

- Flag dots show the reason text on hover via the `title` attribute.
- Dismissed flags do not render a dot.

### Regeneration Behavior

Regeneration deletes and replaces all `template_slots` rows. Dismissals are stored in those rows' `flags` JSONB, so they are naturally wiped on regen — no special cleanup needed.

---

## Feature 2 — Activity-Level Slot Locking

### Goal

Directors can lock an activity so regeneration leaves its assignments in place. They can manually release individual cells as an escape hatch. Locks persist across sessions until explicitly removed.

### Database Schema

```sql
-- Add to activities table
ALTER TABLE activities ADD COLUMN is_locked boolean DEFAULT false;

-- Add to template_slots table
ALTER TABLE template_slots ADD COLUMN is_released boolean DEFAULT false;
```

### Lock Logic

**Locking:** Single-clicking any slot in Day view that belongs to an unlocked activity sets `activities.is_locked = true` for that activity. This locks all of that activity's slots across all groups and days.

**Releasing a cell:** Single-clicking a locked slot sets `template_slots.is_released = true` for just that cell, overriding the activity lock for that one slot.

**Editing:** Right-clicking any slot opens the existing edit modal (current behavior, moved from left-click).

Empty slots (unassigned) have no locking behavior — single-click opens edit modal as before.

### Visual Design — Locked Slot

```
Border:     2px solid #E8A020
Background: #FFFBF0
Text color: #7A5100
Corner:     Top-right triangle fold (CSS border trick, amber)
```

Released cells that belong to a locked activity render with normal activity colors (no amber styling).

### Engine Integration

Before placement, the engine reads locked activities and their non-released slots and treats them as pre-placed. The engine does not move or reassign those slots. Released cells are treated as available for reassignment.

### Persistence

Lock state lives in the DB. It survives page reloads and sessions. The only way to remove a lock is for the director to click the locked slot to release it, or release the entire activity by clicking a toggle (see UX note below).

**UX note:** The Versions dropdown (Feature 3) and the topbar can display a count of locked activities. There is no bulk-unlock in this spec — that can be added later.

---

## Feature 3 — Named Schedule Snapshots

### Goal

The engine auto-saves a snapshot before every regeneration. Directors can name and keep any version and restore it if they don't like the new result.

### Database Schema

```sql
CREATE TABLE schedule_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES schedule_templates(id) ON DELETE CASCADE,
  name        text,          -- null = auto-save
  is_auto     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  slots       jsonb NOT NULL  -- full array of slot objects at save time
);

CREATE INDEX ON schedule_snapshots (template_id, created_at DESC);
```

`name` is null for auto-saves. Named versions have a director-supplied name. `is_auto = false` for named versions.

### Auto-Save Behavior

Before every regeneration, the app saves a snapshot with `is_auto = true` and `name = null`. The `slots` JSONB is a full copy of all current `template_slots` rows for the template, captured before the new slots are written.

Auto-saves accumulate. There is no automatic pruning in this spec.

### Named Snapshots

The director types a name in the input at the bottom of the Versions dropdown and clicks "Save as named version." This creates a snapshot row with `is_auto = false` and the provided name, capturing the current slots at that moment.

### Versions Dropdown UI

A "Versions ▾" button sits in the topbar next to Regenerate. Clicking it opens a dropdown panel:

- **Header:** "Version History" + subtitle "Auto-saved before each regeneration"
- **List rows** (newest first):
  - Current version: labeled with its name (or "Auto-save") + "current" badge. No restore button.
  - Other versions: show name (or "Auto-save" in italic) + timestamp. "Rename" button (auto-saves only), "Restore" button.
- **Footer:** Name input + "Save as named version" button.

### Restore Behavior

Clicking Restore for a snapshot:
1. Deletes all current `template_slots` for the template.
2. Inserts the snapshot's `slots` JSONB as new rows.
3. Closes the dropdown and re-renders the schedule.

The state prior to restore is **not** automatically saved. If the director wants to keep it, they should name it before restoring.

### Display

- Auto-save rows show "Auto-save" in italic + monospace timestamp.
- Named rows show the name in bold + monospace timestamp.
- Current version row has a teal "current" badge and no Restore button.
- The "Rename" action on an auto-save converts it to a named snapshot (`is_auto = false`, sets `name`).

---

## Out of Scope

- Bulk unlock all activities
- Auto-pruning of old auto-saves
- Snapshot diffing / visual diff view
- Per-snapshot notes or tags
- Locking individual slots directly (only activity-level lock + per-cell release)
