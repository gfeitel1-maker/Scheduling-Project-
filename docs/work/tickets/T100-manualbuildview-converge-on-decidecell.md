---
title: T100-manualbuildview-converge-on-decidecell
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
archive_when: ManualBuildView derives its per-cell skip/rowSpan/celltype from the canonical decideCell (gridGeometry.js) like ScheduleGroupView/ScheduleDayView, with a test, OR a documented decision records why it must stay separate
---

# T100 — Converge ManualBuildView onto canonical decideCell (pre-existing duplication)

**Surfaced by Code Reviewer during the T99 review (2026-08-20).** Pre-existing; not introduced by T99.

## What it is

`ScheduleGroupView`/`ScheduleDayView` compute each cell's skip/rowSpan/celltype via the canonical
`decideCell` (`src/screens/schedule/gridGeometry.js`). `ManualBuildView.jsx` instead reimplements the
equivalent branching INLINE — calling `isActivityTail`/`getActivityRowSpan`/`isAnchorTail`/
`getAnchorRowSpan` directly. The skip conditions are currently logically equivalent to `decideCell`
(that's why T99's fix is correct), but the logic is duplicated, not shared.

## Why it matters

T99 exists precisely because ManualBuildView diverged from the shared views (it rendered tails the
shared views skip). Fixing it by matching the inline logic re-establishes agreement but leaves the
duplication: a future change to `decideCell` (UNFILLABLE/`cellType`, overlays, a new tail kind) can
silently re-diverge ManualBuildView — the same class of bug T99 closed.

## Definition of done

- ManualBuildView's per-cell render decision derives from `decideCell` (or a shared helper it and the
  other views both call), so a change to the canonical logic can't silently skip ManualBuildView.
- A test asserts ManualBuildView and the shared views agree on the same merged-span / anchor-span /
  tail fixture.
- No visual regression to the manual grid.

## Related

- T99 (skip-render span tails) — matched the inline logic; this ticket removes the duplication behind it.
- T91 (span-aware replaceSlot) — the drag-onto-own-tail race that ManualBuildView's divergence enabled.
