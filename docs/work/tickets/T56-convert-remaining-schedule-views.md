---
title: T56-convert-remaining-schedule-views
document_type: ticket
status: open
created: 2026-08-06
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T54-group-view-css-grid-conversion.md, docs/work/tickets/T55-collapse-a-period.md]
archive_when: no HTML table remains under src/components/schedule/ and the transitional renderAs prop is deleted
---

# T56 — Convert `ScheduleDayView`, `ManualBuildView`, and `ScheduleActivityView` to CSS Grid

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §1, §3, §9,
migration Step 4. **ADR:** `docs/adr/2026-08-06-schedule-canvas-visual-layer.md` §1, §3.
**Risk:** Medium. Three views change at once and there is no automated visual-regression harness.

---

## Problem

T54 converted `ScheduleGroupView` to a CSS Grid container and proved the approach — including the
`display: contents` accessibility structure. Three views still render an HTML `<table>` with
`rowSpan`:

- `src/components/schedule/ScheduleDayView.jsx`
- `src/components/schedule/ManualBuildView.jsx`
- `src/components/schedule/ScheduleActivityView.jsx`

Until they convert, `SlotCell` and `OverlayCell` must keep a transitional `renderAs="td"` branch
(introduced in T54 precisely because those two components are shared across views and cannot flip
unilaterally). This ticket removes the last table and, with it, the scaffolding.

**The ADR's success predicate — "no `<table>`, `<tr>`, `<td>`, or `rowSpan` attribute remains in
the four schedule grid components" — is met by this ticket and no earlier one.**

## The three views are not equivalent — do not treat them uniformly

The spec's Step 4 lists them as one batch. They are structurally different and should be reviewed
as three distinct conversions:

| View | Uses `SlotCell` | Uses `decideCell` / spanning | Drag targets |
|---|---|---|---|
| `ScheduleDayView` | yes (+ `OverlayCell`) | yes — full spanning, overlays, empties | yes |
| `ManualBuildView` | yes | anchors via `getAnchorRowSpan`; simpler | yes |
| `ScheduleActivityView` | **no** | **no** — it filters `slots` and lists group names per cell | **no** |

`ScheduleActivityView` is a read-only aggregate view with **no spanning and no drag**. It renders
`<td style={cellTd}>` directly. Its conversion is nearly mechanical; if it is convenient, land it
first as the low-risk warm-up. Its columns are days and its rows are blocks, same as group view.

`ScheduleDayView`'s columns are **groups**, not days. `placeCell`'s `columnIndex` parameter is
column-semantics-agnostic by design — pass the group index. Do not add a second placement helper.

---

## Scope

**In:**

1. Convert all three views: `<table>/<thead>/<tbody>/<tr>/<td>` → one CSS Grid container per view,
   using `buildRowTracks` (T53) for `--grid-rows` and `placeCell` (T53) for every cell's
   `gridRow`/`gridColumn`. **Do not inline placement strings in any view.**
2. Apply the same ARIA structure T54 established: `role="grid"` → `role="row"` wrappers with
   `display: contents` → `role="gridcell"` children carrying `aria-rowindex`/`aria-colindex` and
   `aria-rowspan`/`aria-colspan`. If T54 took the documented fallback (no row wrappers), apply the
   fallback consistently here — do not mix.
3. **Delete the transitional `renderAs` prop and the entire `<td>` branch** from `SlotCell.jsx`
   and `OverlayCell.jsx`. Both return `<div role="gridcell">` unconditionally.
4. Delete the remaining hover `useState` in `SlotCell` (`cellHovered`, `splitHovered`) and their
   `onPointerEnter`/`onPointerLeave` handlers, now that no caller needs the `<td>` path. Hover is
   `:hover` in `scheduleGrid.css`. Hover costs zero JavaScript from here on.
5. Extend collapse (T55) to the newly converted views: `data-collapsed` on cells whose head block
   is collapsed, row headers collapsing in step, the single row-level flag dot.
6. Preserve each view's sticky row-header column and sticky day/group header row, and each view's
   existing `minWidth` behaviour on the horizontal scroll container
   (`ScheduleDayView` currently uses `minWidth: 140 + groups.length * 130`).

**Out:**

- The drag FSM cutover, per-cell `useDroppable` removal, drop indicators, drag preview — T58.
  `useDraggable`/`useDroppable` behaviour is carried across unchanged here, so that a drag
  regression in T58 is attributable to T58.
- Keyboard grid navigation and roving `tabindex` — T59.
- Retiring `cellTd` / `emptyTd` and other dead style constants — T60. Leave them exported here
  even if unused; deleting them is the cleanup ticket's job and keeps this diff readable.
- `ACTIVITY_COLORS` tokenization — T52. No colour changes meaning in this ticket, or the
  visual-parity predicate becomes untestable.
- Any change to `gridGeometry.js`, `buildSchedule.js`, the hooks, the repository layer, or IPC.
  This remains a rendering-only change.
- Column spanning (`grid-column: ... / span N`). It becomes available for free and **nothing uses
  it today. Do not build for it.** Day-view horizontal merges and T41's multi-activity periods now
  have a native expression *if* they are ever specified.

---

## Acceptance

- [ ] `grep -rn "<table\|<thead\|<tbody\|<tr\|<td\|rowSpan" src/components/schedule/` returns
      nothing
- [ ] `renderAs` does not appear in `SlotCell.jsx`, `OverlayCell.jsx`, or any caller
- [ ] No `useState` remains in `SlotCell` for hover; no `onPointerEnter`/`onPointerLeave` hover
      handlers remain
- [ ] **A placement unit test per view** asserting the exact `gridRow`/`gridColumn` for a known
      fixture — including a `rowSpan > 1` head in day view and manual-build, and the correct
      column index for `ScheduleDayView`'s **group** columns. This test exists in each view because
      a missing or wrong `grid-column` fails **silently** (cells stack in column 1)
- [ ] Zero cells with `scrollWidth > clientWidth` in each of the three views with a long activity
      name
- [ ] Collapse works in all four views: zero cells with `scrollHeight > clientHeight` collapsed,
      including the **non-merged** case (a block with different activities per column, not the
      merged `Lunch` row every mockup used)
- [ ] Visual parity per view — three before/after screenshot pairs under `npm run electron:dev`,
      attached to the closure note. **No automated visual-regression harness exists in this repo**;
      state plainly what was compared
- [ ] Every existing interaction still works in each view: drag a slot, drop from the palette,
      expand/extend drag, overlay fill, edit, release, select, multi-select, paste mode,
      manual-build anchor placement
- [ ] Accessibility tree in each converted view shows `grid → row → gridcell` (or T54's documented
      fallback, applied consistently) with correct indices
- [ ] `src/screens/schedule/gridGeometry.test.js` is untouched and green. **This is the proof the
      whole migration was rendering-only. If it needed changing, semantics changed that were not
      supposed to change — stop and escalate rather than editing the test**
- [ ] `src/screens/ScheduleScreen.test.jsx` passes (it references `SlotCell`/`OverlayCell`)
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

- **T53** — `buildRowTracks`, `placeCell`.
- **T54** — the established grid/ARIA pattern, `scheduleGrid.css`, and the `renderAs` scaffolding
  this ticket removes.
- **T55** — the collapse contract this ticket extends to three more views.

## Blocks

T58 (drag cutover), T59 (keyboard navigation), T60 (cleanup).
