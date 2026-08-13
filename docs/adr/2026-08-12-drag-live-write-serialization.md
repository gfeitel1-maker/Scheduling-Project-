---
title: "Per-cell write serialization for same-cell drag mutations"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-12
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
---

# Per-cell write serialization for same-cell drag mutations

## Status

Revised. The token-only design (2026-08-12, first version of this ADR) was
implemented (`4a1cf09`, `1be819a`) and then **reversed by a Red Hat pass**
that verified the failure against the actual op-log replay code. That
implementation is discarded — see "Consequences / decision reversal" below
for what was wrong and why. This revision is the replacement design; nothing
from the token-only mechanism survives into it.

## Context

`docs/adr/2026-08-12-drag-fsm-gesture-correlation.md` ("the gesture-correlation
ADR") fixed two things in the drag FSM: stale `COMMIT_SUCCESS`/`COMMIT_FAILURE`
events no longer act on a superseded gesture, and `replaceSlot`'s undo-snapshot
capture reads a fresh `slotsRef` instead of a stale render closure. It named
its own residual scope explicitly: a fully-simultaneous race where two writes
are both in flight with neither's result locally known yet requires "a
data-layer fix (repo-level read-freshness or write serialization)."

The first version of this ADR proposed that data-layer fix as a **client-side
recency token**: a per-cell `Map` recording the latest `gestureId` to touch a
cell, checked when each write's `Promise.all` resolved, gating whether
`setSlots` applied that call's result. It was implemented and passed its own
test seam plan (8 tests, all at the `setSlots`-application boundary).

## Consequences / decision reversal

A Red Hat pass on the landed mechanism found it fixed the **screen** but not
the **database**, and verified the mechanism by which that happens against
`electron/ops/projections.js`, not against inference from the client code
alone. Four findings, in severity order:

1. **(HIGH) The ledger gated only the in-memory `setSlots` call, not the
   `repo.writeSlotFields` IPC call — which fired unconditionally, before any
   recency check, for every write `replaceSlot`/`expandSlot`/`splitSlot`
   issued.** Confirmed in `useSlotMutations.js`: every call site
   (`repo.writeSlotFields(...)`, e.g. lines 142-143, 186-187, 208-209,
   360, 436-439, 469-470, 489-490, 539-540, 573-574, 593-594) executes before
   the claim/check step that only ever gated `setSlots`. The op-log applies
   field writes in **seq (append/arrival) order**, not gesture-timestamp
   order — `electron/ops/projections.js:250`, "Op replay is seq-ordered, so
   the write-site order is the replica order," and `:349`, a field is
   "overwritten by the subsequent write() for that field" (subsequent in
   arrival order, not in gesture-recency order). So: gesture A (older) can
   have its write land at the database *after* gesture B's (newer) write, if
   A's IPC round-trip is slower — giving A's write the higher seq and making
   it the value every peer's replay converges on. Meanwhile the ledger
   already corrected the screen to B's value. Screen and database — and
   every other device this camp syncs to over LAN — **silently diverge**,
   surfacing only on reload or next sync, with no error and no flag. A
   client-side gate on `setSlots` cannot fix this by construction: the bug
   is in write **order at the persistence layer**, and nothing downstream of
   the write can retroactively reorder it.
2. **(HIGH) `cellKey` had no route/template dimension.** It was built from
   `` `${groupId}|${dayId}|${blockId}` `` only. Per this project's two-routes
   rule (`CLAUDE.md`; `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`),
   Manual and Generated are separate `schedule_templates` rows that share one
   camp setup and the *same* group/day/block coordinate space by design — a
   director can have both routes open (in different windows, or across a
   route switch mid-session) with identical `(groupId, dayId, blockId)`
   triples meaning two unrelated cells. The ledger treated them as the same
   cell: an edit on route A could claim a coordinate that route B's
   in-flight edit had also just claimed, causing route B's legitimate,
   independent write to be silently dropped from the UI (the claim/check
   logic sees it as "superseded") with **no undo entry recorded for it** —
   a genuine edit vanishes, not because it raced anything real, but because
   the key collided across two candidate schedules that must never interact.
3. **(MEDIUM) Undo/redo closures re-issued writes unconditionally relative to
   the currency check** — same gap as finding 1, on the undo path: an
   undo/redo write is not gated at the IPC call either, only (if at all) at
   whatever `setSlots` application follows it.
4. **(MEDIUM) `cellIsCurrent(key, gestureId)` short-circuited on
   `gestureId === undefined` and never consulted the map.** The "non-drag
   caller always wins" design rule became a **blanket bypass**: any write
   with no `gestureId` (a click-driven `splitSlot`/`expandSlot`/
   `createActivityFromCell` call, which carries no gesture) was exempted
   from the recency check entirely, rather than being tracked as `gestureId
   === undefined` on-cell. A late-resolving non-drag click write could
   therefore clobber a newer drag's result at both the screen and — per
   finding 1 — the database, with the mechanism doing nothing to stop it.

Root cause, restated: gating `setSlots` addresses what the **director sees**;
it does not address what gets **written and replayed**. The fix has to live
at (or before) the point where a write is handed to `repo.writeSlotFields`,
not after it resolves.

## Decision

**Recommendation: serialize writes per cell at the point of issuance — a
per-cell async queue that (a) never issues a write for a cell once a newer
claim has superseded it, and (b) chains same-cell writes so that when two do
race into flight, they are guaranteed to reach the database in claim order.
Cell identity includes route/template. Multi-cell operations acquire all
their cells as one atomic unit. Undo/redo and non-drag callers go through the
identical path — no bypass. Confidence: high.**

### Candidate approaches considered

1. **Client-side recency token gating `setSlots` only (the reversed design).**
   Assumption: gating the read-side application is sufficient to protect the
   director's experience of correctness. Rejected — finding 1 is direct proof
   the assumption is false: the database and every synced peer are a load-
   bearing part of "correct," not just the current screen, and this design
   cannot touch write order once a write has already been dispatched.
2. **Compare-and-swap at the write layer (`repo.writeSlotFields` takes an
   `expectedPrevious` value; the write is rejected/retried if the DB no
   longer matches).** Assumption: optimistic concurrency control at the data
   layer is the right primitive, matching how conflict resolution already
   works for genuine cross-device conflicts (`conflicts` table). Rejected as
   the *primary* mechanism here: it changes the `write`/op-log write shape
   (a hard constraint says not to), and it solves a different problem — CAS
   detects a lost update after the fact and requires a retry/resolution UI;
   it does not by itself decide *which* of two same-tab, same-user gestures
   should win, and retrying a superseded gesture's write serves no purpose
   (the director already sees, and wants, the newer one). CAS is the right
   tool for cross-device conflicts, which `conflicts`/`resolveConflict`
   already own — reusing it for a same-tab ordering problem would blur that
   boundary rather than clarify it.
3. **Debounce/coalesce per cell (buffer writes to a cell for a short window,
   flush only the last one).** Assumption: latency is acceptable if it's
   applied uniformly. Rejected: this adds a fixed delay to *every* cell
   write, including the overwhelming majority that never race anything —
   directly contradicts the "smallest responsible" bar and the latency
   concern the reversed design's authors were right to weigh, just applied
   in the wrong place (a delay window penalizes all writes; a queue penalizes
   only writes that actually collide).
4. **Per-cell write-issuance queue with claim-and-drop (chosen).**
   Assumption: ordering must be enforced at the moment a write is *sent*, not
   after it resolves, and the common case (no collision) must cost nothing.
   Selected: it fixes finding 1 by construction (a superseded write is either
   never sent, or is chained strictly behind the write that superseded its
   claim, so seq order at the DB always matches claim order), adds no new
   wire/IPC shape, and the added latency is scoped exactly to the rare
   colliding case (see "Latency" below).

Candidates 2 and 4 are not mutually exclusive in principle — CAS remains the
right mechanism for genuine cross-device conflicts and is untouched by this
ADR. This design is scoped to the same-tab, same-gesture-vs-gesture ordering
problem only.

### Mechanism

**New primitive: a per-cell write queue, owned by `useSlotMutations`,
replacing the recency-token `Map` entirely (not layered on top of it).**

```js
// key: `${route}|${templateId}|${groupId}|${dayId}|${blockId}` — route and
// templateId are now part of cell identity (closes finding 2). Everything
// else keys off the same group/day/block predicate already used throughout
// this file.
const cellQueueRef = useRef(new Map())
// cellKey -> { claimId: string, tail: Promise<void> }
```

- **`claim(cellKeys, claimId)`** — synchronous. For every key in
  `cellKeys`, records `claimId` as that cell's current claimant
  (`cellQueueRef.current.set(key, { claimId, tail: <chained promise> })`).
  Because this runs synchronously before any `await`, a second call
  claiming the same cell always overwrites the first's claim immediately —
  the map is always "the last claim registered," which is the ordering
  signal, independent of network/IPC timing.
- **Chaining, not just checking:** the new `tail` for each cell is built as
  `Promise.allSettled([oldTail]).then(() => runWriteForThisCell())` — i.e.
  the write for a given claim on a given cell is not dispatched to
  `repo.writeSlotFields` until the *previous* claim's write to that cell has
  fully settled. This is what makes finding 1 impossible by construction:
  two writes to the same cell are never in flight to the database at the
  same time, so there is no seq-order to get wrong between them — only one
  is ever "the write in flight," and it always corresponds to the most
  recent claim at dispatch time.
- **Claim-and-drop:** immediately before a queued write actually dispatches
  (i.e., inside the `.then()` above, right before calling
  `repo.writeSlotFields`), it re-checks `cellQueueRef.current.get(key).claimId
  === thisCallsClaimId`. If a newer claim has since taken the cell (because a
  third gesture arrived while this one was queued behind a second), this
  write for this cell is **skipped entirely** — never sent. This handles
  three-or-more rapid same-cell gestures without dispatching writes for any
  but the last.
- **Atomic multi-cell claims.** `replaceSlot` (target + optional source),
  `expandSlot`/`splitSlot` (head + tail) claim **all** their cells as one
  unit:
  - Sort the operation's cell keys into a fixed canonical order (lexical on
    the key string) before claiming or chaining, on *every* call site — this
    prevents deadlock between two multi-cell operations that share cells in
    opposite orders (e.g. op A's source is op B's target and vice versa).
  - Claim all cells for the operation synchronously, then chain a single
    combined tail across all of them (`Promise.allSettled` of each
    involved cell's prior tail).
  - After the combined tail settles, re-check **every** cell this claim
    touched. If **any** cell's claim has moved on, the **entire operation
    aborts**: no write is dispatched for *any* of its cells (not just the
    superseded one), `setSlots` is not called, and `pushUndo` is not called.
    This is the atomicity requirement: a `replaceSlot` that loses the race
    on its target cell must not still write its source cell to empty and
    leave the source claimed-but-orphaned — either the whole logical move
    happens or none of it does.
  - If all cells are still current, dispatch all writes together
    (`Promise.all`, as today), then apply `setSlots` and `pushUndo` exactly
    once, as today.
- **Undo/redo go through the identical `claim`/chain/dispatch path.** An
  undo or redo call synthesizes its own `claimId` (any locally-unique token
  — the undo entry's own id is sufficient, it does not need to be a
  `gestureId`) and claims its cell(s) exactly like a forward mutation before
  writing. This closes finding 3: an undo can never race a newer forward
  write to the database, because both go through the same per-cell chain,
  in claim order.
- **No bypass for `claimId === undefined`.** Every call site — drag-driven
  and click-driven alike — always synthesizes a claim id (a drag gesture
  passes its `gestureId`; a non-drag caller generates a fresh one-off id,
  e.g. `crypto.randomUUID()`, local to that single call). There is no
  "always wins, skip the check" branch. This closes finding 4: a click write
  participates in the same per-cell ordering as everything else, so a
  late-resolving click write cannot clobber a newer drag's result — it
  either queues behind it (if it started after) or is itself superseded (if
  a drag started after it but claimed first).

### Latency

The chain only adds a wait when a *second* claim on the *same cell* arrives
before the *first* claim's write to that cell has settled — the case this
design exists to fix. In the overwhelming common case (a single drag,
touching cells nothing else is touching), `oldTail` is already resolved, so
`Promise.allSettled([oldTail])` resolves on the next microtask — no
observable delay. In the actual collision case, the second write's dispatch
is delayed by, at most, the first write's own IPC round-trip to
`better-sqlite3` over Electron IPC — the same order of magnitude as a single
`repo.writeSlotFields` call already takes today, typically low tens of
milliseconds on local SQLite, and it is delaying exactly the write that
*already* had to lose the ordering race to be correct (a write that should
never have won isn't losing anything real by finishing slightly later — it's
never applied to the screen either way). This is a materially different cost
than candidate 3 (debounce), which taxes every write regardless of
collision.

### Files/modules affected

- `src/screens/schedule/useSlotMutations.js` — the token `Map` (`cellGestureRef`)
  from the reversed design is removed in full and replaced by `cellQueueRef`
  and the claim/chain/dispatch logic above. `replaceSlot`, `expandSlot`,
  `splitSlot` are restructured so that `repo.writeSlotFields` calls happen
  *inside* the per-cell chained dispatch, not eagerly before any recency
  check. `slotsRef` (from the gesture-correlation ADR) is unchanged — it
  still supplies the fresh-read snapshot for undo-entry construction, which
  is an orthogonal concern (what value to record) from write ordering (when
  to send).
- `src/screens/schedule/dragHandlers.js` — `commit(active, hit, gestureId)`
  unchanged in shape from the reversed design (still forwards `gestureId`
  into the three mutation calls); the receiving end now treats it as a
  `claimId`, not a token-map key.
- `src/screens/schedule/useDragFSM.js` — unchanged (already forwards
  `effect.gestureId` into `commit`'s third argument per the gesture-
  correlation ADR).
- `src/screens/schedule/useUndoRedo.js` — no change to stack mechanics
  (still a dumb last-in stack); the *closures* it stores (built in
  `useSlotMutations.js`) now route their writes through the shared
  `cellQueueRef` claim/chain path.
- `src/screens/ScheduleScreen.jsx` — non-drag call sites for `splitSlot`/
  `expandSlot`/`createActivityFromCell` continue to call without a
  `gestureId`; `useSlotMutations.js` synthesizes the one-off claim id
  internally rather than requiring every caller to generate one — no
  `ScheduleScreen.jsx` call-site change needed.
- **`routeState`'s `route` and `templateId` must be readable inside
  `useSlotMutations.js` at claim time** — confirmed already present
  (`useSlotMutations.js` destructures `route`, `templateId` from
  `routeState` at the top of the hook) — this is wiring the existing values
  into the cell key, not adding new state.
- No change to `src/data/scheduleRepository.js`, `electron/main.js`,
  `electron/preload.js`, `localClient.write`, `client_write_id` generation,
  the `operations` table, or any op-log/sync/replay code — the fix reorders
  *when this tab issues* writes; it does not change what a write looks like
  once issued.

### Reused vs. new

- **Reused:** `gestureId` generation and threading from the gesture-
  correlation ADR, in full — this design still consumes it, just as a
  `claimId` rather than a token-map key.
- **Reused:** the existing `group_id`/`day_id`/`time_block_id` cell-
  addressing predicate, extended (not replaced) with `route`/`templateId`.
- **Reused:** `slotsRef`'s fresh-read snapshot mechanism for undo-entry
  value capture — unrelated to write ordering, untouched.
- **New:** `cellQueueRef` and its claim/chain/dispatch control flow. This
  replaces, rather than adds to, the reversed design's `cellGestureRef`
  token map — there is no dual mechanism to keep in sync.
- **New:** the canonical-sort-then-claim-all-atomically step for multi-cell
  operations. Nothing in the codebase previously coordinated a claim across
  more than one cell as a unit.

### Non-goals (unchanged from the reversed design)

- `placeActivityManual` remains out of scope — it only ever writes an empty
  cell (`dragHandlers.js` routes occupied-target drops to `replaceSlot`
  instead), so the "two writes race to decide a cell's final value"
  scenario cannot occur on its own writes today.
- `dismissFlag`, `lockActivity`, `releaseCell`, `addOverlay`,
  `removeOverlay`, `updateOverlayRange`, `createActivityFromCell`'s own
  activity-creation write remain untouched — none are reachable from a
  same-cell drag/click race on `template_slots`.
- No change to the op-log write shape, `client_write_id`, or the
  `window.shoresh.write` IPC surface (hard constraint, preserved — see
  "Reused vs. new" and "Files/modules affected").
- No change to seeded engine determinism (`buildSchedule.js` untouched).
- No change to two-routes semantics beyond what finding 2 requires — routes
  and their `UNFILLABLE`/`OVERLAP` flag computation stay independent; this
  design's route/templateId key addition is what *guarantees* that
  independence at the write-ordering layer instead of merely assuming it.
- No change to `scheduleGrid.css` — this is state/data-flow only.

## Test seam plan

At the `useSlotMutations` hook-test boundary (`useSlotMutations.test.js`),
extending the existing suite. Critically, **these assert persistence-layer
call order and count on the mocked `repo`, not just the resulting `slots`
state** — the reversed design's tests only asserted `setSlots` outcomes,
which is exactly the gap finding 1 exposed.

1. **Facet-1 repro, now asserted at the write call, not just the read.** Two
   `replaceSlot` calls on the same target cell, different claim ids (`g1`
   then `g2`), with `g1` issued first but with an artificially slow mocked
   `repo.writeSlotFields` for `g1`'s call and a fast one for `g2`'s. Assert:
   `repo.writeSlotFields` for the target cell is called **exactly once**, and
   with `g2`'s payload — `g1`'s write must never be dispatched at all once
   `g2` has claimed the cell first (this is the direct fix for finding 1: the
   old test asserted final `slots`; this one asserts the mock was never
   called with `g1`'s stale value, proving the database can't diverge).
2. **In-order (non-colliding) calls are a no-op change vs. current
   single-gesture behavior.** A single `replaceSlot` call with no contention
   dispatches its write immediately (chain resolves same-tick) and produces
   identical timing/behavior to pre-fix code — proves the fix costs nothing
   in the common case.
3. **Route dimension test (finding 2).** Two `replaceSlot` calls with
   identical `(groupId, dayId, blockId)` but different `(route, templateId)`
   — e.g. one on `route: 'manual'`, one on `route: 'generated'` — fired
   concurrently. Assert **both** dispatch their writes independently (two
   separate `repo.writeSlotFields` calls, neither claim-dropped) and both
   produce their own `setSlots`/`pushUndo` — proves route/templateId is
   actually part of cell identity, not merely documented as such.
4. **Multi-cell atomicity (source+target).** `replaceSlot(g1)` claims cells A
   (target) and B (source); before its chain settles, `replaceSlot(g2)`
   claims cell A only (different source, or a direct-to-A move). Assert: g1
   dispatches **no** write to either A or B (whole operation aborts, not just
   A's half), `setSlots` is not called for g1, `pushUndo` is not called for
   g1 — proves a superseded multi-cell operation cannot half-apply.
5. **`expandSlot`/`splitSlot` head+tail atomicity**, same shape as (4),
   applied to their two-cell claim.
6. **Undo/redo through the same chain (finding 3).** Construct an undo entry
   from `g1`, then have a forward `replaceSlot(g2)` claim and dispatch its
   write to the same cell before the undo runs. Run `undo()` for `g1`.
   Assert `repo.writeSlotFields` is called with `g2`'s value still the last
   word for that cell — i.e. the undo either queues correctly behind `g2` and
   is then itself checked for currency (if `g2` still holds the claim when
   undo's turn comes, undo's write is dropped, matching "undo of a
   superseded action is a no-op"), never dispatched out of order.
7. **No blanket bypass for a missing gesture id (finding 4).** A non-drag
   `splitSlot` call (no `gestureId` argument) and a same-cell drag
   `replaceSlot(g1)` race, with the non-drag call's synthesized claim
   arriving *after* `g1`'s. Assert `g1`'s write is dropped and the non-drag
   call's write wins — proving the non-drag path participates in the same
   ordering, not a `gestureId === undefined` exemption.
8. **Canonical claim ordering avoids deadlock.** Two multi-cell operations
   whose cell sets overlap in opposite order (op A: cells [X, Y]; op B: cells
   [Y, X]) both resolve without hanging — a direct regression test for the
   "sort cell keys before claiming" rule.

All tests run in the existing Vitest + mocked-`repo` harness, with hand-
controlled promise resolution (spies on `repo.writeSlotFields` recording
call order and arguments) — no Electron, no real SQLite, no
timing-dependent `setTimeout`/`sleep`.

**Follow-up requirement, unchanged in kind but now doubly warranted:** the
rebuilt mechanism (`cellQueueRef`, the claim/chain/dispatch logic, the
canonical multi-cell claim ordering) requires its own Red Hat pass once
implemented, before this ticket is considered closed. The prior mechanism
also passed its own test seam plan and was still wrong at the persistence
layer — the test seam plan above is evidence for that pass to start from,
not a substitute for it. Red Hat should specifically probe: (a) whether the
claim/chain step is truly synchronous and race-free within a single JS task
(no `await` between claim and chain-build), (b) whether canonical sort order
is applied identically at every multi-cell call site, and (c) whether a
component unmount mid-chain (route switch, screen navigation) can leave a
dangling claim that blocks a future cell forever.

## Consequences

- `replaceSlot`, `expandSlot`, `splitSlot` are restructured so their
  `repo.writeSlotFields` calls happen inside a per-cell chained dispatch
  rather than being issued eagerly. This is a real control-flow change to
  these three handlers, not an additive parameter as the reversed design
  was — Maker should treat this as a rewrite of their write-issuance path,
  not a patch.
- `dragHandlers.js`'s `commit` signature is unchanged from the reversed
  design (still forwards a third `gestureId`/`claimId` argument).
- A new per-hook-instance `cellQueueRef` (in-memory only, never persisted,
  never synced) replaces the reversed design's `cellGestureRef`. Same
  route-switch/remount consideration applies: confirm during implementation
  whether `useSlotMutations` remounts on route switch (fresh `useRef` clears
  it for free) or persists (add an explicit `.clear()` to the screen's
  transient-reset block if so) — and additionally confirm no cell is left
  with a claim whose chain never resolves if the component unmounts mid-
  chain (see Red Hat probe (c) above).
- Writes to a colliding cell are delayed by, at most, one IPC round-trip;
  superseded writes are silently never sent (no error surfaced — a newer,
  valid action superseded an older one, which is not a failure state).
- No change to stored/synced data shape, the op-log, `client_write_id`,
  `write` IPC surface, sync/replay, migrations, engine determinism, or the
  Manual/Generated route split — route/templateId is now part of the *cell
  identity used for local ordering decisions*, not part of any persisted or
  synced shape.
- `placeActivityManual` remains unguarded by this mechanism (see Non-goals)
  — unchanged from the reversed design's scope decision, and still correct
  for the same reason (it never overwrites an occupied cell today).
- The token-only implementation (`4a1cf09`, `1be819a`) is superseded in full
  by this design and will be discarded by Maker, not built upon.
