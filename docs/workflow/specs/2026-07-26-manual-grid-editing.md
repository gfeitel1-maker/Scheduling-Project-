---
title: Manual Grid Editing
document_type: spec
status: active
created: 2026-07-26
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: []
archive_when: all child tickets closed and Verifier PASS recorded
---

# Specification — Manual Grid Editing (Excel-Style Schedule Builder)

**Date:** 2026-07-26  
**Status:** Active — Designer spec complete; undo/redo added 2026-07-26  
**Task state:** `docs/workflow/task-state/2026-07-26-manual-grid-editing.md`

---

## Context and problem

The schedule screen today has two editing modes that don't compose cleanly:

1. **Engine path** — `generate()` fills the grid; users edit by clicking slots or DnD-swapping in Group/Day views.
2. **Manual path** — `placeAnchors()` activates a `ManualBuildView` with an `ActivityPalette` sidebar, accessible only when no schedule exists.

The palette and the manual build view exist but are gated behind the empty-schedule state. Users cannot access Excel-style placement on a generated schedule, and there is no copy/paste or accessible merge/split in any view.

## User-visible success predicate

1. **Persistent sidebar:** The ActivityPalette is visible on the schedule screen whenever setup prerequisites are met (groups, days, time blocks, and activities all defined), regardless of whether a schedule has been generated.
2. **Drag-to-place:** Dragging any activity from the sidebar to any open (non-anchor, non-locked) slot places it, evaluates flags (UNFILLABLE, UNDERSERVED, WEATHER_RISK), and persists via `writeFields`.
3. **Single-cell selection:** Clicking a filled or empty slot selects it (highlighted state). Clicking elsewhere deselects.
4. **Multi-cell selection:** Ctrl+click adds/removes a slot from the current selection. Selection survives across time block rows for the selected group/day.
5. **Copy:** Ctrl+C (or a Copy button) stores the activity assignment of every selected slot into an in-memory clipboard. The clipboard is visible to the user (e.g., a badge or banner naming what was copied).
6. **Paste:** Ctrl+V (or a Paste button), then clicking a target slot, writes the clipboard activity to that slot with flag re-evaluation. Pasting a multi-cell clipboard writes each copied activity in the order they were selected, advancing the target by one slot per paste step.
7. **Merge down:** A "merge down" control on a filled slot (accessible on hover or via a toolbar) merges it with the immediately following time block for the same group and day — calls the existing `expandSlot()` function. Displaced activity appears in the DisplacedPalette as today.
8. **Split:** A "split" control on a merged slot (identified by `is_span_head = true` and `flags.expanded` set) reverses the merge — restores the tail slot's original independence.
9. **Anchor immutability:** Anchor slots remain non-editable and non-droppable throughout all new interaction paths.
10. **Lock respect:** Concurrent field-level locks (the `locks` table) block all new write paths identically to existing writes — the server's `authorize()` call handles this; the client surfaces the error.

## Non-goals

- Horizontal merge (across groups for a shared time slot).
- Keyboard-only grid navigation (arrow keys, Tab focus).
- Palette drag working in the Day view or Activity view (Group/Manual view only).
- New DB tables or schema columns.
- Changing how the Activity view, Day view, or Conflicts screen works.

## Domain terms

- **Slot** — one `template_slots` row: the intersection of one group × one day × one time block.
- **Anchor slot** — a slot where `is_anchor = true`; non-editable, spans blocks determined by the engine.
- **Span** — two or more adjacent slots for the same group+day merged into one visual cell (`is_span_head = true` on the top slot, `is_span_head = false` on tail slots).
- **Clipboard** — in-memory React state; not persisted to the DB. Cleared on page reload or template change.
- **DisplacedPalette** — the existing floating panel (top-right) that receives activities displaced when a slot is merged.
- **Flag** — a constraint violation marker on a slot: UNFILLABLE, UNDERSERVED, WEATHER_RISK, DISTRIBUTION.

## Architecture references

- No ADR required — no new data model. All writes use the existing `template_slots` op-log path via `writeFields`.
- `expandSlot()` (ScheduleScreen.jsx:602) — existing merge implementation, must be called unchanged.
- `placeActivityManual()` (ScheduleScreen.jsx:561) — existing flag-evaluating placement function; paste must reuse this function, not duplicate its logic.
- `ActivityPalette` (src/components/schedule/ActivityPalette.jsx) — existing sidebar component; to be mounted at ScheduleScreen level.
- `ManualBuildView` (src/components/schedule/ManualBuildView.jsx) — existing grid with `EmptyDropCell` targets; palette will be extracted from it.

## Data and security consequences

- All writes go through `writeFields` → `localClient.write` → IPC → `authorize()` → op-log. No new write paths.
- Clipboard is in-memory only; no sensitive data persists beyond the session.
- No auth or permission changes.

## Error and recovery behaviour

- A failed paste write surfaces via `actionError` banner (existing pattern) and leaves the target slot unchanged.
- A failed merge write surfaces the same way; the UI does not optimistically update until write confirms.
- If a slot is locked when paste is attempted, the server returns an error; the client shows the actionError banner.

## Acceptance examples

| Scenario | Expected outcome |
|---|---|
| Setup complete, no schedule generated | Sidebar visible; all slots are EmptyDropCells; dragging places activity with flag eval |
| Setup complete, schedule generated | Sidebar visible alongside existing Group/Day/Activity view toggle; drag onto open slot works |
| Ctrl+click 3 slots, Ctrl+C, click target | Banner shows "3 activities copied"; clicking target places first, advancing pointer |
| Merge-down on a slot with nothing below | Merge-down control disabled or hidden |
| Split on a non-merged slot | Split control not shown |
| Drag from sidebar onto anchor slot | Drop rejected visually; no write attempted |
| Paste onto locked slot | Write fails; actionError banner shows lock message |

## Test seams

- `placeActivityManual(activityId, groupId, dayId, blockId)` — unit-testable flag logic (already partially tested in ScheduleScreen.test.jsx).
- `expandSlot(...)` — existing unit test coverage.
- `splitSlot(groupId, dayId, headBlockId)` — new function; needs unit test for the two writeFields calls and the local state update.
- Clipboard state: pure React state, no IPC; test via component interaction tests.
- Paste multi-cell ordering: integration test — copy [A, B, C], paste sequentially, verify correct slots written.

## Rollout and rollback

- All changes are to renderer-only files (`src/`). No Electron/IPC/DB changes.
- Rollback = revert the relevant commits; no migration needed.

## Undo / Redo

### Scope

A fine-grained, session-scoped undo/redo stack that covers all slot-level edits made during the current session — complementing (not replacing) the coarse-grained snapshot/version system.

**Undoable actions:**
- Drag-to-place from sidebar
- Paste (single or multi-cell — treated as one atomic undo step per paste batch)
- Merge-down (expandSlot)
- Split
- Click-to-edit slot change (EditModal save)
- Clear a slot (set activity_id = null)

**NOT undoable (coarse-grained snapshot system covers these):**
- Generate schedule (bulk replace) — auto-snapshot taken before; clearing the undo stack is correct
- Restore snapshot (bulk replace) — same
- Rename/save snapshot

Generating or restoring a snapshot **clears both the undo and redo stacks.**

### Architecture

`undoStack` and `redoStack` are React state arrays in `ScheduleScreen.jsx`. Each entry is:

```js
{
  description: string,          // human-readable: "Placed Swimming → Kayaks Mon Block 2"
  undo: () => Promise<void>,    // writes previous slot state(s) via writeFields
  redo: () => Promise<void>,    // re-applies the action via writeFields
}
```

Before executing any undoable action:
1. Capture the current state of every affected slot (activityId, flags, is_span_head).
2. Execute the write.
3. Push an `{ description, undo, redo }` entry onto `undoStack`.
4. Clear `redoStack`.

Stack depth limit: 50 entries. When the limit is reached, the oldest entry is dropped.

Undo:
1. Pop the top entry from `undoStack`.
2. Execute `entry.undo()`.
3. Push the entry onto `redoStack`.

Redo:
1. Pop the top entry from `redoStack`.
2. Execute `entry.redo()`.
3. Push the entry onto `undoStack`.

All undo/redo writes go through `writeFields` → op-log, exactly like any other write. They are visible to other connected devices (they appear as new ops that overwrite the previous value).

### Keyboard shortcuts

- `Ctrl+Z` — undo (Windows/Linux) / `Cmd+Z` (Mac)
- `Ctrl+Y` — redo (Windows/Linux) / `Cmd+Shift+Z` (Mac)
- `Ctrl+Shift+Z` — redo (cross-platform fallback)

The schedule screen registers a `keydown` listener (attached when the component mounts, removed on unmount) that intercepts these combinations. The listener must not fire if a modal or input field is focused.

### UI affordance

Two small icon buttons in the controls bar, between the view toggle and the Weather Mode button:

```
[ Group View | Day View | Activity View ]  [ ↩ ] [ ↪ ]  [ ⛅ Weather Mode ]  ...
```

Undo button (`↩`):
- Enabled when `undoStack.length > 0`
- Disabled (opacity 0.35, cursor not-allowed) when `undoStack.length === 0`
- Title: `"Undo: {undoStack[top].description}"` or `"Nothing to undo"` when empty
- On click: executes undo

Redo button (`↪`):
- Enabled when `redoStack.length > 0`
- Same disabled treatment
- Title: `"Redo: {redoStack[top].description}"` or `"Nothing to redo"`

Button style matches the existing control bar pattern (same `padding: '6px 14px'`, `border: '1px solid var(--border)'`, `borderRadius: 6`).

### Error handling

If an undo or redo write fails (network error, lock conflict, permission):
- Surface via the existing `actionError` banner.
- The stack entry is **not consumed** — it remains at the top of its stack so the user can retry.

### Success predicate addition

10. **Undo/redo:** Ctrl+Z reverses the last undoable slot edit; Ctrl+Y re-applies it. Undo/redo buttons in the controls bar reflect available history. Generating or restoring a snapshot clears both stacks.

---

## Unresolved questions (for Designer)

1. Where exactly does the sidebar live in the layout — always-on left panel or collapsible?
2. How is multi-cell selection shown — blue outline? Checkbox? Background fill?
3. How is the clipboard contents surfaced — banner, badge, tooltip?
4. Is merge-down on hover (ExpandHandle already exists) or via an explicit toolbar button?
5. Does the sidebar need to show the DisplacedPalette items too, or do those stay floating?
