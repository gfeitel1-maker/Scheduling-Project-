---
title: "The overlap warning derives on both schedule routes"
document_type: ticket
status: completed
created: 2026-09-14
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T156-generated-route-validity-after-merge.md]
archive_when: an over-capacity placement is marked on the generated route as well as the manual one, and the legend documents it on both
---

# T159 — The overlap warning derives on both schedule routes

Owner decision, 2026-09-14, closing option 1 of [T156](T156-generated-route-validity-after-merge.md).

## Why the old stance stopped being true

`OVERLAP` was manual-only on a stated product stance: *"the engine refuses
clashes rather than making them."* That reasoning was sound while a clash could
only ever arrive by hand — the generated route's placements come from
`buildSchedule.js`, which will not put two groups in a place that holds one.

Under CRDT sync a clash arrives another way. Two directors, both offline, each
move a group into the same place in the same block. Neither document is invalid.
They merge cleanly. No conflict is raised, because no two people wrote the same
field — and the result is an over-capacity generated schedule that nothing
flagged. On the manual route the same merge would have been marked immediately.

The stance is still true of **generation**. It is no longer true of the
**route**. So the marker follows the state on screen rather than the way it got
there.

## What changed

- `ScheduleScreen` applies `withOverlapFlags` on both routes — the same shape
  `WEEK_CLOSED` already had, for the same reason, which is why this is four
  lines rather than a redesign.
- `overlapSlots` loses its route gate, so the rail rows, the cell dots and the
  folded-row advisory all follow.
- `legendEntriesFor` stops omitting `Overlapping` on the generated route. A mark
  on the grid must never go undocumented, and a test now pins that `Unfillable`
  is the **only** route-specific entry left.
- `computeOverlaps` itself is unchanged: it never read a route. That is the
  guarantee behind the change, and there is now a test saying so.

## What was deliberately not changed

The generated route's `UNFILLABLE` and the engine's aggregate `findings` are
still generation-time artifacts and are still not recomputed after a merge —
option 2 of T156, which has to reconcile fresh engine output against a
director's hand edits without undoing them. This ticket closes the case where
the app knew nothing; that one is about the app knowing something stale.
