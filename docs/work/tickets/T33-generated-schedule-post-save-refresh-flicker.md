---
title: T33-generated-schedule-post-save-refresh-flicker
document_type: ticket
status: open
created: 2026-08-03
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: resolved and verified in the real app
---

# T33 — Generated Schedule flickers/refreshes after a drop or Save

**Risk:** Low — cosmetic, but on the most repeated actions in the schedule builder.
**Found:** 2026-08-03, product owner testing the generated-schedule blank-cell fix in real Electron.
**Status:** REPORTED by observation (product owner: *"the refresh is offputting but save that for later"*). Not yet root-caused.

---

## The defect

On the **Generated Schedule**, completing a drag-and-drop placement or an EditModal **Save**
produces a visible full-grid refresh/flash rather than an in-place update of the single edited
cell. The write itself is correct — the cell ends up with the right activity — but the whole grid
appears to reload, which reads as jarring during bulk editing.

## Likely cause (to verify, not assumed)

The `op-applied` push event triggers a full `loadAll()` re-fetch and re-render of the grid
(`src/screens/ScheduleScreen.jsx`, the `onOpApplied` handler around `:113-117`, same reload path
implicated in **T10**). Suspect the whole schedule state is being replaced on every single-cell
write instead of patching the affected slot, so React remounts the grid subtree.

Worth checking whether the recent multi-week Slice-1 week-scoped route state
(`src/screens/schedule/useRouteState.js`, `WeekSwitcher.jsx`) widened what gets recomputed on
reload.

## Why it matters

Building a week is dozens of placements in a row. A full-grid flash after each one is low-grade
friction that erodes trust in the tool, exactly when staff are working fast under time pressure.
Sibling of T10 (day/group selection snapping back on reload).

## Observable completion evidence

1. In Generated Schedule, drag an activity onto a cell: only that cell updates; no full-grid flash;
   scroll position and selected group/day are preserved.
2. Same for an EditModal Save.
3. Stats (Placed / Unfillable / Still needed) still update correctly after the placement.
4. Manual route behaves identically (no regression).

## Files expected to change

- `src/screens/ScheduleScreen.jsx` — the `onOpApplied` / `loadAll` reload path.
- Possibly the route/slot state modules under `src/screens/schedule/`.
