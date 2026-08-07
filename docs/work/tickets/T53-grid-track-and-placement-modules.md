---
title: T53-grid-track-and-placement-modules
document_type: ticket
status: closed
created: 2026-08-06
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T50-schedule-canvas-rebuild.md]
archive_when: gridTracks.js and gridPlacement.js exist, are pure, are unit tested, and the app is unchanged at runtime
---

# T53 — Pure grid-track and grid-placement modules

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §4, §9, migration Step 1.
**Risk:** Very low. Nothing imports these modules when this ticket closes.

---

## Problem

The schedule grid is being migrated from an HTML `<table>` + `rowSpan` to a single CSS Grid
container (ADR `2026-08-06-schedule-canvas-visual-layer`). Two facts about CSS Grid make shared,
pure modules a precondition rather than a nicety:

1. **Row track sizing becomes a string, not a layout side effect.** In a table, row height falls
   out of content. In CSS Grid it is stated declaratively as
   `grid-template-rows: repeat(N, minmax(<floor>, auto))`, emitted as one `--grid-rows` custom
   property on the container. Collapse and density are the same string with different tracks.

2. **Grid children do not inherit their column from document order.** A `<td>` gets its column
   for free; a grid child does not. Every cell must be given an explicit `grid-column`. **Getting
   this wrong fails silently — the cells stack in column 1 and nothing throws.** Four view
   components must not be allowed to disagree about the off-by-one.

This ticket lands both modules, fully tested, before any component consumes them.

---

## Scope

**In — two new files under `src/screens/schedule/`:**

### `gridTracks.js`

```js
buildRowTracks({ timeBlocks, collapsedBlockIds, density }) -> string
```

- Returns the `grid-template-rows` value for the `--grid-rows` custom property.
- A block **not** in `collapsedBlockIds` gets `minmax(<floor>, auto)`.
- A block **in** `collapsedBlockIds` gets the fixed length `COLLAPSED_TRACK`.
  **Never `auto`** — `auto` would let content re-expand a collapsed row and defeat the collapse.
- `density` selects the floor.

Export the three resolved constants from this module so there is exactly one copy:

```
COLLAPSED_TRACK    = 20   // px — see §2 D2
ROW_FLOOR_NORMAL   = 48   // px — see §4 D3
ROW_FLOOR_COMPACT  = 40   // px — see §4 D3
```

`40px` is the floor for compact and **the work stops there**. The spec measured `34px` and found
it **inert**: rows at 40px and 34px render identically (483px total) because below ~40px the floor
stops binding and the row header becomes the constraint. Going denser requires restacking the row
header onto one line, which is a separate visual change with its own scanning cost. Do not add a
denser mode.

### `gridPlacement.js`

```js
placeCell({ blockIndex, columnIndex, rowSpan = 1, colSpan = 1 }) -> { gridRow, gridColumn }
```

- `gridRow` = `` `${blockIndex + 1} / span ${rowSpan}` ``
- `gridColumn` = `` `${columnIndex + 2} / span ${colSpan}` `` — the `+ 2` is 1 for CSS Grid's
  1-based lines plus 1 for the leading row-header column.
- Also export a helper for the row-header cell itself so the `1` is not written by hand in four
  places.

This module exists **specifically** so the four views cannot disagree about the off-by-one. Its
whole justification is that the failure mode is silent.

**Out:**

- Any change to a view component, `SlotCell`, `OverlayCell`, or `scheduleGrid.css`.
- Any change to `gridGeometry.js` — it survives the whole migration unchanged (see T54).
- Collapse route state, a collapse UI, or a density toggle. `buildRowTracks` accepts
  `collapsedBlockIds` and `density` as parameters; **nothing supplies them yet.** Wiring them to
  route state is T55.
- `dragFSM.js` and `closestEdge.js`. The spec's Step 1 bundles all four modules; they are split
  here so each lands immediately before its consumer rather than sitting unused for four tickets.
  See T57.

---

## Acceptance

- [ ] `src/screens/schedule/gridTracks.js` exists, is pure (no DOM, no imports from React or
      `localClient`), and exports `buildRowTracks`, `COLLAPSED_TRACK`, `ROW_FLOOR_NORMAL`,
      `ROW_FLOOR_COMPACT`
- [ ] `src/screens/schedule/gridPlacement.js` exists, is pure, and exports `placeCell`
- [ ] `gridTracks.test.js` covers: no collapsed blocks; one collapsed block; **several
      non-adjacent collapsed blocks**; all blocks collapsed; both density modes; empty
      `timeBlocks`
- [ ] `gridTracks.test.js` asserts a collapsed track is the literal `20px`, never `auto` and never
      a `minmax()`
- [ ] `gridPlacement.test.js` asserts the exact placement strings for a known fixture, including
      `blockIndex: 0, columnIndex: 0` (must be `"1 / span 1"` and `"2 / span 1"`) and a
      `rowSpan: 3` span head
- [ ] **The app is unchanged at runtime.** No existing file imports either module at close.
- [ ] `src/screens/schedule/gridGeometry.test.js` is untouched and green — this is the standing
      proof across the whole T50 migration that the change is rendering-only
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

None. This is the first implementation ticket of the T50 migration.

## Blocks

T54 (first view conversion) and T55 (collapse) both import these modules.
