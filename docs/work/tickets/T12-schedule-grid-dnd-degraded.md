---
title: T12-schedule-grid-dnd-degraded
document_type: ticket
status: open
created: 2026-07-28
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: []
archive_when: reproduction confirmed fixed under electron:dev and a regression test exists
---

# T12 — Drag-and-drop on the schedule grid is degraded across all views

**Risk:** HIGH for usability — dragging is the primary way a director builds a schedule.
**Found:** 2026-07-28, hand-check of the running app by the product owner.
**Status:** REPORTED — not yet reproduced or diagnosed.

---

## The report

> the screens are ok but not working fully well on the dnd for the schedule grid
> across any view, otherwise is fine

Everything else in the app was reported fine. The problem is specific to dragging on
the schedule grid, and present in **every** view (group, day, manual) rather than one.

## What is not yet known

This ticket is deliberately thin. It records a real observation and **no diagnosis**.
Before any code changes, establish:

1. **Which build was running.** The `shoresh-ui` worktree had `electron:dev` running its
   own branch (`ui/state-primitives`) at the time. That branch modifies `SlotCell.jsx`,
   `ScheduleScreen.jsx`, and `normalizeSlots.js` — all on the DnD path. The report may be
   about that branch rather than `main`. This must be settled first; the two have different
   suspects.
2. **What "not fully well" means concretely.** Drag does not start? Starts but no drop
   target highlights? Drops on the wrong cell? Drops and reverts? Works but feels wrong?
   Each points somewhere different.
3. **Which drag.** Palette → grid, or cell → cell (swap)? Both are separate code paths.

## Suspects, unranked and unverified

- `distance: 8` PointerSensor activation constraint — exists so drag coexists with click
  handlers. If click handling changed, the threshold may now fight it.
- `ui/state-primitives`'s `SlotCell.jsx` rewrite (+157) — drop targets and their visual
  affordances live here.
- `normalizeSlots.js` changes on the same branch — if slot identity or keys shifted, drop
  resolution would mis-target.
- T10's selection change (`main`) — kept the day/group selection stable across reloads.
  It is on the post-drop path, so it must be ruled out, though it only alters which day is
  *displayed*, not how a drop resolves.

## Completion evidence

1. A written reproduction: view, drag type, expected, actual.
2. Root cause identified, and stated as a cause rather than a guess.
3. Fix verified under `npm run electron:dev` — not the browser dev mock, per
   `TESTING_STANDARD.md` §2, since drop resolution ends in an op-log write.
4. A regression test at whatever seam the bug turns out to live in. The branch now brings
   component-test infrastructure (`ScheduleScreen.test.jsx`), so a rendered-interaction
   test is possible for the first time.

## Note

Do not begin by changing DnD code. The last four defects on this project (T6-T11) were each
diagnosed by reading the actual data or running the real app, and in three cases the
plausible first guess was wrong.
