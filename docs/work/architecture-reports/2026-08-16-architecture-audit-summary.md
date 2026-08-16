---
title: Architecture audit 2026-08-16
document_type: architecture-report
authority: descriptive
status: active
date: 2026-08-16
---

Fresh candidates ranked by leverage, plus reconciliation of the 2026-08-03 audit. Full analysis in `2026-08-16-architecture-audit.html`.

## Reconciliation of the prior audit (C1–C5)

All five prior candidates are **DONE** — the intervening ScheduleScreen decoupling program landed them almost verbatim.

- **C1 · DONE** — `loadAll` extracted into `src/screens/schedule/useScheduleData.js` (293 lines, own test); consumed at `ScheduleScreen.jsx:99–103`.
- **C2 · DONE** — both DnD contexts now build from one `makeDragHandlers` factory (`ScheduleScreen.jsx:586–588`; logic in `dragHandlers.js`).
- **C3 · DONE** — `is_locked` present in the activities projection allowlist at `electron/ops/projections.js:130`; stale Supabase comment removed.
- **C4 · DONE** — `listByScope` primitive now backs the reads; `scheduleRepository.reloadSlots`/`reloadOverlays` (lines 108, 112) and `loadWeekExclusions` (125–126) no longer `list().filter()` in the renderer.
- **C5 · DONE** — `setRouteData(r, payload)` with required-key enforcement at `useRouteState.js:98–117`; driven once per route at `ScheduleScreen.jsx:353–362`.

No candidate is STALE or STILL-LIVE; nothing carries forward. Prior low-severity C6 (raw-SQL pre-insert in `duplicateWeek.js`) now carries the requested invariant-deviation safety comment.

## Fresh candidates

- **F1 (high) · Extract the optimistic-write + undo/redo envelope in `useSlotMutations.js`** — the queue-participation invariant (every write, incl. undo/redo, goes through `claimAndRun` with a fresh claim and no-ops when dropped) is hand-repeated across `replaceSlot`/`placeActivityManual`/`expandSlot`/`splitSlot`; a `runMutation({keys, apply, invert})` helper names it once. Locality failure that already bit (queue v2 missed `placeActivityManual`).
- **F2 (medium-high) · Lift the duplicated eligibility predicate to one shared pure rule** — the tier/group-id eligibility check lives in both `ScheduleScreen.jsx:220–231` and `useSlotMutations.js:414–417`, and a comment falsely claims it was already unified; the two drive the typeahead and the UNFILLABLE flag respectively and must never diverge.
- **F3 (medium) · Extract findings-rail derivation out of `ScheduleScreen`** — ~110 lines of pure route-aware transformation (`findingsRows`, `highlightMap`, off-view counts) at `ScheduleScreen.jsx:448–559` is a pure function trapped in the 1,281-line component; move to a `deriveFindingsRows(...)` module beside `gridGeometry.js`.
- **F4 (scoping note) · Re-audit the grown sync layer as its own pass** — `syncClient.js` (1,435 lines) and `syncServer.js` (1,139 lines) were only partially read in 2026-08-03 and have grown large; a dedicated deep-read pass paired with Security is warranted. No depth claim made this pass.
