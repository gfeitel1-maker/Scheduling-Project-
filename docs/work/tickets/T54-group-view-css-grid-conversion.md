---
title: T54-group-view-css-grid-conversion
document_type: ticket
status: closed
created: 2026-08-06
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T53-grid-track-and-placement-modules.md, docs/work/tickets/T50-schedule-canvas-rebuild.md]
archive_when: ScheduleGroupView renders from a CSS Grid container with a verified grid/row/gridcell accessibility tree, and the other three views still render correctly
---

# T54 — Convert `ScheduleGroupView` to CSS Grid, add the scoped stylesheet, verify `display: contents`

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §1, §3, §6, §7, §8,
migration Step 2. **ADR:** `docs/adr/2026-08-06-schedule-canvas-visual-layer.md`.
**Risk:** Medium. This is the first visible change of the migration and the ticket that proves or
disproves the accessibility approach the rest of T50 assumes.

---

## Problem

All four schedule views render an HTML `<table>` and express multi-block activities, anchors, and
overlays with the `rowSpan` attribute. The approved ADR retires that: each view becomes one CSS
Grid container whose children are placed with explicit `grid-row: <n> / span <rowSpan>` and
`grid-column: <n> / span <colSpan>`.

`ScheduleGroupView` converts first. It is the simplest of the four (one group × days × blocks) and
it still exercises every mechanism the migration depends on: spanning slots, anchors, overlays,
and empty cells.

Three things must land together in this ticket, and the reason they cannot be separated is
mechanical:

- **The stylesheet cannot ship alone.** `src/components/schedule/scheduleGrid.css` targets classes
  that do not exist anywhere in the codebase today (verified 2026-08-06: **zero `className`
  attributes exist under `src/components/schedule/`**). A stylesheet with no consumer is dead code
  and cannot be reviewed against anything.
- **The `display: contents` verification gate cannot ship alone.** There is nothing to inspect
  until a real view renders the `grid → row → gridcell` structure.
- **`SlotCell` and `OverlayCell` are shared.** See the blocking constraint below.

## Blocking constraint the spec does not address — shared cell components

The spec's Step 2 says "convert ONE view" and Step 4 says "convert the remaining three." **As
written that is not shippable.** `SlotCell.jsx` is imported by `ScheduleGroupView`,
`ScheduleDayView`, and `ManualBuildView`; `OverlayCell.jsx` by `ScheduleGroupView` and
`ScheduleDayView`. Both currently return a `<td>`. The moment they return
`<div role="gridcell">`, the two views still rendering a `<table>` contain a `<div>` inside a
`<tr>`, which browsers hoist out of the table — visibly broken, immediately.

**Required resolution (do this, do not invent another):** give `SlotCell` and `OverlayCell` a
transitional `renderAs` prop, `'td' | 'gridcell'`, **defaulting to `'td'`**. `ScheduleGroupView`
passes `'gridcell'`; every other caller is untouched and keeps rendering `<td>`. The prop and its
`<td>` branch are **deleted in T56**, when the last table-based caller goes away. It is scaffolding
with a named demolition date, not a permanent API.

---

## Scope

**In:**

1. **`src/components/schedule/scheduleGrid.css`** — new, and the *only* stylesheet this migration
   adds. §6 of the spec was approved by the product owner on 2026-08-06 with an explicitly narrow
   boundary. It owns:
   - the grid container rules (`display: grid`, `grid-template-columns`, `gap`), reading
     `grid-template-rows` from `var(--grid-rows)`;
   - cell **interaction pseudo-states**: `:hover`, `:focus-visible`, `:active`;
   - cell **data-attribute states**: `[data-collapsed]`, `[data-drag-over]`, `[data-selected]`,
     `[data-drop-edge="top|bottom"]`, `[data-flagged]`, `[data-empty]`;
   - static structural cell styling: padding, radius, border, name/flag/dot layout.

   **What stays inline, unchanged:** per-cell computed geometry (`gridRow`, `gridColumn` — these
   are data, not style), per-cell data-derived colours (activity colour, flag colour), and
   `src/styles/shared.js`. **Nothing outside `src/components/schedule/` changes.** This relaxation
   does not generalise; do not convert anything else to CSS.

   This ticket also introduces the class vocabulary the spec's CSS assumes and the codebase does
   not yet have: `.schedule-grid`, `.cell`, `.cell-name`, `.row-header`, `.block-name`,
   `.block-time`, `.identity-dot`, `.flag`, `.expand-handle`. Name them here; T55 and T56 consume
   them.

2. **`ScheduleGroupView.jsx`** — `<table>/<thead>/<tbody>/<tr>/<td>` → one grid container. Use
   `buildRowTracks` and `placeCell` from T53. Do **not** compute placement strings inline.

3. **`SlotCell.jsx` / `OverlayCell.jsx`** — add the transitional `renderAs` prop above. In the
   `'gridcell'` branch, render `<div role="gridcell" style={{ gridRow, gridColumn }}>`, carry
   `aria-rowspan`/`aria-colspan`, and carry `data-cell-key` (T58's pointer→cell resolution will
   need it; adding the attribute now costs nothing).

4. **Delete `SlotCell`'s hover `useState`.** `cellHovered` and `splitHovered` (with their
   `onPointerEnter`/`onPointerLeave` handlers) become `:hover` rules in the stylesheet. This is
   the concrete payoff of §6 and it is in scope here, in the `'gridcell'` branch. Leave the `'td'`
   branch's behaviour alone until T56 deletes it.

5. **ARIA structure (§8):**
   ```jsx
   <div role="grid" className="schedule-grid" style={{ '--grid-rows': tracks }}>
     <div role="row" style={{ display: 'contents' }} aria-rowindex={n}>
       <div role="gridcell" aria-colindex={c} aria-rowspan={rowSpan} style={{ gridRow, gridColumn }}>
   ```
   `display: contents` removes the box so children become direct grid items, while the wrapper
   keeps `role="row"` in the accessibility tree.

6. **Empty cells show a faint placeholder** (product owner decision, §7): `data-empty` cells render
   a dashed border and a dimmed label. Not invisible.

7. **Preserve the sticky row-header column and sticky day-header row.** Today these are
   `position: sticky; left: 0` / `top: 0` on `<td>`/`<th>`. Sticky works on grid items, but the
   horizontal-scroll container and the current `minWidth: 500` must be re-established
   deliberately, not assumed.

**Out (explicitly):**

- `ScheduleDayView`, `ScheduleActivityView`, `ManualBuildView` — T56. They must keep working.
- **Collapse** — T55. This ticket may pass `collapsedBlockIds: []` to `buildRowTracks`.
- **The drag FSM, per-cell `useDroppable` removal, drop indicators, drag preview** — T57/T58.
  `useDraggable`/`useDroppable` stay exactly as they are here. Changing rendering and drag at once
  makes a regression unattributable.
- **Keyboard grid navigation and roving `tabindex`** — T59.
- **`ACTIVITY_COLORS` tokenization** — T52. Do not change what any colour *means*; if a colour
  changes, the visual-parity predicate below becomes untestable.
- **Any change to `gridGeometry.js`.** `decideCell`'s four-way return is already the exact shape
  CSS Grid needs. `{ kind: 'skip' } → return null` needs **no change at all** — grid children are
  placed, not flowed, so the browser natively honours the suppression that AG Grid and MUI X built
  by hand.
- Virtualization, canvas, fog-of-row dimming, retheming.

---

## Acceptance

- [ ] `ScheduleGroupView` renders no `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<td>`, or `rowSpan`
      attribute
- [ ] **Accessibility gate — this is the ADR's one unverified assumption and it is a predicate,
      not a footnote.** Open Chromium DevTools → *Accessibility* pane against the running Electron
      app and confirm the rendered tree is `grid → row → gridcell` with correct `aria-rowindex`
      and `aria-colindex`, and that no element is dropped from the a11y tree.
      `display: contents` had documented a11y-tree bugs fixed in Chromium ~89 and this app ships
      Electron 43 (Chromium ~14x), so it is expected to pass — but it is **treated as unverified**
      until this observation is recorded in the ticket's closure note.
      **Documented fallback, to be taken only on evidence of failure:** drop the row wrappers and
      put `aria-rowindex`/`aria-colindex` on every cell with no row elements. That is technically
      non-conforming ARIA ownership but is announced correctly by current screen readers. If the
      fallback is taken, say so in the closure note and amend the ADR §7.
- [ ] Zero cells with `scrollWidth > clientWidth` in group view with a long activity name. This is
      the property `minmax(floor, auto)` buys and the property that disqualified absolute
      positioning (which clipped 3 cells in the same mockup)
- [ ] Every cell carries an explicit `grid-column` sourced from `placeCell`. A unit test asserts
      the placement string for a known group-view fixture, including a `rowSpan > 1` head and the
      cell immediately to its right. **This test exists because the failure is silent** — a
      missing `grid-column` stacks cells in column 1 without throwing
- [ ] A multi-block activity, anchor, and overlay each occupy **one** DOM element spanning the
      correct tracks, with no elements rendered for the blocks they cover
- [ ] Empty cells are visible as faint dashed placeholders
- [ ] Visual parity with the pre-change group view. **No visual-regression harness exists in this
      repo** (vitest only, verified 2026-08-06), so this is a before/after screenshot pair
      attached to the closure note, taken under `npm run electron:dev` — not an automated gate.
      Say plainly in the closure note what was compared
- [ ] All existing group-view interactions still work: drag a slot, drop from the palette,
      expand/extend drag, overlay fill, edit, release, select, multi-select, paste mode
- [ ] `ScheduleDayView`, `ScheduleActivityView`, and `ManualBuildView` render and behave exactly as
      before — they are still tables, and `SlotCell`/`OverlayCell` still default to `renderAs="td"`
- [ ] `src/screens/schedule/gridGeometry.test.js` is untouched and green
- [ ] Only one new stylesheet exists, at `src/components/schedule/scheduleGrid.css`. No CSS file is
      added anywhere else and no component outside `src/components/schedule/` changes
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

- **T53** — imports `buildRowTracks` and `placeCell`.

## Blocks

T55 (collapse builds on the converted group view), T56, T58, T59.
