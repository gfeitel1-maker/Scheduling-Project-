---
title: "Per-cell write serialization closes the same-cell drag write race"
document_type: spec
status: implemented
created: 2026-08-12
task_class: concurrency
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-08-12-drag-fsm-gesture-correlation.md]
related_tickets: []
archive_when: the write-serialization queue lands, all eight tests in the ADR's test seam plan pass, and a Red Hat pass on the new cellQueueRef machinery is complete
---

# Per-cell write serialization closes the same-cell drag write race

## Summary

This spec previously described a client-side recency-token design (see
`docs/adr/2026-08-12-drag-live-write-serialization.md`, "Status: Revised" for
the full history). That design was implemented, then **reversed by a Red Hat
pass** that verified against `electron/ops/projections.js` that it gated only
the in-memory `setSlots` call, not the `repo.writeSlotFields` IPC write —
which fired unconditionally and landed in the database in **seq (arrival)
order**, not gesture-recency order. A stale gesture's write could therefore
still win at the database (and propagate to every synced device) even after
the screen had already corrected itself. The token implementation is
discarded; this spec describes its replacement.

The replacement design (full detail in the ADR) is **per-cell write
serialization at the point of issuance**: a queue, keyed by
`(route, templateId, groupId, dayId, blockId)`, that chains same-cell writes
so they can never be simultaneously in flight to the database, and drops a
write entirely — never dispatching it — once a newer claim has superseded it.
Multi-cell operations (`replaceSlot`'s source+target, `expandSlot`/
`splitSlot`'s head+tail) claim all their cells atomically: either the whole
operation's writes go out, or none do. Undo/redo and non-drag (click-driven)
callers go through the identical path — there is no `gestureId === undefined`
bypass.

## Goal

A director who drags two different activities onto the same cell in quick
succession — or races a same-cell expand/split, undo, or click-driven edit
against another gesture — always ends up with the cell showing what they
*most recently* placed, **and the database (and every device this camp syncs
to) agrees with the screen** — not just the local screen alone. The undo
stack has exactly one entry per action the director actually experienced.

## Non-goals

- **No change to `placeActivityManual`.** It only ever writes an empty cell
  (occupied-cell drops route through `replaceSlot` instead — see
  `dragHandlers.js` lines 55-65), so the specific "two writes race to decide
  a cell's final value" scenario cannot occur on its own writes today. See
  the ADR's "Non-goals" for the full reasoning.
- **No change to `dismissFlag`, `lockActivity`, `releaseCell`, `addOverlay`,
  `removeOverlay`, `updateOverlayRange`, or `createActivityFromCell`'s own
  activity-creation write.** None are reachable from a same-cell drag/click
  race on `template_slots`.
- **No change to the op-log write shape, `client_write_id` generation, or
  the `window.shoresh.write` IPC surface.** This reorders *when this tab
  issues* writes; it does not change what a write looks like once issued, or
  how sync/replay/conflict resolution works across devices.
- **No change to seeded engine determinism (`buildSchedule.js`).** Untouched,
  out of this data path.
- **No change to which route is canonical, or to `UNFILLABLE`/`OVERLAP` flag
  computation.** Adding route/templateId to the cell-identity key used for
  local write ordering is what *guarantees* the existing two-routes
  independence at this layer — it does not change the two-routes model
  itself.
- **No change to `scheduleGrid.css` or any new ephemeral visual cell state.**
  A dropped stale write is invisible by design.
- **No new agent role, review phase, or process step.** This is a Maker task
  behind the existing Governor quality loop; the ADR's Red Hat follow-up
  requirement is a gate on this ticket's own review loop, not a new
  standing process.
- **Not addressed here: cross-device conflicts.** Genuine conflicting writes
  from two different devices remain the `conflicts` table's/
  `resolveConflict`'s job, unchanged. This spec is scoped to same-tab,
  same-session gesture-vs-gesture ordering only.

## Success predicate

Done when **all** of the following hold:

1. **Finding 1 (write ordering at the persistence layer) fixed and proven at
   the write call, not just the read.** The repro — two `replaceSlot` calls
   targeting the same cell, an earlier claim (`g1`) and a later one (`g2`) —
   results in `repo.writeSlotFields` being called **exactly once** for that
   cell, with `g2`'s payload. `g1`'s write must never be dispatched once
   superseded. Proven by a focused `useSlotMutations.test.js` test asserting
   the mock's call count and arguments (not merely the resulting `slots`
   state — that assertion alone is what the reversed design's tests missed).
2. **The non-colliding case is a no-op change vs. current behavior.** A
   single `replaceSlot` call with no contention dispatches immediately
   (chain resolves same-tick); timing and outcome match pre-fix behavior.
3. **Finding 2 (route/templateId not part of cell identity) fixed and
   proven.** Two same-`(groupId, dayId, blockId)` calls on different
   `(route, templateId)` pairs both dispatch independently — neither claim-
   drops the other.
4. **Multi-cell atomicity (source+target for `replaceSlot`; head+tail for
   `expandSlot`/`splitSlot`) fixed and proven.** A superseded multi-cell
   operation dispatches **no** write for **any** of its cells — never a
   partial apply — and does not call `pushUndo`.
5. **Finding 3 (undo/redo write ordering) fixed and proven.** An undo/redo
   write goes through the same per-cell chain as forward writes; it cannot
   land at the database out of order relative to a newer forward write to
   the same cell.
6. **Finding 4 (no bypass for a missing gesture id) fixed and proven.** A
   non-drag (click-driven) write with no `gestureId` participates in the
   same per-cell ordering as drag writes — it can be superseded, and can
   supersede, exactly like any other claim. There is no code path where
   `gestureId === undefined` skips the check.
7. **No regression in the existing `useSlotMutations.test.js` /
   `useUndoRedo.test.js` / `dragFSM.test.js` / `useDragFSM` suites.**
8. **The new `cellQueueRef` machinery and its claim/chain/dispatch logic get
   an independent Red Hat pass** before this ticket is considered closed —
   findings are triaged through the normal loop (fix all, no silent
   deferral of anything HIGH or MEDIUM without an explicit, recorded
   decision). Red Hat should specifically probe the three items called out
   in the ADR's test seam plan follow-up (synchronous claim/chain race-
   freedom, canonical sort order applied uniformly, unmount-mid-chain
   dangling claims).
9. **No change detected to:** the shape of writes sent to `repo`/
   `window.shoresh.write`, `client_write_id` generation, the `operations`
   table, `buildSchedule.js`'s output for a fixed seed/input, or
   `scheduleGrid.css`. (Verified by: `git diff` scoped to those
   files/paths is empty at the end of implementation.)

## Approach

See `docs/adr/2026-08-12-drag-live-write-serialization.md` for the full
design, candidates considered, and the decision-reversal rationale. Summary
for implementers:

- Replace the reversed design's `cellGestureRef` token `Map` with
  `cellQueueRef` (`useRef(new Map())`), keyed by
  `` `${route}|${templateId}|${groupId}|${dayId}|${blockId}` `` — route and
  templateId are new to the key; everything else was already in scope.
- `replaceSlot`, `expandSlot`, `splitSlot` each gain an optional
  `gestureId`/`claimId` parameter (drag callers pass `gestureId`; non-drag
  callers get one synthesized internally — never `undefined` reaching the
  claim logic). Before dispatching writes, each operation:
  1. Sorts all cells it touches into canonical (lexical) key order.
  2. Claims them all synchronously.
  3. Chains its dispatch behind each cell's prior in-flight write
     (`Promise.allSettled` of the previous tail per cell).
  4. Re-checks, after the chain settles, that its claim still holds on
     **every** cell it touched. If any cell's claim has moved on, the whole
     operation aborts — no write dispatched for any cell, no `setSlots`, no
     `pushUndo`.
  5. Otherwise dispatches all its writes (`Promise.all`, as today), then
     applies `setSlots` and `pushUndo` exactly once.
- Undo/redo closures synthesize their own claim id and go through the
  identical claim/chain/dispatch path before writing.
- `gestureId`/`claimId` is never allowed to be `undefined` at the claim
  step — non-drag call sites (`ScheduleScreen.jsx`'s click-driven
  `splitSlot`/`expandSlot`/`createActivityFromCell`) require no call-site
  change; `useSlotMutations.js` synthesizes a one-off id internally when
  none is passed.
- Thread `gestureId` from `dragFSM.js`'s `commit` effect (already carries it,
  per the gesture-correlation ADR) through `useDragFSM.js`'s `perform()` →
  `dragHandlers.js`'s `commit(active, hit, gestureId)` → the three mutation
  calls — unchanged plumbing from the reversed design.

## Test plan

The ADR's "Test seam plan" section (8 tests) is authoritative — implement
against it directly, do not re-derive it here. In brief: test 1 proves
finding 1 at the persistence layer (call-count/argument assertion on the
mocked `repo`, not a `slots`-state proxy); test 2 proves the non-colliding
case is unchanged; test 3 proves the route/templateId dimension (finding 2);
tests 4-5 prove multi-cell atomicity for `replaceSlot` and
`expandSlot`/`splitSlot`; test 6 proves undo/redo ordering (finding 3); test
7 proves no bypass for a missing gesture id (finding 4); test 8 is a
deadlock-avoidance regression for the canonical claim-ordering rule.

All tests run at the existing `useSlotMutations.test.js` hook-test boundary
— mocked `repo` with call-order/argument-recording spies, hand-controlled
promise resolution, no Electron, no real SQLite, no `setTimeout`.

## Risks considered

- **Ledger/queue never cleared across a route switch or unmount.**
  `useSlotMutations` is scoped per `ScheduleScreen` instance; confirm during
  implementation whether a route switch remounts it (fresh `useRef` clears
  the queue for free) or reuses the instance (add
  `cellQueueRef.current.clear()` to the screen's existing transient-reset
  block if so). Additionally — new risk versus the reversed design, because
  this mechanism holds live promise chains rather than a static value —
  confirm an unmount mid-chain cannot leave a future claim permanently
  blocked waiting on a chain that will never resolve. This is one of the
  three items the ADR calls out for the required Red Hat pass.
- **Memory growth of `cellQueueRef`.** Unbounded by cell count in theory,
  bounded in practice by the grid's fixed group×day×block×route dimensions —
  no different in scale from `slots` itself.
- **Control-flow rewrite risk.** Unlike the reversed design (an additive
  parameter plus a check), this restructures `replaceSlot`/`expandSlot`/
  `splitSlot` so writes dispatch from inside a chained callback rather than
  eagerly at the top of the function. Maker should treat this as a rewrite
  of the write-issuance path in these three handlers, not a patch, and the
  required Red Hat pass (success predicate item 8) is the explicit gate on
  that new concurrency primitive being correct — the same category of gap
  that caused this ADR's own reversal.
