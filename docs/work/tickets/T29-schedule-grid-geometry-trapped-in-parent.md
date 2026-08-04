---
title: T29-schedule-grid-geometry-trapped-in-parent
document_type: ticket
status: completed
created: 2026-08-01
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_tickets: [docs/work/tickets/T28-schedule-screen-has-no-persistence-seam.md]
related_runs: [docs/work/runs/2026-08-01-t29-schedule-grid-geometry-run.md]
resolved_by: [src/screens/schedule/gridGeometry.js]
archive_when: resolved
---

# T29 — Grid-decision logic is trapped in ScheduleScreen and threaded into the views as ~29 props

**Risk:** Low to ship (behaviour-preserving), but the status quo forces every grid view to depend on
the parent for all logic and duplicates cell-decision rendering three times.
**Found:** 2026-08-01 sprawl assessment. **Depends on:** T28 landing first (spec order).
Step 2 of [the decoupling program](../specs/2026-08-01-schedule-screen-decoupling-design.md).

## What is wrong

The grid readers — `getSlot`, `overlayForCell`, `isOverlayHead`, `getOverlayRowSpan`, `isAnchorTail`,
`getAnchorRowSpan`, `isActivityTail`, `getActivityRowSpan` — are defined in `ScheduleScreen.jsx` and
passed down as function props. Measured: `ScheduleGroupView` takes **~29 props (18 functions)**,
`ScheduleDayView` **~24 (15 functions)**, `ManualBuildView` **16**. The cell-decision / rowspan-tail
rendering is copy-pasted across all three views (assessment: "the same `DroppableEmptyCell` +
rowspan-tail logic three times").

## Why it matters

- A view needing 29 props, 18 of them callbacks, is not decoupled — it is a shell the parent still
  drives. The logic cannot be tested without the parent.
- Three copies of the cell-decision logic drift independently, the same failure mode as T28's
  row-mappers.

## Scope

**In:** extract the grid readers into a pure module (e.g. `src/screens/schedule/gridGeometry.js`)
taking plain data (`slots`, `overlays`, `anchors`, `timeBlocks`, `activities`) and returning
geometry; have the views compute geometry via the module instead of receiving function props;
consolidate the duplicated cell-decision rendering. Shrink the three view prop lists accordingly.

**Out:** persistence (T28), feature-cluster state (T30), route-state (T31); the pure engine; the
already-clean leaf components; any visual change.

**Boundaries:** pure functions only, no IPC, engine untouched (§8), inline styling kept (§7),
behaviour-preserving.

## Completion evidence

1. `gridGeometry` (or equivalent) is a pure module with direct unit tests over DB-shaped slot rows,
   including the merged-span / anchor-tail / overlay-head cases.
2. `ScheduleGroupView`/`ScheduleDayView`/`ManualBuildView` prop counts are materially reduced and no
   longer receive the eight geometry functions as props.
3. The cell-decision rendering exists once, not three times.
4. Every existing `ScheduleScreen.test.jsx` case passes unchanged; full `npm run test` green.
5. `npm run check:governance`, `npm run lint`, `npm run build` pass. No engine/IPC/entity change.
