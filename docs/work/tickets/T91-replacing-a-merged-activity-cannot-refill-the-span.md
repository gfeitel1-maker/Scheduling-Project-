---
title: T91-replacing-a-merged-activity-cannot-refill-the-span
document_type: ticket
status: completed
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
archive_when: the merged-cell refill path is fixed and covered by a test, or the merge/span model is redesigned
---

# T91 — After merging, replacing a merged activity from the palette cannot refill the span ("blob")

**Parked by the owner 2026-08-19 for later — not a current-sprint blocker.** Recorded now so it
isn't lost; diagnosis and fix are deferred.

## Symptom (owner report)

On the Schedule screen, once an activity has been **merged** across multiple time blocks (a
multi-block span — the "blob"), if you then **replace that merged activity by dragging a different
activity in from the palette on the left**, the span **cannot refill the blob** — the freed
multi-block region is left in a state it can't recover into a new merged occupancy.

## What this is about (orientation for whoever picks it up — verify against current code)

- A merged/spanned activity is a single activity occupying several contiguous time blocks. In the
  data model this is `template_slots` with `is_span_head` / span semantics (see `PLATFORM_STATE.md`
  §template_slots and `docs/adr/2026-08-06-schedule-canvas-visual-layer.md`).
- The palette (left) is `src/components/schedule/ActivityPalette.jsx`; drag-to-place / replace lives
  in `src/screens/ScheduleScreen.jsx` (DnD via `@dnd-kit/core`) and the placement helpers
  (`placeActivityManual` / the write-queue path — see the DnD FSM + write-serialization work).
- The bug is specifically the **replace-into-a-merged-span** path: replacing the span head with a
  palette activity appears to leave the previously-spanned blocks unable to be re-merged / refilled.

## Likely areas to investigate (not yet confirmed)

- The replace path may clear the span head but not the span-member slots (or vice versa), leaving
  orphaned/half-span state that the refill/merge logic then refuses.
- Interaction with the per-cell write queue and `is_span_head` bookkeeping.

## Definition of done (when un-parked)

- Replacing a merged activity from the palette leaves the region in a normal, re-fillable/re-mergeable
  state.
- A characterization test pins: merge N blocks → replace span head from palette → the freed blocks
  can be occupied and re-merged.

## Root cause (confirmed 2026-08-20, un-parked)

`replaceSlot` (`src/screens/schedule/useSlotMutations.js`) is **span-unaware**: it rewrites only
the target cell (`{ activity_id, flags: {} }`). Replacing a span **head** clears the head's
`flags.expanded` but never touches the covered tail(s), which stay `is_span_head:false` still
owning the old head activity. The grid's merge predicate then refuses to re-merge the orphaned
region (`hasMergeDown` requires `nextSlot?.is_span_head !== false`, `ManualBuildView.jsx`) — the
"blob" that can't refill.

There are **two span representations**, both reachable via replaceSlot:
- **Manual merge**: head carries `flags.expanded` (head + one tail); tail is `is_span_head:false`
  owning the head activity. Set by `expandSlot`.
- **Engine / generated route**: `is_span_head` chains (head `is_span_head:true`, N tails
  `is_span_head:false`, same `activity_id`, **no `flags.expanded`** — the engine's flags carry only
  UNFILLABLE, `src/engine/buildSchedule.js`).

## Ratified design decisions (owner, 2026-08-20)

1. **Freed-tail-to-empty semantics.** Replacing a span head frees each covered tail to an *empty,
   fresh span head* (`{ activity_id: null, is_span_head: true, flags: {} }`) — mirroring
   `splitSlot`'s freed-tail behaviour — not restoring the originally-displaced activity. Rationale:
   replace is an intentional overwrite; the predictable result is a single-block activity in the head
   cell with the tail region freed and re-fillable/re-mergeable.
2. **Cover BOTH routes in this ticket** (owner folded the generated-route case in). Detect tails by a
   single unified walk: contiguous following blocks (by time-block sort_order, same group+day) that
   are `is_span_head:false` and own the head's activity. This covers the manual `flags.expanded` case
   and the engine `is_span_head` chain identically.

## Definition of done (updated)

- Replacing a span head (manual OR generated route) releases every covered tail to an empty fresh
  span head; the region is re-fillable/re-mergeable.
- Tail releases are threaded through the write-claim keys (per-cell write queue), optimistic state,
  undo, and redo — undo restores each tail to its captured prior state.
- Characterization tests pin: manual 2-block blob replace; generated ≥3-block chain replace; an
  ordinary single cell whose neighbour is a *different* activity is not touched (no false span);
  undo/redo round-trip.
- **Both ends of a move** (owner, 2026-08-20, after review): a grid-to-grid drag whose SOURCE is a
  span head must free the source's covered tails too, not just the drop target's — same orphan
  mechanism on the other end of a move. Mirror the target-side threading (claim keys, optimistic
  state, undo, redo) for `sourceTailRows`.
- **Op-log/replay seam** (Red Hat gate): a multi-tail release is multiple field-level ops with no
  transaction — consistent with the file's existing `Promise.all` target+source pattern. Accepted
  documented residual: a partial write can leave a chain mid-released until the next resync replays
  the ops (self-healing); undo is LIFO so a freed-then-refilled tail is always reversed in order (no
  stale-snapshot clobber). Recorded here rather than hardened, to stay consistent with the file's
  atomicity model.

## Resolution (2026-08-20, Grader PASS 5.0)

Fixed across `62d89a0` (target-side span-tail release), `566d290` (source-side / both-ends-of-a-move
extension), `ea88959` (drag-onto-own-tail write-race fix — a HIGH regression Red Hat caught that the
green full suite did not), `28cc5ed` (governance). `collectSpanTails` walks contiguous
`is_span_head:false` tails owning the head activity (covers manual `flags.expanded` and engine
`is_span_head` chains identically); each covered tail is freed to an empty fresh span head, threaded
through a deduped, primary-excluded claim/write set, optimistic state, undo, and redo. Full
`npm run verify` green (213 files, 3303 tests, 25/25 integration); Red Hat Resilience 5, Code Reviewer
merge-ready, Grader DONE 5.0. Accepted residual: multi-tail release is non-transactional, consistent
with the file's existing `Promise.all` model, self-heals on resync. Follow-up **T99** filed for the
pre-existing ManualBuildView tail-droppable inconsistency.

## Related

- T92 (manual merge discoverability) — re-scoped from "can't merge yet" (stale: manual merge/split
  has existed since 2026-07-27, commit `869e5ec`) to a UI/UX affordance task.
- T99 (ManualBuildView renders span tails as droppable) — the pre-existing renderer inconsistency
  behind the drag-onto-own-tail case, scoped out of this ticket.
