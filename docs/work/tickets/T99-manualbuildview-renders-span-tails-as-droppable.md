---
title: T99-manualbuildview-renders-span-tails-as-droppable
document_type: ticket
status: completed
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
archive_when: ManualBuildView skip-renders span tails (or otherwise makes a tail cell a non-independent drop target), matching the shared grid views, and a test pins it
---

# T99 — ManualBuildView renders span tails as independently droppable (pre-existing)

**Surfaced by Red Hat during the T91 review (2026-08-20), pre-existing — NOT introduced by T91.**
Recorded as a follow-up; T91 was scoped to not fix it.

## What it is

The shared grid views (`ScheduleGroupView`/`ScheduleDayView`) use `decideCell` (`gridGeometry.js`),
which `skip`-renders any block that `isActivityTail` — so a span's tail blocks are covered by the
head's `grid-row: span N` and are never independent drop targets. `ManualBuildView.jsx` does **not**
use `decideCell`; it renders every occupied block (head or tail) as its own `SlotCell` with
`rowSpan={1}` and `isDndEnabled={true}`. So on the Manual route Group view a span **tail** is
independently draggable and droppable.

## Why it matters

- **Drop-onto-tail leaves an orphan.** `replaceSlot`'s target write is `{ activity_id, flags: {} }`
  and never resets `is_span_head`. Dropping an activity onto a tail cell (only reachable in
  ManualBuildView) leaves that cell `is_span_head:false` with no head — the same half-span "blob"
  state T91 fixes elsewhere. This predates T91 and is not covered by it.
- It was also the enabler for the T91-delta write-race (head dragged onto its own tail): the race
  itself was fixed in T91 (exclude-primary + dedupe), but the underlying reason a tail is a distinct
  drop target at all lives here.

## Likely fix (verify against current code first)

Make ManualBuildView skip-render span tails the way the shared views do (reuse `decideCell` / the
`isActivityTail` rule, or render the head with a real row span and drop the independent tail cells),
so a tail is never an independent drag/drop target. Alternatively, if independent tail cells are
wanted, `replaceSlot`'s target write must reset `is_span_head: true` (a broader change — it alters
the long-stable target write shape and its many characterization tests, so it needs its own review).

## Definition of done

- A span tail on the Manual route Group view is not an independent drop target (or dropping onto one
  produces a clean single head, `is_span_head:true`, not an orphan).
- A test pins the chosen behavior.

## Related

- T91 (span-aware replaceSlot) — fixed the orphan on *replace of a head* and the delta write-race;
  this ticket is the remaining ManualBuildView-specific rendering inconsistency behind them.

## Resolution (2026-08-20, SHIPPED — Code Reviewer merge-ready, full gate green)

ManualBuildView now skip-renders merged ACTIVITY span tails (`isActivityTail`) and gives the head
`getActivityRowSpan(...)`, reusing the exact `gridGeometry.js` machinery `ScheduleGroupView`/
`ScheduleDayView` use — a span tail is no longer an independent drop target, so drop-onto-tail can't
orphan. `rowSpan` threaded through `SlotCell`, `blockNames`, and `placeCell`. Merge/split unchanged.
Real-data safety confirmed: `normalizeSlots.js` coerces `is_span_head` to a boolean before slots reach
`gridGeometry`, and all three views share one `geometry` prop (the mock-string caveat is mock-only).
Test-first (head spans N rows, tail cell absent); verified live. Full `npm run verify` green (214 files,
25/25). Follow-up **T100** filed to converge ManualBuildView onto canonical `decideCell`. Pending sign-off.
