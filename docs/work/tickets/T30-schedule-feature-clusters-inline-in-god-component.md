---
title: T30-schedule-feature-clusters-inline-in-god-component
document_type: ticket
status: completed
created: 2026-08-01
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_tickets: [docs/work/tickets/T28-schedule-screen-has-no-persistence-seam.md]
related_runs: [docs/work/runs/2026-08-01-t30-schedule-feature-hooks-run.md]
resolved_by: [src/screens/schedule/useGeneration.js]
archive_when: resolved
---

# T30 — Self-contained feature clusters are melted into the god component

**Risk:** Medium (touches the most state), behaviour-preserving. **Depends on:** T28 (hooks call the
repository, not `localClient`). Step 3 of
[the decoupling program](../specs/2026-08-01-schedule-screen-decoupling-design.md). This is the step
that most reduces the file's size.

## What is wrong

Several independent features are implemented inline in `ScheduleScreen.jsx`, contributing most of its
46 `useState` calls and ~50 handlers:

- **Undo/redo** — `undoStack`/`redoStack`, `pushUndo`/`handleUndo`/`handleRedo`.
- **Clipboard + selection** — `selectedSlotKeys`/`clipboardItems`/`pasteMode`/`pasteModeIndex`/
  `pasteError`, the Ctrl+C/Ctrl+A/Escape keyboard effect, `handleCellSelect`/`handlePasteClick`.
- **Snapshots / versions** — `saveSnapshot`/`deleteSnapshot`/`restoreSnapshot`/`renameSnapshot`
  (over the T28 repository).
- **Generation** — `generate`/`regenFromScratch`/`placeAnchors` (over the repository + pure engine).
- **Overlay fill / stamp** — `fillState`/`stampMode`, `startFill`/`handleFillEnter`/
  `handleStampClick`.

## Why it matters

Each cluster is a natural deep module with a small interface but is currently inseparable from the
component, so none can be tested or reasoned about in isolation, and each new feature adds more
state to the same 2,277-line function.

## Scope

**In:** extract each cluster into a hook (`useUndoRedo`, `useClipboardSelection`, `useSnapshots`,
`useGeneration`, `useOverlayFillStamp`), one commit each where practical; the hooks own their state
and handlers and expose a small interface to the screen. Persistence goes through the T28 repository;
scheduling goes through the pure engine — hooks orchestrate, they do not re-implement either.

**Out:** persistence internals (T28), grid geometry (T29), route-state (T31); the engine; visual
changes. Route-scoped state still lives in the screen until T31; hooks must not assume otherwise.

**Boundaries:** behaviour-preserving; the route-reset semantics on route switch (currently the
inline transient reset) must be preserved exactly; no IPC/entity/engine change.

## Completion evidence

1. Each extracted hook has unit tests exercised without mounting the full screen where feasible.
2. `ScheduleScreen.jsx`'s `useState` count and handler count are materially reduced.
3. Undo/redo, copy/paste, snapshot CRUD/restore, generate/regenerate, and fill/stamp all behave
   exactly as before, including the route-switch reset of transient state.
4. Every existing `ScheduleScreen.test.jsx` case passes unchanged; full `npm run test` green.
5. `npm run check:governance`, `npm run lint`, `npm run build` pass. No engine/IPC/entity change.
