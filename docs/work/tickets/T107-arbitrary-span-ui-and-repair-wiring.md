---
title: T107-arbitrary-span-ui-and-repair-wiring
document_type: ticket
status: open
created: 2026-08-21
governing_docs: [docs/adr/2026-08-21-arbitrary-length-activity-span.md]
related_adrs: [docs/adr/2026-08-21-arbitrary-length-activity-span.md]
parent_spec: [docs/work/specs/2026-08-21-arbitrary-length-span.md]
archive_when: drag-to-extend + click-any-cell-to-split are live on both routes and repairOrphanSpanTails is wired into loadAll with the R2 quiescence guard and covered by an integration test
---

# T107 — Arbitrary-length span: UI interaction layer + repair-pass wiring

Follow-up to the arbitrary-length-span write-path work (committed on this
branch: `ef47e2e`). The data model, write path, and the reported 2-block cap
are DONE and gate-green. Three items were deliberately deferred by the Maker
(rushing them risked shipping the exact bugs the ADR's Red Hat pass exists to
prevent). Each is scoped below.

## Deferred item 1 — drag-to-extend gesture (owner-chosen UX)

**Discovery that changes the premise:** there is no drag-to-extend gesture in
the app today. The merge feature is a click "merge down" button
(`ManualBuildView.jsx` / `ScheduleGroupView.jsx`). The write-path work uncapped
it, so a director can now lengthen a span by clicking merge-down repeatedly —
the core need is met, but the owner explicitly chose *drag* to set length.

Build a real drag-to-extend: grab a span's trailing edge, drag across N blocks,
drop. `expandSlot` already accepts an arbitrary-N single-call extend, so this is
a DnD/geometry + Designer task, not a write-path change. Owner open question #1
in the ADR (does the drag preview snap live to whole blocks, or resolve N on
drop?) is Designer's call. Route through Designer → Maker.

## Deferred item 2 — click-any-interior-cell to split (owner-chosen UX)

Split works at the data layer (`splitSlot(..., cutBlockId)` cuts at any block,
tested), but the grid only triggers split from the span's HEAD cell. The owner
chose "click any interior cell to cut there." Build the per-sub-block click
target inside a merged `rowSpan` cell so an interior click calls
`splitSlot` with that block id. Designer + Maker.

## Deferred item 3 — wire repairOrphanSpanTails into loadAll (R2)

The pure `repairOrphanSpanTails(slots, timeBlocks)` function is implemented and
unit-tested but NOT wired into `useScheduleData.js`'s `loadAll()`. It mitigates
the one cross-device orphan-tail race the contiguity-based representation can
produce (ADR §4 + Red Hat R2). Wiring MUST include the R2 quiescence guard:
heal only an orphan that persists across a subsequent read AND when no in-flight
local claim exists on that group/day (correlates `useScheduleData`'s load cycle
with `useSlotMutations`'s `cellQueueRef` — the reason it was deferred rather than
rushed). Heal writes through the normal path, journalled. Needs an integration
test constructing the cross-device interleaving, per ADR test seam #11.

Until wired, the function is exported + tested but unused; the cross-device
orphan risk it addresses is rare (two devices editing the same span
simultaneously during setup) and unmitigated. Ship-now vs wire-now is an owner
call recorded on the parent spec.

## Deferred item 4 — unit test the R3 undo re-read guard

Grader (2026-08-21) noted the R3 guard in `expandSlot`/`splitSlot` undo
closures (re-read the target row, no-op + notice if it was repurposed since
extend) is implemented and correct but has no dedicated unit test — it is only
exercised indirectly. Add a test that pushes an undo frame, mutates the target
row's activity_id/is_span_head out from under it, and asserts the pop no-ops
with a describeWriteFailure notice instead of clobbering. Small, do it alongside
the R2 integration test.
