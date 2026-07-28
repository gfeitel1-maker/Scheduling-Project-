---
title: T2-group-view-drop-targets
document_type: ticket
status: open
created: 2026-07-26
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: fix merged and Verifier PASS recorded
---

# T2 — Group-View Drop Targets from Persistent Palette

**Spec:** `docs/workflow/specs/2026-07-26-manual-grid-editing.md`  
**Risk:** Moderate  
**Depends on:** T1  
**Blocks:** T3

---

## What to build

Enable drag-and-drop from the ActivityPalette sidebar into the **Group View** grid (`ScheduleGroupView`). Today, DnD only works in ManualBuildView. The Group View should accept palette drops on open (non-anchor, non-locked) slots.

## Observable completion evidence

1. In Group View: dragging an activity chip from the sidebar and dropping it on an empty slot places the activity, evaluates flags, and persists via `writeFields` — identical behavior to ManualBuildView placement.
2. Dragging onto an anchor slot produces a visible rejection (no drop highlight, no write).
3. The existing Group View DnD (slot-swap drag between filled cells) still works after this change.
4. Day View and Activity View sidebar chips are non-draggable (static) — dropping from them is not possible.

## Files expected to change

- `src/screens/ScheduleScreen.jsx` — move (or add) a `DndContext` wrapper that covers both the sidebar and the Group View grid. The existing PointerSensor instance (`sensors`, `distance: 8`) should be reused. Verify this does not conflict with the overlay fill-drag (`fillState`) or the ExpandHandle drag — both use separate DnD interaction types.
- `src/components/schedule/ScheduleGroupView.jsx` — add `useDroppable` to empty slot cells (equivalent to the existing `EmptyDropCell` in ManualBuildView). Pass an `onPlaceActivity` prop from ScheduleScreen.
- `src/components/schedule/ManualBuildView.jsx` — its internal `DndContext` may need to be removed or kept depending on the DnD context lift decision. If a single ScheduleScreen-level DndContext covers both, ManualBuildView's internal one must be removed to avoid nested contexts.

## Design spec reference

Designer spec Section 1.4 (Sidebar interactivity by view), Section 1.5 (DnD context boundary — OQ-4).

## Governor resolution of OQ-4

Lift the `DndContext` to ScheduleScreen level so it covers both the sidebar (when in Manual Build or Group View modes) and the target grid. Day View and Activity View: sidebar chips are rendered as non-draggable (`disabled` on `useDraggable`). This avoids having two nested DnD contexts.

## Test seam

- Unit: `ScheduleGroupView` with a mock `onPlaceActivity` prop — verify `useDroppable` cells pass the correct `{ groupId, dayId, blockId }` data.
- Integration (dev mode): drag activity from sidebar to empty slot in Group View → slot fills, flag evaluated.
- Integration: drag onto anchor cell → no state change, no write attempted.

## Notes

- The `onPlaceActivity` function (`placeActivityManual` in ScheduleScreen) already handles flag evaluation and the `writeFields` call — do not duplicate this logic.
- Check that the ExpandHandle drag (`expandDrag` data shape) is not accidentally caught by the Group View's `onDragEnd` handler. Use `active.data.current?.paletteActivity` to discriminate palette drags from expand drags.
