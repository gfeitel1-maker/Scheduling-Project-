---
title: T50-schedule-canvas-handoff
document_type: handoff
status: active
created: 2026-08-06
task: docs/work/tickets/T50-schedule-canvas-rebuild.md
archive_when: T50 and its child tickets T53–T60 are all closed
worktree: ../shoresh-canvas  (branch: work/t50-schedule-canvas)
---

# Schedule Canvas Rebuild — Exploration Handoff

This worktree is for the design conversation and exploration phase of T50. **No code ships from
here until a specification is approved.** The goal of this phase is to answer five questions and
produce a spec — not to implement anything.

---

## What this worktree is for

- Brainstorm and explore canvas directions
- Read real camp schedules and the current grid code to understand what is and isn't working
- Produce a specification (in `docs/work/specs/`) that the product owner approves before any
  implementation begins
- Possibly prototype interactive mockups to aid the conversation

This worktree is isolated from `main`. Any exploration commits here stay here until a direction is
approved and implementation is broken into its own ticket(s).

---

## The five questions the design conversation must answer

These were recorded in T50. Answer them before writing a spec:

1. **What does a director do in the first 30 seconds of opening the schedule?** What should they
   see? What does "not done" look like vs "done"?

2. **What manipulation model fits a director's mental model?** Today it is drag-and-drop only.
   Options: click-to-cycle through activities, type an activity name, fill-a-pattern, multi-select
   then assign — or something else. What maps to how a camp director thinks about the week?

3. **What does "done for the week" look like visually?** What signals completion vs
   attention-needed? How does the grid surface "this group is under-scheduled" without the director
   having to open the findings rail?

4. **Is there a view that doesn't exist yet that would be more useful than improving the current
   one?** For example: a group-week view that shows one group's whole week at a tile level rather
   than a grid cell level, or a day-timeline view that is denser and more time-aware.

5. **What is the performance ceiling?** The current grid renders every slot in the week at once.
   A camp with 12 groups, 5 days, 8 blocks is 480 cells. Does that stay acceptable, or does
   virtualization become necessary if the canvas gets richer?

---

## What exists today — the starting point

### Current grid shape

`src/screens/ScheduleScreen.jsx` — 950+ lines, the orchestrator. Most domain logic is now in
hooks (useWeeks, useSlotMutations, useGeneration, useSnapshots, useRouteState, useScheduleData),
so ScheduleScreen itself is mostly composition and event wiring.

`src/components/schedule/` — presentational layer:
- `SlotCell.jsx` — one cell; handles UNFILLABLE / OVERLAP flags, selection highlight, drop target
- `GroupRow.jsx` / `DayColumn.jsx` — layout rows and columns
- `FindingsRail.jsx` — right-side panel; UNDERSERVED / DISTRIBUTION findings
- `WeekSwitcher.jsx` — week tab strip + "+ New Week"
- `WeekContextBar.jsx` — breadcrumb / route indicator above the grid

`src/screens/schedule/gridGeometry.js` — pure, tested; handles multi-block span cells, tail cells,
overlay stamps. This file is correct and should be treated as a stable seam.

`src/engine/buildSchedule.js` — pure engine; no React, no IPC. The engine itself is not in scope
for this redesign unless the new canvas needs new flag vocabulary (in which case that is a separate
engine ticket).

### DnD

`@dnd-kit/core` with `distance: 8` activation constraint. `makeDragHandlers` (in
`src/screens/schedule/dragHandlers.js`) is the unified handler for both group and day views.
Cross-day swaps are allowed (product decision 2026-08-05). Slot-swap is supported.

### Two routes, two candidate schedules

**Manual** and **Generated** are separate `schedule_templates` rows, distinguished by `kind`.
Neither is canonical. Nothing may designate one as the active schedule. Route state is keyed per
route in `useRouteState`. This constraint is constitutional — any canvas redesign must preserve it.

### Flag vocabulary

| Flag | Route | Persistence |
|---|---|---|
| `UNFILLABLE` | Generated only | Persisted in `flags` column |
| `UNDERSERVED` | Both | Never persisted — computed after generation |
| `DISTRIBUTION` | Both | Never persisted — computed after generation |
| `OVERLAP` | Manual only | Never persisted — derived at render time |

A new canvas direction must handle all four or explicitly argue for changing one.

### Known friction points (from T50 ticket)

- Nothing communicates utilisation at a glance without opening the findings rail
- Drag-and-drop is the only manipulation model
- Grid is fixed-geometry — no zoom, no collapsed quiet periods
- Flags compete for space rather than guiding action
- Switching views loses selection context

---

## Constraints that are not negotiable

1. **Two routes, neither canonical.** The canvas shows one route at a time; switching is navigation,
   never destructive, never confirmed.
2. **Export route choice is not remembered.** The director chooses which route to export at export
   time, every time.
3. **All inline styles.** No CSS files, no CSS modules. Shared constants in `src/styles/shared.js`.
4. **DnD must coexist with click handlers.** The `distance: 8` activation constraint is there
   because click handlers exist on cells. Any new manipulation model must preserve this coexistence.
5. **The engine is pure and unchanged.** Canvas changes must not require engine changes unless
   explicitly scoped as a separate ticket.

---

## Where to start

1. Read `src/screens/ScheduleScreen.jsx` end-to-end to understand the current state composition.
2. Read `src/components/schedule/SlotCell.jsx` to understand what one cell knows and renders.
3. Look at the real camp schedule samples in `.ingest-incoming/` (never committed) to see what
   directors are used to working from.
4. Run `npm run electron:dev` from the main worktree (not this one) to see the current canvas in
   action before exploring alternatives.
5. Then brainstorm — three distinct directions minimum before converging.

---

## What comes out of this phase

A specification document at `docs/work/specs/schedule-canvas-redesign.md` covering:
- The approved direction (with rationale for why it beats the alternatives)
- A wireframe or prototype demonstrating the key interactions
- An explicit answer to each of the five questions above
- A list of implementation tickets broken out from the spec, each scoped to a coherent chunk

The spec must be approved by the product owner before any implementation begins.
