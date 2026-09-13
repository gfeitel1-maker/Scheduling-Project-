---
title: T100-manualbuildview-converge-on-decidecell
document_type: ticket
status: closed
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
archive_when: ManualBuildView derives its per-cell skip/rowSpan/celltype from the canonical decideCell (gridGeometry.js) like ScheduleGroupView/ScheduleDayView, with a test, OR a documented decision records why it must stay separate
---

# T100 — Converge ManualBuildView onto canonical decideCell (pre-existing duplication)

## CLOSED 2026-09-13 — measured, no divergence, not worth doing

Closed under this ticket's own second `archive_when` clause: *"OR a documented
decision records why it must stay separate."* This is that decision.

**The duplication is real.** `ManualBuildView.jsx` does compute per-cell
skip/rowSpan/celltype inline rather than calling `decideCell`
(`src/screens/schedule/gridGeometry.js`). That part of the ticket was accurate.

**The consequence is not.** Measured 2026-09-13 against a live camp on the dev
server: a recurring event spanning two time blocks (the case most likely to
break, since ManualBuildView's inline logic checks `isActivityTail` but appears
not to check `isAnchorTail`) renders as **one** cell with
`gridRow: 1 / span 2`. Verified in the DOM, not just visually — exactly one
`.cell` node contains the anchor's name, so nothing is hidden underneath.

### The wrong turn, recorded because it is the useful part

An earlier probe claimed three divergences. All three were false:

| claimed | actual |
|---|---|
| anchor tail renders twice | renders once, span 2 — measured in the DOM |
| UNFILLABLE renders differently | **correct by design** — CLAUDE.md: *"per-slot flags differ by route — UNFILLABLE on generated only"*. A cell the engine failed to fill and a cell not yet filled are different states. |
| "tail with no activity_id" diverges | an invented state, never checked for reachability |

The probe hand-transcribed ManualBuildView's inline logic into a test and
compared *that* against `decideCell`. So it measured the transcription, not the
code — the real render path has a guard the transcription missed. A textbook
case of a measurement answering a question adjacent to the one being asked.
Running the app settled it in ten minutes; the probe had produced a confident,
well-formatted, wrong table.

### Why not converge anyway

It is housekeeping with no defect behind it, and the convergence is not free:
`decideCell` returns a `kind` the manual route would have to re-branch on,
trading inline duplication for an indirection that must then be kept in step
with the manual route's own DnD/eligibility concerns. Reopen this if the two
ever actually drift — that is a real signal. "They might drift" is not.

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
