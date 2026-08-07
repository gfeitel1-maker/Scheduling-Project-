---
title: T58-drag-fsm-cutover
document_type: ticket
status: closed
created: 2026-08-06
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T57-drag-fsm-and-closest-edge-modules.md, docs/work/tickets/T56-convert-remaining-schedule-views.md]
archive_when: all four drag kinds run through dragFSM, no boolean drag flag remains in ScheduleScreen.jsx, and no cell subscribes to useDroppable
---

# T58 — Drag cutover: FSM, container droppable, static drop indicators

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §5 (all),
§7, migration Step 5. **ADR:** `docs/adr/2026-08-06-schedule-canvas-visual-layer.md` §6.
**Risk:** Medium-high. This is the ticket that can regress a working interaction. It is deliberately
sequenced last among the behavioural changes so a drag regression is attributable to it alone.

---

## Problem

Three things about drag in the schedule grid are wrong, and they are wrong together:

1. **Drag state is scattered.** `ScheduleScreen.jsx` carries `isExpandDragActive`,
   `isGroupExpandDragActive`, `isDayExpandDragActive`, and ad-hoc `fillState` checks. Nothing says
   what state a drag is in; click-vs-drag ambiguity lives implicitly in @dnd-kit's `distance: 8`
   constraint.

2. **Every cell subscribes to collision detection.** `SlotCell` and `DroppableEmptyCell` each call
   `useDroppable`. At 12 groups × 5 days × 8 blocks that is **up to 480 subscribers evaluating
   `isOver` on every pointer event** — the actual source of per-pointer-event React work. It is also
   why `closest-edge` cannot be implemented: a per-cell droppable knows it is over, not *where*.

3. **There is no drop indicator worth the name.** "Insert above block 4" is indistinguishable from
   "replace block 4."

T57 landed the pure `dragFSM` and `closestEdge` modules with exhaustive tests. This ticket wires
them in and deletes what they replace.

---

## Scope

**In:**

### 1. `useDragFSM.js` (new, `src/screens/schedule/`)

Binds the FSM to @dnd-kit sensors and **executes** the `sideEffects` the pure machine describes.

### 2. One container droppable, not 480 cell droppables

Remove `useDroppable` from `SlotCell` and `DroppableEmptyCell`. Put **one** droppable on the grid
container and resolve pointer → cell ourselves:

```js
const cellEl = document.elementFromPoint(x, y)?.closest('[data-cell-key]')
```

`data-cell-key` was added to cells in T54. This is FullCalendar's `HitDragging` pattern — resolve a
hit from pointer coordinates against the grid rather than registering every cell as a target. It is
cheaper, it removes 480 subscriptions, and **it is the only way to implement `closest-edge`.**

### 3. `dragHandlers.js` becomes a thin adapter

`makeDragHandlers` delegates to `dragFSM`. **Delete** `isExpandDragActive`,
`isGroupExpandDragActive`, and `isDayExpandDragActive` from `ScheduleScreen.jsx` in favour of FSM
state, and remove the now-dead `isExpandDragActive` props threaded into the views.

### 4. Drag preview and drop indicator are two separate concerns

Per Atlassian's separation:

- **Drag preview** — follows the pointer, represents *what* is moving. A **distinct ghost element**,
  not dimming in place (3 of 5 calendars surveyed use a distinct ghost).
- **Drop indicator** — **static**, marks *where* it lands. **Never follows the pointer.**
  Driven by `closestEdge` and expressed as `data-drop-edge="top|bottom"`.

### 5. No animated placement feedback — this is binding, not a preference

> Atlassian replaced `react-beautiful-dnd` because animated placement feedback made interfaces feel
> **sluggish** — users had to wait for animations to finish before they could read intent. Their
> replacement uses *"lines, borders and background color changes,"* and they state *"a lack of
> animations helps make the interface feel snappy."*
> https://www.atlassian.com/blog/design/designed-for-delight-built-for-performance

**No animated reflow of cells during drag. No cells sliding to make room.** Drop feedback is a
static border / line / background change on the target.

### 6. Gesture state goes straight to the DOM

Spec §7's rule: state that changes **during a gesture** (`data-drag-over`, `data-drop-edge`) is
written directly by an FSM side effect — one `setAttribute` on one element plus one removal on the
previous element. State that changes **on commit** (selection, flags, collapse, data) goes through
React normally. **Do not route drag-over through React state**; re-rendering 480 cells to tint one
is the exact cost this design exists to avoid.

### 7. Keyboard drag

@dnd-kit's keyboard sensor stays wired, with `aria-live` announcements for pick-up, move, and drop.
**This is the stated reason @dnd-kit is retained at all** — replacing it with raw
`setPointerCapture` was rejected in the ADR because it would mean reimplementing this sensor.

### 8. Activation distance (optional, low stakes)

`distance: 8` is on the deliberate end of the range (Windows 4px, Unity 5px, dnd-kit default 5px;
**zero constraint when dragging an explicit handle**). Reviewing down to 5px and applying zero
constraint to the expand handle — which *is* an explicit handle — is recommended but explicitly
"not a blocker." If changed, say so in the closure note.

**Out:**

- Any rendering, spanning, collapse, or track-sizing change. Those are T54–T56 and must already be
  shipped.
- Multi-select drag, or any new drag *capability*. This ticket changes how the four existing drag
  kinds are implemented, not what a director can do.
- **Native HTML5 drag-and-drop.** Across every product surveyed it appears in exactly one role:
  accepting drops from *outside* the application. No touch support, no screen-reader signaling,
  uncontrollable preview styling. Never use it for in-grid movement.
- Keyboard *grid navigation* (arrow keys, roving `tabindex`) — T59. Keyboard *drag* is in scope
  here; keyboard *focus movement between cells* is not.
- `ACTIVITY_COLORS` tokenization — T52.

---

## Acceptance

- [ ] **All four drag kinds work**, verified by hand under `npm run electron:dev`: slot move,
      palette drop, expand/extend drag, overlay fill drag — in every view that offers them
- [ ] `grep -n "isExpandDragActive\|isGroupExpandDragActive\|isDayExpandDragActive"
      src/screens/ScheduleScreen.jsx` returns nothing. **No boolean drag flag remains**
- [ ] `grep -rn "useDroppable" src/components/schedule/` returns nothing. Exactly one droppable
      exists, on the grid container
- [ ] A drag over a cell writes `data-drag-over` via `setAttribute`, and the previous cell's
      attribute is removed. Confirm in DevTools that a drag does **not** re-render the cell tree
- [ ] `data-drop-edge="top"` and `="bottom"` both render distinguishable static indicators, and
      "insert above" is visibly different from "replace" **without a modifier key**
- [ ] The drag preview is a distinct ghost element following the pointer; the drop indicator is
      static and does **not** follow the pointer
- [ ] **No animated cell reflow during drag.** No cell slides to make room. Grep for transitions
      on cell `transform`/position introduced by this ticket
- [ ] Keyboard drag works end to end via the @dnd-kit keyboard sensor, and `aria-live` announces
      pick-up, move, and drop
- [ ] A commit failure in `Resolving` returns the UI to `Idle` with no orphaned `data-drag-over` or
      `data-drop-edge` attribute left on any cell
- [ ] `dragFSM.test.js` and `closestEdge.test.js` (from T57) still pass unmodified —
      **the cutover must not require changing the machine's contract**
- [ ] `dragHandlers.test.js` passes or is updated to the adapter's new shape, with the change
      explained in the closure note
- [ ] `src/screens/schedule/gridGeometry.test.js` untouched and green
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

- **T57** — `dragFSM.js`, `closestEdge.js`.
- **T56** — all four views must be CSS Grid and carry `data-cell-key` before per-cell droppables
  can be removed; `elementFromPoint` resolution depends on the grid cell elements existing.

## Blocks

T60 (cleanup).
