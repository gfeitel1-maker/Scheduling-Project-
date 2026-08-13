---
title: "Gesture-correlated commit results in the drag FSM"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-12
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
---

# Gesture-correlated commit results in the drag FSM

## Status
Implemented. Parts 1, 2, 3, and 5 shipped as designed below. Part 4 (Issue 2)
was folded into this pass per Governor decision — see the note at the end of
that section for the mechanism actually built.

## Context

`src/screens/schedule/dragFSM.js` is a pure state machine (`transition(state, event)
-> { nextState, sideEffects }`) driving the schedule grid's drag-and-drop gesture:
`Idle -> Pointing -> Dragging -> Resolving -> Idle`. `RESOLVING` is "released over a
valid target, op-log write not yet committed" — it exists precisely because writes
can fail asynchronously.

`RESOLVING`'s table entries for `COMMIT_SUCCESS` and `COMMIT_FAILURE` act
unconditionally on whatever `COMMIT_SUCCESS`/`COMMIT_FAILURE` event arrives, with no
check that it belongs to the gesture currently in `RESOLVING`. `reArm` (triggered by
`POINTER_DOWN` in any non-`Idle` state, including `RESOLVING`) is deliberate
self-healing for a lost `pointerup` — a new gesture must always be able to start.
But it also means a second gesture can enter `RESOLVING` while the first gesture's
commit is still in flight. The first gesture's late `COMMIT_SUCCESS` then lands on
gesture 2, clearing the drop indicator early; if gesture 1's write actually fails
after that, its `COMMIT_FAILURE` arrives when the machine has already returned to
`Idle` (having processed gesture 2's own result, or something in between), where it
is ignored — the `announceCommitFailure` side effect is silently dropped.

There are two `useDragFSM` instances in the app (`groupDrag`, `dayDrag` — see
`ScheduleScreen.jsx`), each with its own `stateRef` created by its own `useRef` call
inside its own hook invocation. They share no ref, no module-level state, and no
event channel between them. **Cross-instance contamination is not possible**; this
ADR addresses only the intra-instance (same grid, two gestures in sequence) case.

A second, narrower report (Issue 2): `useSlotMutations.js`'s `replaceSlot` closes
over the render's `slots` array to compute `prevTargetActivityId`/`prevTargetFlags`
for its undo snapshot. Two fast same-cell drags could, in principle, let the second
`replaceSlot` call capture a stale intermediate `slots` snapshot for undo.

## Decision

**1. Correlation id shape.** Every gesture gets a `gestureId` the moment it is armed
(`armed()` in `dragFSM.js`, called from `IDLE.POINTER_DOWN` and from `reArm`). It is
generated in the *impure* binding (`useDragFSM.js`), not inside the pure module —
`dragFSM.js` must stay free of `crypto.randomUUID()`/side-effecting id generation
per its own file-header contract ("no DOM, no React, no @dnd-kit, no localClient").
Concretely:

- `useDragFSM.js`'s `onPointerDownCapture` and `onDragStart` (the two call sites
  that dispatch `POINTER_DOWN`) generate `gestureId: crypto.randomUUID()` and put it
  on the event: `dispatch({ type: 'POINTER_DOWN', kind, hit, gestureId: crypto.randomUUID() })`.
- `dragFSM.js`'s `armed(event, extra)` copies `event.gestureId` into `context`
  (`context: { kind, initialHit, movingHit, finalHit, gestureId: event.gestureId, ...extra }`).
  It already threads arbitrary context through unchanged states, so this is additive,
  not structural.
- The `commit` side effect (emitted from `DRAGGING.POINTER_UP`) already carries
  `kind`, `initialHit`, `finalHit`; add `gestureId: state.context.gestureId`. This is
  pure — `state.context.gestureId` is already in scope at that point in the table.
- `useDragFSM.js`'s `perform()`, case `'commit'`, closes over `effect.gestureId` and
  passes it back on the eventual result: `dispatch({ type: 'COMMIT_SUCCESS', gestureId: effect.gestureId })`
  / `dispatch({ type: 'COMMIT_FAILURE', error, gestureId: effect.gestureId })`.

**2. Where the match happens.** Inside `transition()`, in the pure table — not in
the binding. `RESOLVING`'s `COMMIT_SUCCESS`/`COMMIT_FAILURE` handlers gain a guard:
if `event.gestureId !== state.context.gestureId`, treat it as `ignore` (same as
every other state already does for a commit result). Reasoning: matching in the
binding would require the binding to inspect FSM context to decide whether to
dispatch at all, which either (a) duplicates state the pure machine already owns, or
(b) requires exposing `stateRef` reads from `perform()`, both of which erode the
purity boundary the file header protects. A stale-but-still-dispatched event that
the *table* rejects is exactly the existing pattern (`POINTING`/`DRAGGING`/`IDLE`
already ignore commit results structurally); adding an equality check inside
`RESOLVING`'s two handlers extends that pattern instead of inventing a new one.

`transition()`'s signature does **not** change — still `(state, event) ->
{ nextState, sideEffects }`. Only `RESOLVING`'s two handler bodies change:

```js
COMMIT_SUCCESS: (state, event) => {
  if (event.gestureId !== state.context.gestureId) return ignore(state)
  return { nextState: idleState, sideEffects: [{ type: 'clearDropIndicator' }] }
},
COMMIT_FAILURE: (state, event) => {
  if (event.gestureId !== state.context.gestureId) return ignore(state)
  return {
    nextState: idleState,
    sideEffects: [
      { type: 'clearDropIndicator' },
      { type: 'announceCommitFailure', kind: state.context.kind, error: event.error ?? null },
    ],
  }
},
```

Every other transition, every other state's handling of `POINTER_DOWN` / `DRAG_START`
/ `POINTER_MOVE` / `POINTER_UP` / `CANCEL`, and `reArm`'s teardown/self-heal behavior
are untouched. A gesture that reArms still tears down cleanly and starts fresh with
a new `gestureId` — reArm calls `armed(event, extra)` on the *new* `event`, which
carries its own freshly generated `gestureId`, so the replaced gesture's stale
`gestureId` is simply gone from `state.context` once reArm completes. This is why a
late result from gesture 1 arriving after gesture 2 has reArmed is correctly
ignored: gesture 2's `context.gestureId` no longer matches gesture 1's.

Idle/Pointing/Dragging's existing `COMMIT_SUCCESS: ignore` / `COMMIT_FAILURE: ignore`
entries need no gestureId check — they already discard the event unconditionally,
which remains correct (a commit result cannot be "for" a gesture that produced no
commit).

**3. `commit()` promise propagation — do NOT wire it up. Confidence: high.**

`dragHandlers.js`'s `commit(active, hit)` calls `replaceSlot`/`placeActivityManual`/
`expandSlot` without `await` or `return`. But those handlers (`useSlotMutations.js`)
are already internally `try/catch`-wrapped: every write failure is caught, routed
through `setActionError(describeWriteFailure(...))`, and the function **returns
normally** — none of them re-throw. So even if `useDragFSM.js`'s `perform()` awaited
`commit()`'s return value, the returned promise would still resolve, never reject:
`COMMIT_FAILURE` would still never fire from a real write failure, only from a
`commit()` call that throws synchronously or a `hit`/`active` shape the FSM itself
rejects. Making `commit()` return its promise and having `useDragFSM` await it would
add a layer of plumbing (return the promise from `commit`, thread it through
`makeDragHandlers`, `Promise.resolve().then(() => commit(...))` already assumes a
promise-like return) that changes nothing observable, because the failure signal it
would carry is structurally absent at the source. The current design — mutation
hooks own their own error UX via `setActionError`, and `COMMIT_SUCCESS` fires as
soon as the mutation call has been dispatched (not settled) — is the existing,
working mitigation named directly in the problem statement. Leave it as-is. If a
future task wants the FSM's `announceCommitFailure` path to reflect real write
outcomes (not just outcomes the FSM itself can detect, like a `commit()` throw), that
requires deciding whether mutation hooks should stop swallowing their own errors —
a bigger, separable product/architecture decision, not part of this bug fix.

**4. Issue 2 (stale undo snapshot) — fixed in this pass via a fresh-read
snapshot. Confidence: medium-high.**

The correlation-id fix only serializes/discards stale **FSM commit-result events**
(`COMMIT_SUCCESS`/`COMMIT_FAILURE`). `replaceSlot`'s undo-snapshot staleness is a
different data path entirely: it reads `slots` (a React closure over render state)
synchronously at call time, before either write's `await` resolves. Two fast
same-cell drags produce two `commit()` calls in the same or adjacent renders; if
React has not yet re-rendered between them, both `replaceSlot` invocations can close
over the *same* stale `slots` array and compute the same `prevTargetActivityId` for
their undo snapshots — independent of whether the FSM's gesture correlation is
fixed, because this happens inside `dragHandlers.js`/`useSlotMutations.js`, entirely
downstream of the FSM's `commit` side effect being *issued*.

This ADR originally recommended deferring the fix as a separate follow-up. Governor
decided to fold it into this pass instead (ticket scope), choosing the fresh-read
mechanism over serializing same-cell writes. **Mechanism built:**
`useSlotMutations.js` keeps a `slotsRef` (`useRef`, synced to the `slots` prop on
every render via `useEffect`) that `replaceSlot`'s own `setSlots` updater also
writes into, from inside the updater callback, every time it runs. Because React
applies queued functional updates in true chronological order regardless of
whether a repaint/re-render has actually happened, `slotsRef.current` reflects the
truest known state at the moment each `replaceSlot` call actually executes — not
just the state as of the render that produced the closure calling it. `replaceSlot`
now reads its pre-write `prevTargetActivityId`/`prevTargetFlags`/
`prevSourceActivityId`/`prevSourceFlags` snapshot through `slotsRef.current` instead
of the closed-over `slots` prop, immediately before issuing its writes. `targetRow`/
`sourceRow` themselves (used for their stable `id` and the anchor/existence checks)
are still read from the closed-over `slots` — only the snapshot *values* being
preserved for undo/redo are fresh-read.

This closes the specific, testable race: two `replaceSlot` calls made on the same
hook instance with no re-render between them (`useSlotMutations.test.js`, "two fast
same-cell replaceSlot calls") now produce a second undo that restores what the
*first* call actually placed, not the value both calls would previously have agreed
on from a shared stale closure. Single-drag undo/redo is unchanged (regression test
in the same file). A fully-simultaneous race — two writes both in flight with
neither's result locally known yet at capture time — is not addressed by this
mechanism, since no client-side snapshot can know an outcome that hasn't happened;
that residual case still requires a data-layer fix (repo-level read-freshness or
write serialization) and was already out of scope for a client-side gesture-timing
change. No permanent data loss either way (per the original problem statement).

**5. LOW cleanup — dead `displacedItems` plumbing.**

Confirmed via `grep`: `ScheduleScreen.jsx` destructures `setDisplacedItems` from
`useOverlayFillStamp` and passes it into `useSlotMutations`, but `displacedItems`
(the read value) is never rendered anywhere in `ScheduleScreen.jsx` or any component
it renders. The only remaining readers are `useOverlayFillStamp.test.js` (asserts
against `result.current.displacedItems`) and a comment in a legend test. Remove:
- `useOverlayFillStamp.js`: the `displacedItems` state (`useState([])`) and its
  return-object entry — but only if `setDisplacedItems` is also no longer needed by
  `expandSlot`/`splitSlot` in `useSlotMutations.js`. It is: `expandSlot` and
  `splitSlot` call `setDisplacedItems` on both the primary path and their
  undo/redo closures purely to feed the (dead) tray. Once nothing reads
  `displacedItems`, those calls become writes to a value nobody observes — remove
  the `setDisplacedItems` calls from `expandSlot`'s forward path, undo, and redo,
  and from `splitSlot`'s forward path and undo; remove the `setDisplacedItems`
  parameter from `useSlotMutations`'s injected-dependencies object and from
  `ScheduleScreen.jsx`'s call site.
- Preserve everything else in `expandSlot`/`splitSlot` exactly as-is: the op-log
  writes (`activity_id`, `is_span_head`, `flags.expanded`), the undo/redo closures'
  write-then-`setSlots` pattern, and `flags.expanded`'s `displacedActivityId`/
  `displacedActivityName`/`from_block` shape (still needed — `splitSlot` reads
  `headSlot.flags.expanded` to know what to restore; this is unrelated to the
  palette tray and must not be touched).
- Update `useOverlayFillStamp.test.js` to drop the `displacedItems` assertions (or
  delete the test cases that exist solely to assert on it, if nothing else in that
  test body is being verified). Check `legend.test.js`'s comment reference and
  update/remove the comment if it now describes something that no longer exists.

## Test seam plan (pure FSM boundary — `dragFSM.test.js` or equivalent)

All of these call `transition(state, event)` directly; no DOM, no React, no timers.

1. **Stale `COMMIT_SUCCESS` ignored.** Build a `RESOLVING` state with
   `context.gestureId = 'g1'`. Dispatch `{ type: 'COMMIT_SUCCESS', gestureId: 'g2' }`.
   Assert `nextState === state` (unchanged) and `sideEffects` is `[]` — mirrors the
   existing `ignore` contract used elsewhere in the table.
2. **Stale `COMMIT_FAILURE` ignored.** Same `RESOLVING` state (`gestureId: 'g1'`).
   Dispatch `{ type: 'COMMIT_FAILURE', gestureId: 'g2', error: new Error('x') }`.
   Assert state unchanged, no `announceCommitFailure` side effect emitted.
3. **Correct-gesture `COMMIT_SUCCESS` still transitions to Idle.** `RESOLVING` with
   `gestureId: 'g1'`, dispatch `{ type: 'COMMIT_SUCCESS', gestureId: 'g1' }`. Assert
   `nextState === idleState` and `sideEffects === [{ type: 'clearDropIndicator' }]`
   — unchanged from current behavior.
4. **Correct-gesture `COMMIT_FAILURE` still announces.** `RESOLVING` with
   `gestureId: 'g1'`, dispatch `{ type: 'COMMIT_FAILURE', gestureId: 'g1', error }`.
   Assert `nextState === idleState` and `sideEffects` contains
   `{ type: 'announceCommitFailure', kind, error }` — unchanged from current
   behavior.
5. **reArm still self-heals and produces a fresh gestureId.** From `RESOLVING`
   (`gestureId: 'g1'`), dispatch `{ type: 'POINTER_DOWN', kind, hit, gestureId: 'g2' }`.
   Assert `nextState.name === POINTING`, `nextState.context.gestureId === 'g2'`, and
   `sideEffects` still contains the `RESOLVING` teardown (`clearDropIndicator`) —
   confirms reArm's existing teardown-then-rearm contract is untouched by the change.
6. **End-to-end interleaving scenario (the bug itself, reproduced and proven
   fixed).** Simulate the exact race: `IDLE` → `POINTER_DOWN(g1)` → `DRAG_START` →
   `POINTER_UP` (valid hit) → now `RESOLVING(g1)`. Then a second gesture starts:
   `POINTER_DOWN(g2)` (reArm fires, `RESOLVING(g1)` torn down, → `POINTING(g2)`) →
   `DRAG_START` → `POINTER_UP` → `RESOLVING(g2)`. Now dispatch gesture 1's late
   `COMMIT_SUCCESS(g1)` — assert it's ignored (state stays `RESOLVING(g2)`
   unchanged). Then dispatch gesture 2's `COMMIT_FAILURE(g2)` — assert it
   transitions to `Idle` *and* emits `announceCommitFailure`. This is the specific
   before/after: before the fix, `COMMIT_SUCCESS(g1)` would have flipped the machine
   to `Idle` at step 5, and `COMMIT_FAILURE(g2)` at step 6 would then have been
   ignored (Idle ignores it) — the bug. After the fix, gesture 2's own result is the
   only one that lands.
7. **Regression coverage for unrelated states.** Existing tests for `IDLE`/
   `POINTING`/`DRAGGING` ignoring `COMMIT_SUCCESS`/`COMMIT_FAILURE` should continue
   to pass unmodified — those handlers are untouched (still `ignore` = a plain
   function ignoring `event`, no `gestureId` field to check because those states
   never look at it).

Binding-level (`useDragFSM.js`) coverage, if the project's existing test file for it
follows this pattern, should add one integration-style test asserting that two
sequential `perform({ type: 'commit', ... })` calls generate two distinct
`gestureId`s (i.e., `crypto.randomUUID()` is actually called per dispatch, not
memoized/reused) — this is the one piece of the fix that lives in the impure file
and can't be proven at the pure boundary alone.

## Consequences

- `dragFSM.js`'s event/context shape gains one field (`gestureId`) threaded through
  `armed()`, the `commit` effect, and `COMMIT_SUCCESS`/`COMMIT_FAILURE` events. Any
  other code that constructs these events by hand (tests, mocks) must supply it, or
  correctly omit it only when testing states other than `RESOLVING` guard logic
  where undefined would trivially mismatch — the pre-existing `POINTING`/`DRAGGING`/
  `IDLE` handlers for these two event types remain `ignore` and never read
  `gestureId`, so they need no update.
- `useDragFSM.js` gains one `crypto.randomUUID()` call per `POINTER_DOWN` dispatch
  site (two call sites: `onPointerDownCapture`, `onDragStart`'s own reArm branch).
  `crypto.randomUUID()` is already used elsewhere in this codebase
  (`useSlotMutations.js`'s `createActivityFromCell`), so no new dependency.
- No change to stored/synced data, the op-log, sync/replay, migrations, or the
  Manual/Generated route split — this is purely an in-memory gesture-sequencing fix
  local to one browser tab's DOM interaction layer.
- Issue 2 (stale undo snapshot) IS fixed by this change (Governor decision,
  Part 4 above): `useSlotMutations.js` gains a `slotsRef` used only by
  `replaceSlot`'s undo/redo snapshot capture. No change to the write shape
  sent to `repo`, the op-log, or any other handler in the file.
- Dead `displacedItems` tray plumbing (state, setter, and the construction
  sites in `expandSlot`/`splitSlot` that fed it) is removed from
  `useOverlayFillStamp.js`, `useSlotMutations.js`, and `ScheduleScreen.jsx`.
  `flags.expanded`'s `displacedActivityId`/`displacedActivityName`/
  `from_block` shape is untouched — `splitSlot` still reads it to restore a
  split; only the now-unrendered tray built on top of it is gone.
