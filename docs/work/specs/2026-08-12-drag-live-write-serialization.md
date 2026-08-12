---
title: "Recency-gated live writes close the same-cell drag write race"
document_type: spec
status: proposed
created: 2026-08-12
task_class: concurrency
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-08-12-drag-fsm-gesture-correlation.md]
related_tickets: []
archive_when: the ledger lands, all eight tests in the ADR's test seam plan pass, and a Red Hat pass on the new cellGestureRef machinery is complete
---

# Recency-gated live writes close the same-cell drag write race

## Summary

`docs/adr/2026-08-12-drag-fsm-gesture-correlation.md` fixed two adjacent bugs
in the schedule grid's drag machinery: stale FSM commit-result events landing
on the wrong gesture, and `replaceSlot`'s undo snapshot reading a stale
`slots` closure. That ADR explicitly named a third, deeper problem as
out-of-scope and unresolved: **the live writes themselves have no recency
gate.** Two fast same-cell drags can each independently write to
`template_slots` and then call `setSlots`; whichever IPC call resolves last
wins the screen's final state — even when that is the *earlier* gesture. The
director's most recent edit can silently revert with no error, no flag, and
no `COMMIT_FAILURE` (the FSM fix does not touch this path at all).

This spec is the fix: a per-cell gesture-recency ledger (`docs/adr/2026-08-12-drag-live-write-serialization.md`)
inside `useSlotMutations.js` that makes `replaceSlot`, `expandSlot`, and
`splitSlot` recognize when their in-flight write has been superseded by a
newer gesture touching the same cell, and skip applying/undo-recording a
result that's no longer current.

## Goal

A director who drags two different activities onto the same cell in quick
succession — or races a same-cell expand/split against another gesture —
always ends up with the cell showing what they *most recently* dropped, and
the undo stack has exactly one entry per action the director actually
experienced, never a phantom entry for a write that got silently overwritten.

## Non-goals

- **No change to `placeActivityManual`.** It only ever writes an empty cell
  (occupied-cell drops route through `replaceSlot` instead — see
  `dragHandlers.js` lines 55-65), so the specific "two writes race to decide
  a cell's final value" scenario cannot occur on its own writes today. See
  the ADR's "Non-goals" for the full reasoning.
- **No change to `dismissFlag`, `lockActivity`, `releaseCell`, `addOverlay`,
  `removeOverlay`, `updateOverlayRange`, or `createActivityFromCell`'s own
  activity-creation write.** None are reachable from a same-cell drag race.
- **No change to the op-log write shape, `client_write_id` generation, or
  the `window.shoresh.write` IPC surface.** This is a renderer-side
  gesture-recency fix, not a sync-protocol change.
- **No change to seeded engine determinism (`buildSchedule.js`).** Untouched,
  out of this data path.
- **No change to two-routes (Manual/Generated) semantics, `UNFILLABLE`/
  `OVERLAP` flag computation, or which route is canonical.**
- **No change to `scheduleGrid.css` or any new ephemeral visual cell state.**
  A dropped stale write is invisible by design — the cell already shows the
  surviving gesture's result, nothing new needs to be painted.
- **No new agent role, review phase, or process step.** This is a Maker task
  behind the existing Governor quality loop; the ADR's Red Hat follow-up
  requirement is a gate on this ticket's own review loop, not a new
  standing process.

## Success predicate

Done when **all** of the following hold:

1. **Facet 1 (write ordering) fixed and proven.** The exact repro — two
   `replaceSlot` calls on the same target cell with different `gestureId`s,
   where the earlier gesture's write resolves *after* the later gesture's —
   ends with `slots` reflecting the later gesture's placement. Proven by a
   focused `useSlotMutations.test.js` test with manually-controlled promise
   resolution order (no `setTimeout`/timing-dependent flakiness).
2. **Facet 1's happy path is unchanged.** The same two-call scenario resolved
   in gesture order produces identical final state to current (pre-fix)
   behavior — the fix must be invisible when nothing actually raced.
3. **Facet 2 (`expandSlot`/`splitSlot` stale undo snapshot) fixed and
   proven**, using the same claim/check/apply mechanism as facet 1, with a
   focused test per handler mirroring the existing `replaceSlot` regression
   test's structure from the gesture-correlation ADR.
4. **Facet 3 (undo dedup) fixed and proven.** In the facet-1 repro, `pushUndo`
   is called exactly once (for the surviving gesture), not twice.
5. **No regression in the existing `useSlotMutations.test.js` /
   `useUndoRedo.test.js` / `dragFSM.test.js` / `useDragFSM` suites.**
6. **The new `cellGestureRef` ledger and its claim/check/apply logic get an
   independent Red Hat pass** before this ticket is considered closed —
   findings are triaged through the normal loop (fix all, no silent
   deferral of anything HIGH or MEDIUM without an explicit, recorded
   decision).
7. **No change detected to:** the shape of writes sent to `repo`/
   `window.shoresh.write`, `client_write_id` generation, the `operations`
   table, `buildSchedule.js`'s output for a fixed seed/input, or
   `scheduleGrid.css`. (Verified by: `git diff` scoped to those
   files/paths is empty at the end of implementation.)

## Approach

See `docs/adr/2026-08-12-drag-live-write-serialization.md` for the full
design, candidates considered, and rationale. Summary for implementers:

- Add `cellGestureRef` (`useRef(new Map())`) to `useSlotMutations.js`, keyed
  by `` `${groupId}|${dayId}|${blockId}` ``.
- `replaceSlot`, `expandSlot`, `splitSlot` each gain an optional `gestureId`
  parameter. Before issuing writes, each **claims** every cell it touches
  (`cellGestureRef.current.set(cellKey, gestureId)`). After writes resolve,
  each cell is applied to `setSlots` **only if** the ledger still shows this
  call's `gestureId` as the claimant for that cell; otherwise that cell's
  update is dropped.
- If a call's writes are fully superseded (no cell it touched still matches
  its claim), it must **not** call `pushUndo` — the surviving gesture's own
  call already owns that cell's undo entry.
- Undo/redo closures re-claim their cell(s) for their own entry's
  `gestureId` immediately before writing, using the identical claim/check
  logic, so a stale undo can never silently overwrite a newer gesture's
  result.
- `gestureId === undefined` (any non-drag caller) always claims and always
  wins its own check — today, per `grep`, the only caller of `replaceSlot`/
  `expandSlot` is `dragHandlers.js`'s `commit()`, and `splitSlot` is called
  from a click handler in `ScheduleScreen.jsx`; confirm this caller map is
  still accurate at implementation time.
- Thread `gestureId` from `dragFSM.js`'s `commit` effect (already carries it,
  per the gesture-correlation ADR) through `useDragFSM.js`'s `perform()` →
  `dragHandlers.js`'s `commit(active, hit, gestureId)` → the three mutation
  calls.

## Test plan

The ADR's "Test seam plan" section (8 tests) is the authoritative list —
do not re-derive it here, implement against it directly. In brief: tests 1-2
prove facet 1 (repro + happy-path non-regression), tests 3-4 prove facet 2
(`expandSlot`/`splitSlot`), test 5 proves facet 3 (undo dedup), tests 6-8
cover undo/redo re-check, the `gestureId === undefined` design rule, and a
cross-handler (source-vs-target) race at the per-cell ledger granularity.

All tests run at the existing `useSlotMutations.test.js` hook-test boundary
— mocked `repo`, hand-controlled promise resolution, no Electron, no real
SQLite, no `setTimeout`.

## Risks considered

- **Ledger never cleared across a route switch.** `useSlotMutations` is
  scoped per `ScheduleScreen` instance; confirm during implementation
  whether a route switch remounts it (if so, no action needed — a fresh
  `useRef` clears the ledger for free) or reuses the instance (if so, add
  `cellGestureRef.current.clear()` to the screen's existing transient-reset
  block, matching how `useUndoRedo`'s stacks are already reset on route
  switch).
- **Memory growth of `cellGestureRef`.** Unbounded by cell count in theory,
  but bounded in practice by the grid's fixed group×day×block dimensions —
  no different in scale from `slots` itself, which the screen already holds
  in full. No eviction needed.
- **New concurrency primitive risk.** This is exactly the class of change
  the prior ADR's HIGH finding came out of — a Red Hat pass on the new
  machinery specifically is a hard requirement of this spec's success
  predicate (item 6), not optional follow-up.
