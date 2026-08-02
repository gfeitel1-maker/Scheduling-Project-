---
title: T32-schedule-slot-mutations-inline-in-orchestrator
document_type: ticket
status: completed
created: 2026-08-01
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_tickets: [docs/work/tickets/T30-schedule-feature-clusters-inline-in-god-component.md, docs/work/tickets/T31-schedule-route-state-doubling-unencapsulated.md]
related_runs: [docs/work/runs/2026-08-01-t32-schedule-slot-mutations-run.md]
resolved_by: [src/screens/schedule/useSlotMutations.js]
archive_when: resolved
---

# T32 — The per-cell slot-mutation handlers are still inline in the orchestrator

**Risk:** Higher than T28–T31 — these are the most behaviour-critical handlers (undo/redo
closures, drag-drop, merge/split, manual placement). Behaviour-preserving, gated on the full suite
staying green. **Follow-on to the completed four-step decoupling** (flagged by the T31 Code
Reviewer as the natural step 5).

## What is wrong

After T28–T31, `ScheduleScreen.jsx` (1648 lines) still holds ~11 per-cell slot/overlay mutation
handlers, ~450 lines, all following the identical pattern: read the target from `slots` →
`repo.writeSlotFields`/`repo.writeOverlayFields` → `setActionError` on failure → optimistic
`setSlots`/`setOverlays` → `pushUndo({undo, redo})`. They are: `editSlotSave` (:368), `swapSlots`
(:416), `dismissFlag` (:473), `lockActivity` (:511), `releaseCell` (:522), `addOverlay` (:533),
`removeOverlay` (:551), `updateOverlayRange` (:565), `placeActivityManual` (:576), `expandSlot`
(:759), `splitSlot` (:846).

They are a cohesive cluster ("mutate a slot/overlay and record the undo entry") but can only be
tested today by mounting the whole screen.

## Why it matters

This is the single biggest remaining extractable concern. Pulling it into a `useSlotMutations` hook
makes the delicate undo/redo mutation logic unit-testable in isolation and leaves `ScheduleScreen`
as a genuinely thin orchestrator.

## Scope

**In:** extract the ~11 mutation handlers into `src/screens/schedule/useSlotMutations.js`, taking
its collaborators injected (`repo`, the `useRouteState` object, `pushUndo`, `setActionError`,
`setEditSlot`, `editSlot`, `setDisplacedItems`, `ensureTemplateRow`, `recalcStats`, the geometry
`getSlot`, and the data lists `groups/activities/days/timeBlocks/anchors`). The hook returns the
mutation functions; the screen and the DnD event handlers call them.

**Out:** the DnD drag-start/end *event* handlers (`handleGroupDragEnd` etc.) stay in the screen as
@dnd-kit event glue (they may call the hook's mutations); findings UI (`dismissFinding`,
`dismissFindingsRow`, `locateFindingsRow`); everything already extracted in T28–T31; the pure
engine; styling.

**Boundaries:** behaviour-preserving. The undo/redo closures must capture the SAME route-pinned
setters/repo/ids so an undo after a route switch cannot write the wrong candidate (this is the
delicate part — preserve it exactly). No IPC/entity/engine/style change.

## Completion evidence

1. `useSlotMutations.js` exists with unit tests exercising the mutation + undo/redo paths with a
   fake repo (no full-screen mount), incl. a test that an undo replays the correct route-pinned write.
2. The ~11 handlers are gone from `ScheduleScreen.jsx` (grep clean); the screen calls the hook.
3. Every existing `ScheduleScreen.test.jsx` case passes unchanged; full `npm run test` green.
4. `npm run lint` 0 errors, `npm run build` clean, `npm run check:governance` clean.
5. Diff confirms no engine/IPC/entity/style change.
