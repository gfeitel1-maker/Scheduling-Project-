---
title: T1-persistent-sidebar
document_type: ticket
status: open
created: 2026-07-26
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: fix merged and Verifier PASS recorded
---

# T1 — Persistent ActivityPalette Sidebar

**Spec:** `docs/work/specs/2026-07-26-manual-grid-editing.md`  
**Risk:** Low-Moderate  
**Depends on:** nothing  
**Blocks:** T2, T3, T4

---

## What to build

Extract `ActivityPalette` from `ManualBuildView` and mount it as a persistent left-column sidebar in `ScheduleScreen`, visible whenever `setupIncomplete === false` (groups, days, timeBlocks, activities all non-empty).

## Observable completion evidence

1. `npm run dev` — with setup complete, the 210px ActivityPalette sidebar is visible on the left of the schedule content area in **all** states: no schedule yet, generated schedule, and manual-build mode.
2. Switching between Group / Day / Activity / Manual views does not hide or remount the sidebar.
3. The sidebar collapse toggle (`«` / `»`) shrinks the sidebar to a 28px strip; the grid expands to fill the space.
4. `ManualBuildView` no longer renders `ActivityPalette` internally — it receives activities, slots, and selectedGroupId as props instead.
5. Existing Manual Build DnD still works (drag from palette onto EmptyDropCell still places an activity).

## Files expected to change

- `src/screens/ScheduleScreen.jsx` — add sidebar column to layout, add collapse state (`sidebarCollapsed`), pass palette props down.
- `src/components/schedule/ManualBuildView.jsx` — remove internal `ActivityPalette` import and render; accept `activityPalette` element as prop or receive no palette at all (palette is now a sibling, not a child).
- `src/components/schedule/ActivityPalette.jsx` — add collapse toggle button to header. Count scoping: Group View and Day View → `selectedGroup`; Activity View → camp-wide sum over all groups.

## Design spec reference

Designer spec Section 1 (Layout), Section 1.1–1.5.

## Test seam

- Unit: `ActivityPalette` renders with `activities=[]` without crashing (defensive empty state per Design spec Section 8.1).
- Integration: sidebar visible in dev mode (`npm run dev`) when at least one group/day/block/activity exists.

## Notes

- The `DndContext` that wraps `ManualBuildView` currently lives inside that component. In this ticket, keep it there — the palette in Group/Day/Activity views is non-draggable (static display only). DnD context lift is deferred to T2.
- Session-only collapse state (no `localStorage`). Always expanded on mount.
- Count scoping for non-Manual views: show selected-group counts for Group and Day views; show camp-wide total (sum across all groups) for Activity view.
