# Recency-gated live writes for same-cell drag mutations

## Status
Proposed.

## Context

`docs/adr/2026-08-12-drag-fsm-gesture-correlation.md` ("the gesture-correlation
ADR") fixed two things: (1) the drag FSM's `RESOLVING` state no longer acts on a
`COMMIT_SUCCESS`/`COMMIT_FAILURE` event belonging to a superseded gesture, and
(2) `replaceSlot`'s undo-snapshot capture reads a `slotsRef` fresh at call time
instead of a stale render closure, closing the case where two same-cell
`replaceSlot` calls with no re-render between them would compute an identical
(and wrong) "previous" value for undo.

That ADR named its own residual scope explicitly (Part 4, final paragraph):

> A fully-simultaneous race — two writes both in flight with neither's result
> locally known yet at capture time — is not addressed by this mechanism, since
> no client-side snapshot can know an outcome that hasn't happened; that
> residual case still requires a data-layer fix (repo-level read-freshness or
> write serialization) and was already out of scope for a client-side
> gesture-timing change.

This ADR is that data-layer fix. Verified against the code on this branch
(off merged main `a7ee973`, which includes the gesture-correlation ADR) —
premise confirmed, not stale:

- **Facet 1 (HIGH) — live write ordering.** `useSlotMutations.js`'s
  `replaceSlot` (line ~104-125) does `await Promise.all(writes)` and then calls
  `setSlots(prev => ...)` unconditionally on resolution. Nothing records which
  gesture's write is "the latest for this cell" or checks that before applying
  the result. Two same-cell drags fired close together each run this
  independently; whichever `Promise.all` settles last wins the final
  `setSlots`, even if it belongs to the *earlier* gesture. The director sees
  their most recent edit silently revert to what they placed a moment before —
  no error, no flag, no `COMMIT_FAILURE` (the gesture-correlation fix only
  gates the FSM's own `RESOLVING` state transition, not this `setSlots` call,
  which runs regardless of what the FSM does with its own commit-result
  event).
- **Facet 2 (MEDIUM) — `expandSlot`/`splitSlot` still snapshot off the stale
  `slots` closure.** The gesture-correlation ADR's fresh-read fix
  (`slotsRef`) was applied only to `replaceSlot` (confirmed: `slotsRef` is
  read only inside `replaceSlot`, `useSlotMutations.js` lines 94-102).
  `expandSlot` (line ~345-346) and `splitSlot` (line ~415, ~419) still read
  `headSlot`/`tailSlot` from the `slots` prop closure to compute
  `prevHeadFlags`/`prevTailActivityId`/`prevTailIsSpanHead` for their undo
  entries — same class of bug, different handlers.
- **Facet 3 (MEDIUM) — no undo dedup.** `useUndoRedo.js`'s `pushUndo` (line
  18-24) unconditionally appends. Two raced same-cell gestures that the
  director experienced as one action produce two undo-stack entries; `Ctrl+Z`
  once does not fully undo what looked like one edit.

Root cause common to all three: none of `replaceSlot`, `expandSlot`,
`splitSlot`, or `pushUndo` know, at the moment a write settles or an undo
entry is recorded, whether a *newer* gesture has already targeted the same
cell. There is no per-target notion of "which gesture is now the ground
truth for this cell."

## Decision

**Recommendation: a monotonic per-cell gesture-recency token gating the
`setSlots` application, combined with reusing the FSM's existing `gestureId`
as that token — not a write-serialization queue. Confidence: high.**

### Candidates considered

1. **Per-target in-flight lock / queue** — hold a `Map<cellKey, Promise>` and
   make a second same-cell mutation call `await` the first before issuing its
   own IPC write. Rejected as the primary mechanism: it changes *when* the
   second write is sent (delays it behind the first), which is observable
   latency the director did not ask for, and it does nothing for facets 2/3
   on its own — undo snapshot correctness and undo-stack dedup are not queue
   problems, they are "which result is current" problems. A queue also has to
   pick a cell-key granularity that agrees with `replaceSlot`'s two-cell
   (source+target) writes, which raises its own ordering questions (what if
   gesture A's source cell is gesture B's target cell?).
2. **Monotonic gesture-recency token on the live commit ("both" option,
   token-only half)** — every drag gesture already gets a `gestureId`
   (`crypto.randomUUID()`, generated in `useDragFSM.js`, threaded through
   `dragFSM.js`'s `commit` effect per the gesture-correlation ADR). Thread
   that same id through `dragHandlers.js` → `replaceSlot`/`expandSlot`/
   `splitSlot`, and keep a per-cell "last gesture applied" record. When a
   write resolves, apply `setSlots` only if no *newer* gesture has already
   applied a result to that cell; otherwise drop the stale result silently
   (no error — the newer edit already committed the cell to what the director
   actually chose). Selected: this fixes facet 1 directly, requires no new
   IPC/op-log shape, and the `gestureId` plumbing already exists end-to-end
   from the prior ADR — this reuses it rather than inventing a second
   correlation mechanism.
3. **Both (queue + token)** — rejected as unnecessary. The token alone fully
   resolves facet 1's observable symptom (stale write must never overwrite a
   newer one). A queue would add serialized latency and a second source of
   truth (queue order vs. token recency) without fixing anything the token
   doesn't already fix. If a future measurement shows the token approach lets
   writes hit `better-sqlite3` in a genuinely conflicting order that matters
   at the persistence layer (see "Out of scope" below), that is grounds to
   revisit — not a reason to build both now.
4. **Do nothing client-side; rely on the op-log/`client_write_id` layer** —
   rejected. `client_write_id` (generated inside `localClient.write`, per
   `electron/main.js`'s IPC handler — not touched by this design) gives
   idempotent *retry* safety for a single logical write, not last-writer-wins
   arbitration between two *different* logical writes to the same field from
   the same tab. That is a UI-gesture-ordering problem, not a sync-protocol
   problem, and belongs in the renderer where the gesture identity already
   lives.

### Mechanism

**New primitive: a per-cell recency ledger, owned by `useSlotMutations`.**

```js
// key: `${groupId}|${dayId}|${blockId}` — same granularity as the existing
// slot lookup predicates (group_id/day_id/time_block_id) used throughout
// this file, so no new addressing scheme.
const cellGestureRef = useRef(new Map())  // cellKey -> latest gestureId claimed
```

- `replaceSlot(incoming, target, gestureId)` gains a third parameter,
  `gestureId` (optional — undefined for non-drag callers, see below).
  Immediately after `setActionError(null)` and before issuing the write(s),
  it **claims** every cell it is about to write:
  `cellGestureRef.current.set(cellKey, gestureId)` for the target cell, and
  for the source cell when `sourceRow` exists. This claim happens
  synchronously, before the `await`, so a second call arriving before the
  first's write resolves overwrites the claim immediately — the ledger
  always reflects "the last gesture that *started* touching this cell," which
  is exactly the recency signal needed.
- When the write(s) resolve, `replaceSlot` checks, per cell, whether
  `cellGestureRef.current.get(cellKey) === gestureId` (i.e., no newer gesture
  has claimed that cell since this one started). Only cells that still match
  get folded into the `setSlots` updater; a cell whose claim has moved on is
  skipped for that field in the `next` map (the newer gesture's own
  `replaceSlot` call is responsible for that cell's slice of `setSlots` —
  this call simply does not clobber it).
  - If **both** target and source cells are stale for a given call, the call
    contributes nothing to `setSlots` and **does not call `pushUndo`** — see
    facet 3 below.
  - If only one of the two cells is stale (e.g. a same-cell-target,
    different-source race), only the still-current cell is applied; the
    undo/redo closures are built to guard the same way at replay time (an
    undo/redo closure also checks the ledger before writing — see below —
    so a stale undo never resurrects a value a newer gesture has since
    overwritten).
- `expandSlot`/`splitSlot` gain the identical claim-check-apply shape for
  their head/tail cells, using the same `cellGestureRef` and the same
  `gestureId` parameter — this is facet 2's fix, reusing facet 1's
  mechanism rather than inventing a second one.
- **Undo/redo closures also check the ledger before writing**, using the
  `gestureId` captured in their own closure (the id of the gesture that
  created the undo entry). `undo()`/`redo()` re-claim the cell for their own
  entry's `gestureId` immediately before writing, exactly like the forward
  path — an undo run after a newer gesture has since touched the same cell
  is therefore visible and correct in the ledger, not a silent stomp. This
  does not change `useUndoRedo.js`'s stack mechanics (still last-in dumb
  stack) — it only makes each entry's own write self-consistent with
  whatever else has happened to that cell since.
- **`pushUndo` dedup (facet 3):** rather than adding dedup logic to
  `useUndoRedo.js` (which would have to guess "same logical action" from
  entry shape it doesn't otherwise inspect — against this hook's own
  "dumb stack machine" contract, see its file header), the fix lives at the
  call site: `replaceSlot`/`expandSlot`/`splitSlot` simply skip calling
  `pushUndo` when their write's claim was fully superseded before it could
  be applied (see above — zero cells applied ⇒ no undo entry, because
  nothing observable changed as a result of this call; the superseding
  gesture already has its own undo entry covering the cell's true final
  state transition). This keeps `useUndoRedo.js` untouched and keeps the
  "one user action, one undo entry" invariant without new stack-level
  logic.

**Where `gestureId` comes from for each call site:**
- `dragHandlers.js`'s `commit(active, hit, gestureId)` gains the third
  parameter (already available: `dragFSM.js`'s `commit` effect already
  carries `gestureId` per the prior ADR, and `useDragFSM.js`'s `perform()`
  already closes over `effect.gestureId` — passing it one call further into
  `commit()` is additive plumbing, not new id generation). It forwards
  `gestureId` into every `replaceSlot`/`placeActivityManual`/`expandSlot`
  call it makes.
- Non-drag callers of `replaceSlot`/`expandSlot`/`splitSlot` (there are
  none today per `grep` — `dragHandlers.js` is the only caller of
  `replaceSlot`/`expandSlot`; `splitSlot` is called from a click handler
  elsewhere in `ScheduleScreen.jsx`) pass no `gestureId`. **Design rule:** a
  call with `gestureId === undefined` always claims and always wins its own
  check (treat `undefined` as "always current" — a single click-driven
  mutation with no concurrent gesture of its own has nothing to race
  against, and requiring every call site to synthesize an id would be
  needless plumbing for paths that provably cannot race with themselves).
  `placeActivityManual` (drag-and-drop-to-empty-cell and the inline-editor
  path) is **out of scope for this pass** — see "Non-goals."

### Files/modules affected

- `src/screens/schedule/useSlotMutations.js` — `cellGestureRef` added;
  `replaceSlot`, `expandSlot`, `splitSlot` gain a `gestureId` parameter and
  the claim/check/apply logic described above, including their undo/redo
  closures. `slotsRef` (existing, from the prior ADR) is unchanged.
- `src/screens/schedule/dragHandlers.js` — `commit(active, hit, gestureId)`
  gains the parameter, forwards it to the three mutation calls it makes.
- `src/screens/schedule/useDragFSM.js` — the `'commit'` case in `perform()`
  passes `effect.gestureId` as `commit`'s third argument (one-line change;
  `effect.gestureId` is already in scope there per the prior ADR).
- `src/screens/ScheduleScreen.jsx` — the `makeDragHandlers`/`commit`
  call sites and the direct (non-drag) `expandSlot`/`splitSlot`/
  `replaceSlot` call sites (if any exist outside `dragHandlers.js` — confirm
  during implementation) are updated only if they need to pass a
  `gestureId`; per the design rule above, omitting it is a legitimate,
  distinct code path, not a gap.
- No change to `dragFSM.js` (pure module, no new fields on its own state/
  event shapes — `gestureId` already exists on `commit`'s effect object from
  the prior ADR).
- No change to `src/data/scheduleRepository.js`, `electron/main.js`,
  `electron/preload.js`, `localClient.write`, `client_write_id` generation,
  the `operations` table, or any op-log/sync/replay code.

### Reused vs. new

- **Reused:** the `gestureId` correlation mechanism and its generation site
  (`crypto.randomUUID()` in `useDragFSM.js`), in full, per the prior ADR —
  this design deliberately does not invent a second id scheme.
- **Reused:** the existing cell-addressing predicate
  (`group_id`/`day_id`/`time_block_id` triple) already used throughout
  `useSlotMutations.js` for slot lookups — `cellGestureRef`'s key is built
  from the same three fields, just joined into a string.
- **New:** `cellGestureRef` (a `useRef(Map)`) and the claim/check/apply
  control flow inside `replaceSlot`/`expandSlot`/`splitSlot`. This is
  genuinely new — nothing in the codebase currently tracks "which gesture
  last touched this cell." It is intentionally scoped to these three
  handlers (the ones that mutate `template_slots.activity_id`/`flags`/
  `is_span_head` from a drag gesture) rather than generalized into a
  shared hook, per the karpathy guideline below.

### Non-goals

- **`placeActivityManual` is out of scope.** It is reachable from a drag
  (empty-cell drop) and from the inline-editor click/typeahead path
  (`createActivityFromCell` → `placeActivityManual`). Because it only ever
  writes to a cell that starts empty (`if (!slot || slot.is_anchor) return`
  — it does not overwrite an occupied cell; `dragHandlers.js` routes
  occupied-target drops to `replaceSlot` instead, line 59-62), the specific
  "two writes race to decide the cell's final value" scenario this ADR
  fixes cannot occur on `placeActivityManual`'s own writes today. Extending
  the ledger to it is a small follow-up if that invariant ever changes, not
  required now.
- **`dismissFlag`, `lockActivity`, `releaseCell`, `addOverlay`,
  `removeOverlay`, `updateOverlayRange`, `createActivityFromCell`'s own
  activity-creation write** are untouched — none of them are reachable from
  a same-cell drag race; they are single-target, non-drag-gesture actions.
- **No change to the op-log write shape, `client_write_id`, or IPC surface**
  (hard constraint, preserved — see "Reused vs. new").
- **No change to seeded engine determinism** (`buildSchedule.js` is untouched
  and out of this data path entirely).
- **No change to two-routes semantics** — the ledger is keyed identically
  regardless of `route`; `UNFILLABLE`/`OVERLAP` flag computation is
  unaffected.
- **No change to `scheduleGrid.css`** — this is state/data-flow only, no new
  ephemeral visual cell state is introduced (a dropped stale write is
  invisible by design: the cell already shows the newer gesture's result).

## Test seam plan

All at the `useSlotMutations` hook-test boundary (`useSlotMutations.test.js`,
same file/pattern as the existing "two fast same-cell `replaceSlot` calls"
regression test from the prior ADR — this extends that suite, does not
replace it).

1. **The exact repro, fixed (facet 1).** Two `replaceSlot` calls on the same
   target cell, different `gestureId`s (`g1` then `g2`), where **g1's write
   promise resolves after g2's** (control this with two manually-resolvable
   promises on the mocked `repo.writeSlotFields`, resolving g2's first, then
   g1's). Assert: after both resolve, `slots` reflects **g2's** placement, not
   g1's — the late-resolving-but-superseded write must not win.
2. **In-order resolution is a no-op change in behavior.** Same two calls,
   resolved in gesture order (g1 then g2). Assert identical final state to
   today's behavior — the fix must not alter the common, non-racing case.
3. **`expandSlot` stale-snapshot fixed (facet 2).** Two `expandSlot` calls
   racing the same head cell with different `gestureId`s, no re-render
   between them (mirrors the prior ADR's `replaceSlot` regression test
   structure exactly, applied to `expandSlot`). Assert the resulting undo
   entry's captured `prevHeadFlags` matches what was actually true
   immediately before the *surviving* gesture's write, not a value shared
   with the other racing call.
4. **`splitSlot` stale-snapshot fixed (facet 2).** Same shape as (3), for
   `splitSlot`'s head/tail snapshot.
5. **Undo dedup — one user action, one undo entry (facet 3).** Run the
   facet-1 repro (two same-cell `replaceSlot` calls, g1 superseded by g2).
   Assert `pushUndo` was called **exactly once** (for g2), not twice — the
   superseded call must not push a phantom undo entry for a change that
   never took visible effect.
6. **Superseded undo/redo re-check.** Construct an undo entry from gesture
   g1, then simulate g2 having since claimed the same cell (advance
   `cellGestureRef` past g1 out of band, as a same-cell `replaceSlot(..., 'g2')`
   would). Run g1's `undo()`. Assert the write happens (undo always writes —
   it's an explicit user action) but the ledger correctly reflects g1 as
   current again post-undo, and a subsequent `redo()` on g2's entry (if the
   director's redo stack still holds it) restores g2's value cleanly, i.e.
   undo/redo remain individually correct even though they belong to
   different gestures on the same cell — no crash, no dropped stack entry,
   no doubled write.
7. **Non-drag call (`gestureId === undefined`) always applies.** A single
   `replaceSlot` call with no `gestureId` argument behaves exactly as today
   — claims and applies unconditionally. Regression guard for the "always
   wins its own check" design rule.
8. **Cross-handler race (target of one gesture is source of another).**
   `replaceSlot(g1)` targets cell A; `replaceSlot(g2)` on a different pair
   uses cell A as its *source* (moving A's occupant elsewhere) and resolves
   after g1. Assert cell A ends up matching g2's write (g2 is the newer
   claim on A), not g1's — proves the per-cell (not per-call) granularity
   of the ledger does the right thing across the two-cell write shape
   `replaceSlot` already has.

**This test seam plan proves facets 1–3 fixed by construction** (each test
is a direct interleaving repro, not a proxy metric) and is runnable entirely
within the existing Vitest + mocked-repo harness already used by
`useSlotMutations.test.js` — no Electron, no real SQLite, no timing-dependent
`setTimeout`/`sleep` (promises are resolved by hand, in test-controlled
order).

**Follow-up requirement:** the serialization/recency machinery built from
this ADR (the `cellGestureRef` ledger and its claim/check/apply logic) must
get its own Red Hat pass once implemented — this is exactly the kind of new
concurrency primitive the prior ADR's own HIGH finding came out of a Red Hat
review on. Do not treat the test seam plan above as a substitute for that
adversarial pass; it is evidence for Red Hat to start from, not a replacement
for it.

## Consequences

- `replaceSlot`, `expandSlot`, `splitSlot` gain one new parameter
  (`gestureId`, optional) and each grows a claim/check/apply step around
  their existing write-then-`setSlots` shape. `dragHandlers.js`'s `commit`
  gains the same parameter and forwards it. This is additive to existing
  signatures (optional param, default `undefined` behaves as today) —
  no existing call site breaks if `gestureId` is omitted.
- A new per-hook-instance `cellGestureRef` (in-memory only, never persisted,
  never synced) is introduced. It is reset implicitly on remount (new
  `useRef`) — no explicit reset needed on route switch, since `useSlotMutations`
  is scoped per `ScheduleScreen` instance and route switches don't remount it
  today (confirm during implementation that this doesn't need the same
  transient-reset treatment `useUndoRedo`'s stacks get; if a route switch can
  leave stale claims from the old route's cells, add `cellGestureRef.current.clear()`
  to the screen's existing transient-reset block — cheap, defensive, and
  consistent with how undo stacks are already handled on route switch).
- Stale writes are now silently dropped at the `setSlots`-application step
  rather than winning-by-luck. This is a deliberate, intended behavior
  change: the director's most recent action always wins, with no error
  shown for the superseded gesture (nothing failed — a newer, valid action
  simply superseded it, which is not an error state).
- No change to stored/synced data shape, the op-log, `client_write_id`,
  `write` IPC surface, sync/replay, migrations, engine determinism, or the
  Manual/Generated route split.
- `placeActivityManual` remains unguarded by this ledger (see Non-goals) —
  a future task that lets it overwrite an occupied cell must revisit this
  ADR's scope decision.
