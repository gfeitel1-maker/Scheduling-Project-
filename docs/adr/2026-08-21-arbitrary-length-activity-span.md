---
title: "Arbitrary-length activity spans: adopt the is_span_head chain as the sole stored shape, retire flags.expanded's from_block pointer"
document_type: adr
authority: normative
status: proposed
date: 2026-08-21
supersedes: []
implementation_state: not started
affects:
  - docs/work/specs/2026-08-21-arbitrary-length-span.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
---

# Arbitrary-length activity spans: adopt the is_span_head chain as the sole stored shape, retire flags.expanded's from_block pointer

Resolves the owner's confirmed scope in
[`docs/work/specs/2026-08-21-arbitrary-length-span.md`](../work/specs/2026-08-21-arbitrary-length-span.md):
one activity spanning N consecutive periods, drag-to-extend to any N, may cross
day-part boundaries, on both the manual and generated routes.

---

## Candidate approaches considered

Generated via divergent ideation across four frames (regulator/compliance,
adversarial/competitor, inversion, 3am-on-call) before converging. Full pool
condensed to the underlying angles:

1. **Keep `flags.expanded` but grow its `from_block` into a list of N tail
   pointers on the head.** `[N3 V5 F7]` — rejected: this is exactly the
   "obvious answer" the divergence banned, and it does not fix the actual
   defect. It still makes the head the single owner of tail-shape knowledge,
   which every adversarial branch (competitor frame's race scenarios, the
   3am frame's "1-of-3 tails released" bug) independently converged on as
   the real fragility. A list is also a second, parallel representation of
   exactly what the engine's `is_span_head` chain already expresses for free.
2. **★ Adopt the `is_span_head` chain the engine already emits as the sole
   representation on both routes; delete `flags.expanded.from_block`.**
   `[N6 V9 F9]` — the non-obvious-but-viable pick. Membership is read by
   contiguity + shared `activity_id` + `is_span_head:false`, which
   `collectSpanTails()` in `useSlotMutations.js` **already implements and
   already generalizes to arbitrary N** (built for T91, currently unused by
   `expandSlot`/`splitSlot`, which alone are hardcoded to N=2). No new
   column, no new table, no parallel format between routes.
3. **New `span_id` + `span_index`/`span_length` columns, no head/tail
   asymmetry at all (regulator + 3am frames).** `[N8 V4 F5]` — genuinely the
   most robust representation (self-verifying row count, no pointer to go
   stale), but it is a new persisted shape requiring a migration, a
   projection change, and a rewrite of every span-reading call site
   (engine, `collectSpanTails`, findings, UNFILLABLE derivation) for a
   defect that candidate 2 fixes with zero schema change. Flagged as a trap
   for *this* task, not a bad idea in general — see Open questions.
4. **Interval row per span (`start_block`/`end_block`), no tail rows persisted
   at all; derive per-cell rendering at read time (inversion frame).**
   `[N7 V3 F4]` — trap: `template_slots` is the field-level sync unit
   (per-slot op-log rows, per-cell WRITE QUEUE keying). Collapsing N rows
   into one interval row would break per-cell conflict recording,
   per-cell locks/releases, and per-cell overrides (`day_overrides` is
   keyed by `(day_id, group_id, block_id)`) — a materially bigger change
   than the owner's stated scope.
5. **Append-only `span_events` mini-op-log per span, `slots` rebuilt by
   replay (3am frame).** `[N8 V3 F3]` — trap for the same reason as #4, at
   greater cost: the app already has one op-log (`operations`); a second,
   span-scoped one duplicates that machinery for a problem #2 solves without
   it.
6. **Version-fenced (optimistic-concurrency) span epoch, layered on top of
   whichever shape is chosen (competitor frame).** `[N6 V6 F6]` — not
   rejected, but reclassified: this isn't an alternative to #2, it's a
   *hardening addition* candidate #2 still needs for same-device concurrent
   gestures. Folded into the Decision below as the write-atomicity section
   rather than kept as a separate architectural fork.

**Traps identified and set aside:**
- Storing the full intended N redundantly on every row "in case a tail is
  lost" (regulator frame) — solves a problem candidate 2 doesn't have, since
  contiguity-derived length is trivially recomputed from surviving rows, and
  redundant N invites the two copies disagreeing after a partial write.
- A parent pointer (head's row id) on every tail instead of activity_id +
  contiguity (inversion frame's "coincidental adjacency" worry) — investigated
  and found to be **already handled by existing code**: an independently
  placed activity via `placeActivityManual` never sets `is_span_head:false`
  on its own row, so two back-to-back cells holding the same activity by
  coincidence do not satisfy `collectSpanTails`'s walk condition
  (`row.is_span_head !== false` breaks it). No parent pointer needed; see
  Decision §1.

---

## Approach

### 1. Stored shape: the `is_span_head` chain is the only representation, on both routes

An N-block span is N `template_slots` rows sharing one `group_id`/`day_id`
across N contiguous (per the crossing rule in §3) `time_block_id`s and one
`activity_id`:

- **Head** (first block): `activity_id = <the activity>`, `is_span_head`
  `true` or unset (existing convention — rows predating the column count as
  heads, per `buildSchedule.js:510`'s own comment).
- **Tails** (blocks 2..N): `activity_id = <same activity>`,
  `is_span_head = false`.

This is **not a new shape** — it is the shape `buildSchedule.js` already
writes for the generated route (`spanCount = act.span_blocks || 1`, looped
with no ceiling) and the shape `collectSpanTails()` already reads on the
manual route for arbitrary N (built under T91 for re-homing tails when a
head is replaced, currently invoked only from `replaceSlot`).

**`flags.expanded` is retired as a structural pointer.** Its only field that
is structural — `from_block` — is exactly the thing that cannot represent
N>2 (one scalar, one tail). The two informational fields
(`displacedActivityId`, `displacedActivityName`) are **not** structural —
they exist so the UI can tell the director "this bumped X" — and are kept,
but as a **per-tail-write** record, not a head-level pointer: each tail
write, at the moment it is created, may carry the activity it displaced.
Concretely: drop `flags.expanded` entirely and instead attach
`displaced_activity_id`/`displaced_activity_name` directly on the **tail
row's own `flags`** at write time (one small object per tail, written once,
never mutated by a later, unrelated tail's write). Reading "what did this
span bump" becomes: walk the tails via `collectSpanTails`, read each tail's
own `flags.displaced`. No head-owned list, no scalar that runs out of room.

**Why this is the smallest responsible fix, not a missed opportunity to
generalize further (candidates 3-5 above).** The read side (`collectSpanTails`)
is already correct for arbitrary N and already shipped in production code
under T91. The defect is narrowly on the write side: `expandSlot` writes
exactly one tail and `splitSlot` reads exactly one `from_block`. Fixing the
write side to match the read side's existing contract is a bounded change;
inventing `span_id`/interval rows/a span-scoped op-log would duplicate a
contract that already works and is already tested (`buildSchedule.test.js`,
`useSlotMutations.test.js`).

### 2. Write semantics: N-cell writes under one gesture claim

`expandSlot`'s and `splitSlot`'s call shape changes from "one head, one tail"
to "one head, a list of tail rows to affect" — using the **identical
mechanism `replaceSlot` already uses today** for its own tail re-homing
(`collectSpanTails` → `tailRows` → `tailKeys` → `keys = [...].sort()` →
`runMutation({ keys, claimId: gestureId, ... })`). This is not new
machinery; it is applying the existing pattern to the two call sites that
don't yet use it.

**Extend** (drag-to-extend from current length M to a dragged-to length N):
1. Resolve the ordered list of blocks the drag now covers (head + N-1
   consecutive blocks, per the boundary rule in §3).
2. Diff against the span's *current* tails (via `collectSpanTails`): tails
   already owned by this head that remain covered need no write; tails newly
   covered get `{ activity_id: head's, is_span_head: false, flags: { displaced:
   {...} } }` (whatever they held before); any *former* tail no longer covered
   (a shrink-via-drag) is released to an empty fresh head (`activity_id: null,
   is_span_head: true, flags: {}`) — the same "orphan tail" cleanup
   `replaceSlot` already performs.
3. `keys = [headKey, ...allAffectedTailKeys].sort()`, one `runMutation` call,
   one `gestureId` claim covering every affected cell — **all-or-nothing**:
   if any covered cell's claim is superseded before dispatch, the entire
   extend is dropped, not partially applied (this is exactly the existing
   `claimAndRun` "multi-cell atomicity" guarantee, extended to cover however
   many cells N-1 is, not hardcoded to 1).
4. Undo/redo capture the pre-write state of every affected row (not just the
   head and one tail), mirroring `replaceSlot`'s `prevTargetActivityId`/
   `prevSourceActivityId` capture pattern.

**Split** (release a span back down, at any interior block, to two or more
independent spans): `splitSlot`'s `from_block` scalar read is replaced with
`collectSpanTails(slots, timeBlocks, target, headSlot)` to get the *actual*
current tail list, then split at the requested block: blocks before the
split point keep `activity_id`/`is_span_head` unchanged (still the head's
span, now shorter); the block at the split point and blocks after it are
released to independent empty heads (`activity_id: null, is_span_head: true,
flags: {}`) — **not** merged into a second span automatically. (A director
who wants the released blocks to become a new N-length span drags to extend
them again — this keeps split as one well-defined operation: "cut here,
everything after becomes independent cells," not "cut here and also infer a
second span.")

**Why this closes the T91-class write race, not just the 2-tail case.**
The bug T91 caught was: a replaced head's tail freed *after* the fact via a
second, ungated write, racing a legitimate concurrent write to that same
tail. Generalizing `collectSpanTails` + `keys.sort()` + one `claimId` to
cover N tails instead of 1 keeps the *shape* of that fix — "gather every
affected cell before claiming, claim them all atomically, drop the whole
op if any one is stale" — intact for any N. A hand-rolled "loop calling
`writeSlotFields` per tail independently" would silently reopen T91's exact
race at N>1, because each per-tail write would re-enter the queue on its
own claim instead of one shared claim; this must not be implemented that way.

**What `claimAndRun` does *not* cover, and what does: cross-device races.**
`cellQueueRef` is a `useRef` — local to one renderer process. It serializes
concurrent gestures *within one device's own UI* (e.g. a fast double-drag).
It provides **no** protection against two devices independently extending or
splitting the same span at the same moment; that is the op-log's job, at the
per-row, per-field level, via the existing `conflicts` table keyed by
`parent_op_id`. Two devices writing different `activity_id`/`is_span_head`
values to the *same row* already produce a recorded conflict under today's
mechanism — no new conflict-detection primitive is introduced. The
gap the divergence surfaced (competitor frame, "bidirectional extend claims
disjoint cells") is a **row-membership** gap, not a conflict-detection gap:
device A extends forward (writes blocks 6-7 as new tails of head@1) while
device B independently splits the same span at block 3 (releasing blocks
4-5). No single row's write collides, so no conflict is recorded, yet the
resulting chain is inconsistent — head@1 believes it now reaches to block 7,
but block 4 was independently released. **Mitigation: a repair-on-read pass
(§4)**, not a new locking primitive — consistent with this project's
precedent (the plural-candidate-schedules ADR's "additive repair pass" for
a structurally analogous cross-device gap) and cheaper than adding
distributed locking to a system explicitly designed not to need it.

### 3. Day-part boundary crossing

A span **may** cross a day-part boundary (confirmed scope item 3). "Consecutive"
is defined purely by `time_blocks.sort_order` within the same day: block i and
block i+1 are consecutive if `sort_order` is contiguous, regardless of which
day-part each belongs to. Nothing about day-parts is structural to the span —
`time_blocks` has no day-part boundary marker consulted by `collectSpanTails`
today, and none should be added for this feature.

What **stops** a drag (in order checked, first match wins — same order a
director would expect a boundary to "physically" stop a drag):
1. **Day end.** The drag cannot extend past the last block of the day (no
   cross-day spans — a day boundary is a hard stop, unlike a day-part
   boundary).
2. **An existing anchor slot** (`is_anchor: true`) in the drag path — anchors
   (meals, etc.) are not activities and are never absorbed into a span.
3. **A week-exclusion-derived `WEEK_CLOSED`** flag on a block in the path
   (manual-route honors week/group exclusions per the existing
   manual-route-week-exclusions work) — a closed block cannot become part of
   a span.
4. **A locked cell not owned by this drag's activity.** A block already
   holding a *different* activity, locked (`is_locked` on that activity) or
   carrying an active day-override (`is_overridden`), is not silently
   absorbed or silently displaced without going through the normal
   `overrideGuard`/replace semantics — the drag simply cannot extend past it
   (mirrors today's 2-block behavior: extending onto an occupied tail
   displaces it and records `displaced_activity_id`; extending onto an
   overridden/locked cell does not proceed past it).

Nothing about "morning" vs "afternoon" as a *label* stops or permits a drag —
day-parts are a rendering/grouping concept for the grid, not a data boundary.

### 4. Repair-on-read pass (new, small)

Because tail membership is read by contiguity + shared `activity_id` +
`is_span_head:false` rather than a parent pointer, a cross-device
interleaving (§2) can in principle leave a tail row whose immediate
predecessor (same group/day, prior `sort_order` block) is neither the tail's
own head nor another tail of the same activity — an orphaned tail. Add one
small, pure function (alongside `computeFindings`, following the same
"pure function over the snake_case persisted-row shape" convention already
established for that seam) that runs on every `loadAll()`/findings
recompute: for every row with `is_span_head === false`, verify its immediate
predecessor row is either `is_span_head !== false` with the same
`activity_id` (i.e., is validly this tail's head or an earlier tail in the
same chain) — if not, the orphan tail heals to `activity_id: null,
is_span_head: true, flags: {}` via the normal write path (not silently
dropped from the read-only view; it must be corrected at the data layer so
every device converges on the same healed state, same principle as the
plural-schedules ADR's "additive repair pass, journalled, never a silent
drop"). This is the one genuinely new piece of logic this ADR introduces;
everything else in §1-3 is applying an existing, tested pattern to blockers
that only ever capped it at N=2.

### 5. Generated-route parity

The generated route needs **no change** to `buildSchedule.js` — it already
emits arbitrary-length `is_span_head` chains. What needs to change is the
generated route's **editing UI** (drag-and-drop over an engine-proposed
schedule): it must call the *same* extended `expandSlot`/`splitSlot` (routed
through `routeState`, exactly as `replaceSlot` already is route-agnostic
today) rather than a parallel implementation. `UNFILLABLE` interaction is
unchanged by this work: `UNFILLABLE` is an engine verdict about a cell the
engine could not place anything into; a span, once placed (by the engine or
by a director dragging over a generated schedule), is exactly as fillable or
unfillable as any other placed activity — nothing about spanning changes
when `UNFILLABLE` is computed or cleared.

---

## Files/modules affected

- `src/screens/schedule/useSlotMutations.js` — `expandSlot` rewritten to
  write N tails via `collectSpanTails`-derived diff, not a hardcoded pair;
  `splitSlot` rewritten to read the actual tail chain instead of
  `flags.expanded.from_block`; `flags.expanded` write path removed from both.
- `src/screens/ScheduleScreen.jsx` (~294, 1207, 1243) — no interface change
  to `onExpandSlot`/`onSplitSlot` props expected; call sites should not need
  to change beyond whatever drag-distance-to-N-blocks resolution the DnD
  layer needs to compute (see Open questions).
- `src/screens/schedule/dragHandlers.js` — extend-gesture resolution needs to
  produce "drag covers blocks [i..j]" rather than "drag covers exactly one
  adjacent block"; this is a DnD/geometry concern for Designer/Maker, not a
  storage concern, and is not specified further here.
- A new small pure function (name TBD by Maker, e.g. `repairOrphanSpanTails`)
  alongside `computeFindings` in `src/engine/buildSchedule.js` or a sibling
  module — see §4.
- `src/screens/schedule/useSlotMutations.test.js` — existing N=2 tests should
  continue to pass unchanged (N=2 is just the smallest case of the new
  general logic); new tests needed at N=3, N=4, shrink-via-drag, split at an
  interior block of N=4, and the boundary-crossing stop conditions in §3.
- No `electron/db/schema.sql` change, no migration, no `projections.js`
  change — `template_slots.is_span_head`, `activity_id`, `flags` all already
  exist and are already projected.

---

## Reused vs. new

**Reused, verbatim:**
- `is_span_head` chain shape (already written by `buildSchedule.js`, already
  read by `collectSpanTails`).
- `collectSpanTails()` itself — already generalizes to arbitrary N; this ADR
  asks Maker to make `expandSlot`/`splitSlot` call it, not to change it.
- `claimAndRun`/`runMutation`/`gestureId`-as-claim-id/`keys.sort()` write
  pattern — already proven for multi-cell atomic writes in `replaceSlot`.
- Per-cell WRITE QUEUE (`cellQueueRef`), unchanged.
- The op-log's field-level conflict recording (`conflicts` table,
  `parent_op_id`) — unchanged, still the cross-device defense.
- `overrideGuard`, week-exclusion (`WEEK_CLOSED`), anchor (`is_anchor`) checks
  — all pre-existing, reused as drag-stop conditions.

**Genuinely new:**
- The repair-on-read orphan-tail healing pass (§4) — the one gap the
  contiguity-based (parent-pointer-free) representation has under
  cross-device interleaving that the existing per-row conflict mechanism
  does not close on its own.
- Per-tail `flags.displaced` (replacing the head-owned
  `flags.expanded.displacedActivityId/Name`) — a reshaping of where
  informational (non-structural) displaced-activity data lives, not a new
  concept.

---

## ADR required: yes

Filed at `docs/adr/2026-08-21-arbitrary-length-activity-span.md`. Summary of
the decision and its consequence: the manual route's stored slot shape for a
merged/expanded activity changes from a head-owned `flags.expanded` scalar
pointer (structurally capped at 2 blocks) to the `is_span_head` chain the
generated route already uses (uncapped) — no schema or migration needed
since the columns already exist, but every manual-route write path that
creates or dissolves a span must be rewritten to the new shape, and a new
repair-on-read pass is required to heal the one cross-device inconsistency
this representation can produce. This changes a contract multiple call
sites depend on (`expandSlot`/`splitSlot`'s written shape) and makes a
consistency-model tradeoff (contiguity-derived membership over an explicit
parent pointer) that is not obviously reversible without another write-path
rewrite — both are ADR-bar triggers per the constitution.

---

## Open questions for Governor

1. **Drag-distance-to-N-blocks resolution** (which blocks a drag "covers")
   is a DnD/geometry UX decision — does the drag preview snap to whole
   blocks live during the drag, or only resolve N on drop? This is
   Designer's call, not settled here.
2. **Split-at-interior-block UX**: **DECIDED (owner, 2026-08-21): split by
   cutting at any interior cell.** Clicking any interior cell of a long span
   cuts there; the block clicked and everything after it become independent
   empty cells (the §2 data semantics), the blocks before stay the span. This
   is the Excel "un-merge from here" behavior the owner is matching.
3. **Candidate 3 (`span_id`/`span_length` columns) is explicitly not chosen
   now but may be worth reconsidering later** if the repair-on-read pass in
   §4 proves to fire often in practice (i.e., if cross-device span races turn
   out to be common rather than rare) — that would be evidence the
   contiguity-based model is paying a real ongoing cost, not a one-time
   migration cost avoided. Flagging for Governor to track, not deciding now
   ("three similar tables is better than a premature abstraction layer" —
   the abstraction should wait for evidence it's needed).
4. **Undo/redo granularity for a large extend** (N=10): **DECIDED (owner,
   2026-08-21): undo block by block.** Each block added by an extend is its
   own undo entry, so undoing an "extend 2→10" walks back 10→9→8… one block
   per undo. **Design tension the Maker must reconcile (and Red Hat must
   check):** the FORWARD extend must still be an atomic all-or-nothing
   multi-cell write under one gesture claim (§2) so a concurrent race cannot
   tear it — but the UNDO stack records per-block entries. These are not in
   conflict if implemented as: one atomic forward write that *pushes N
   separate undo frames* (each frame restoring exactly one tail block to its
   prior empty-head state), popped one at a time. The undo of a single block
   is itself a normal single-cell write through the queue. Do NOT implement
   block-by-block undo by making the forward write non-atomic (N independent
   claims) — that reopens the T91 race. Atomic forward, granular reverse.

---

## Test-first seam list for Maker

1. `collectSpanTails` already has coverage under T91 for N=1 tail; add a
   fixture with N=3, N=4 to prove it walks arbitrarily far (it should already
   pass — this is a characterization test proving the reuse claim in this
   ADR, write it *before* touching `expandSlot`).
2. `expandSlot` extend from N=2 to N=4 in one gesture: asserts all 3 tails
   written, one `claimId`, one undo entry restores all 3 to prior state.
3. `expandSlot` shrink-via-drag from N=4 to N=2: asserts the 2 dropped tails
   are released to empty fresh heads (`is_span_head: true, activity_id:
   null`), not left as stale tails.
4. `splitSlot` at an interior block of N=4: asserts blocks before the cut
   keep the head's activity/chain; blocks at and after the cut become
   independent empty heads (not merged into a second span).
5. Boundary-crossing: a drag that would cross a day boundary is capped at
   the day's last block; a drag path containing an anchor/locked/overridden/
   `WEEK_CLOSED` cell stops before it, per §3's ordered checks.
6. Multi-cell atomicity under supersession: start an N=5 extend gesture,
   have a second gesture claim one of the covered cells before the first
   dispatches — assert the first extend is fully dropped (no partial write
   to any of the 5 cells), mirroring the existing `replaceSlot` dropped-claim
   test.
7. Repair-on-read: construct a slots fixture with a tail (`is_span_head:
   false`) whose predecessor is not a valid head/prior-tail of the same
   activity; assert the repair pass heals it to an empty head and that this
   correction is itself written through the normal path (not just filtered
   in the render layer).
8. `buildSchedule.test.js` must pass unchanged — nothing in this ADR touches
   the engine.
