---
title: T37-generated-schedule-post-save-refresh-flicker
document_type: ticket
status: closed
created: 2026-08-03
closed: 2026-08-06
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: resolved and verified in the real app
---

# T37 — Generated Schedule flickers/refreshes after a drop or Save

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

---

## Closure note (2026-08-06)

Closed as **already resolved** — no new code was required. Investigation on a clean branch off
`646d951` confirmed the fix had already landed in commit `9f4b178`
(*"fix(schedule): skip loadAll for local ops + fix is_locked projection gap"*, 2026-08-03), which is
an ancestor of current `main`. The root cause was as suspected: the `onOpApplied` listener called
`reload()` unconditionally on every applied op — including the device's own writes — replacing all
of `useRouteState`'s by-route atoms and remounting the grid subtree. `9f4b178` added a
`localDeviceIdRef` (populated via `localClient.getDeviceId()`) and an early
`if (op?.device_id === localDeviceIdRef.current) return` guard in the listener
(`src/screens/ScheduleScreen.jsx:317-323`), so self-originated ops no longer trigger a reload while
peer writes still do. Correctness after a local write is carried by the optimistic `setSlots` patch
plus inline `recalcStats`/`recalcFindings` that every mutation in
`src/screens/schedule/useSlotMutations.js` already performs, which is why stats stay accurate
without a re-fetch. Regression coverage exists at
`src/screens/ScheduleScreen.test.jsx` under `describe('T37: onOpApplied skips loadAll for
local-device ops')`, asserting both the self-op-skips-reload and peer-op-still-reloads cases.
**Caveat on evidence:** this closure rests on code inspection and unit tests; the observable
completion evidence above (no visible flash, scroll position preserved) was *not* re-confirmed by
hand in the real Electron app. If the product owner still sees a flash during bulk editing, reopen
— the remaining suspect would be the render path, not the reload path.
