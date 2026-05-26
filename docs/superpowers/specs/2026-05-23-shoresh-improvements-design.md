# Shoresh Improvements Design
**Date:** 2026-05-23

## Priority Order
1. Invite-link model (ID storage)
2. Seeded PRNG (tie-breaking)
3. Error handling
4. Style consolidation + ScheduleScreen split
5. Drag-and-drop prototype

## Section 1: Entry Flow
Replace CampIdGate with landing screen. Camp name is the primary access path.

## Section 2: Seeded PRNG
DJB2 hash + mulberry32 PRNG. Same inputs → same schedule every time.

## Section 3: Error Handling
Each screen gets an `error` state. If `loadAll()` throws, render error banner.
All modals get `saveError` state; show inline on Supabase failure; modal stays open.

## Section 4: Style Consolidation
Create `src/styles/shared.js` exporting `S` object. Extract schedule components to `src/components/schedule/`.

## Section 5: Drag-and-Drop
`@dnd-kit/core` — swap slots in Group view. PointerSensor with `distance: 8`.
