---
title: "Schedule canvas redesign — unified design"
document_type: spec
authority: normative
status: draft-for-approval
date: 2026-08-06
authors: [governor-architect-synthesis]
supersedes: []
ticket_size: large
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
---

# Schedule canvas redesign — unified design

**Status:** draft — awaiting product owner approval before any implementation begins.

This document is the result of a Governor + Architect synthesis pass over two independent ADHD
brainstorming runs (~60 candidate ideas across 10 cognitive frames) plus a preliminary Architect
design. Each section names which idea pool paths contributed what and why losers were rejected.

---

## 1. Rendering layer — which primitive

**Decision: keep the HTML table as the geometry oracle and structural spine; add a
position:absolute `<canvas>` sibling for all ambient visual state.**

The Architect's preliminary design proposed replacing the table with explicit absolute-positioned
divs driven by a `makeCellPositioner({ ROW_HEIGHT, COL_WIDTH })`. After reading the actual code,
that is a larger leap than the problem requires.

**Why the table stays:**

The existing table with `rowSpan` already is the coordinate oracle. `decideCell` and
`gridGeometry.js` are well-tested and compute the right span heights using the browser's own
layout engine — which is faster than recomputing them from a manual positioner. Converting every
span to `height = spanCount × ROW_HEIGHT` adds the coordinate-staleness risk at resize without
gaining anything the layout engine does not already provide for free. Karpathy: three similar
tables is better than a premature abstraction layer.

**What the table does after this redesign (no change):**
- Provides column widths, row heights, sticky headers
- Manages `rowSpan` for multi-block anchors, activities, and overlays through the existing
  `rowSpan` prop on `<td>` — unchanged
- Provides ARIA grid semantics (the accessible layer the canvas cannot provide)

**What the canvas layer does (new):**
- Draws all ambient visual state: hover tint, drag-over zone, selection highlight, flag highlight,
  empty-cell faint placeholder, fog-of-row dimming, OVER_INVALID conflict pulse, ghost-piece preview
- Is `aria-hidden="true"` — it is decorative only
- Is positioned `position: absolute; top: 0; left: 0; width: 100%; height: 100%` inside the
  existing scroll container, which gets `position: relative`
- Is `pointer-events: none` — all pointer events still reach the `<td>` elements beneath it

**What SlotCell and the `<td>` elements do after this redesign (changed):**
- Continue to own: text content, DnD drag handles, click handlers, `rowSpan`, semantic markup
- STOP owning: background-color changes during drag, hover tint, drag-over border, selection
  outline during gesture. These all move to the canvas layer.

**Sources from the idea pool this integrates:**
- Run 1 Direction 1 (deepened): "Table renders empty cells for geometry only; all session blocks
  in a sibling overlay" — adopted, but the session blocks stay as `<td>` elements (text/DnD);
  only the visual state layer moves to canvas.
- Run 2 Deepened A: "canvas at position:absolute top:0 left:0; activity divs are position:absolute
  from the rect array" — adopted for canvas placement; rejected the absolute-div-for-activities
  part (the table does this already without staleness risk).
- Run 1 Competitor frame: "Inert table skeleton + absolute-positioned render overlay" — this is
  exactly what we are doing, with canvas as the overlay rather than a div layer.
- Run 2 3am on-call: "One offscreen Canvas for visual utilization layer, DOM divs only for hit
  targets" — same pattern.

**Rejected approaches:**
- Full abs-positioned div grid (Architect's preliminary Phase 1): correctly identifies the
  rendering split but replaces a working geometry engine unnecessarily. Rejected.
- OffscreenCanvas on dedicated worker (Run 2 hardware frame, Run 2 remove-load-bearing-assumption
  frame): messaging overhead for 480 cells adds latency rather than removing it. The explicit trap
  note in both ADHD runs confirms this. Rejected.
- SVG scene graph (Run 2 Deepened C): fatal — `getComputedTextLength()` reflow per text node.
  Explicitly rejected in both ADHD runs. Rejected.
- CSS Houdini Paint Worklet: not production-ready in Electron without flags. Rejected.

---

## 2. Visual state layer — how ephemeral state propagates without React

**Decision: CSS custom property state bus + rAF dirty-cell flush via canvas.**

During any gesture (hover, drag, selection), no React state changes. The propagation path is:

```
pointer event
  → write CSS custom properties on the grid root element
  → rAF loop: read vars, diff against last-frame snapshot
  → canvas.drawAmbientLayer() for only dirty cells
```

React only fires on DATA COMMIT (a slot mutation, an overlay write, a selection finalize). It
never fires during the gesture itself.

**CSS custom property protocol (named constants in `src/styles/shared.js`):**

```
--grid-drag-cell-key    cell key of the current drag-over target (or empty)
--grid-hover-cell-key   cell key of the current hover (or empty)
--grid-drag-phase       idle | lifting | dragging | over-valid | over-invalid | resolving
--grid-highlight-kind   empty | UNFILLABLE | OVERLAP (from railView)
```

These are written by `useDragFSM` transition side-effects and by cell `onPointerEnter` handlers.
They are read by the rAF loop inside `canvasGridPainter.js`. They are never read by React.

**The `cellRects` map:**

On mount (and on resize via ResizeObserver), `computeCellRects(tableRef)` is called. It reads
`getBoundingClientRect()` from each `<td>` that has a `data-cell-key` attribute and builds a
`Map<cellKey, DOMRect>`. This is the coordinate bridge between the DOM and the canvas.

The canvas uses `cellRects` to know where to paint. When the ResizeObserver fires, the canvas
repaints from the new rects. There is no render-blocking recomputation — the old cellRects stay
valid until the observer fires and the new ones are ready.

**Style ownership contract:**

The rAF loop OWNS all background fills and overlay tints on the canvas. React NEVER writes
background colors to `<td>` elements that are in the painted region. This is the hard separation
that prevents the Run 1 Direction 2 collision risk. The only inline styles React writes to the
cell elements are: border, text color, font, cursor, padding, `rowSpan`. Never background.

**Sources from the idea pool this integrates:**
- Run 1 Direction 2 (deepened, starred): "CSS custom property state bus + rAF dirty-cell flush" —
  adopted in full as the mechanism for ephemeral state propagation. The risk it identified
  (React reconciler touching same inline style properties) is resolved by the strict ownership
  contract above.
- Run 2 Deepened A: "Canvas owns drawAmbientLayer(ctx, cellStateMap): called on rAF, not on React
  render" — adopted.
- Run 2 Speedrunner: "CSS custom properties on :root bypass React state; cells read via
  var(--cell-N-state)" — adopted, scoped to the grid root rather than :root (avoids global
  namespace pollution and DevTools confusion).
- Run 2 Hardware: "RAF dirty-cell flush loop: Set of dirty cell IDs, imperative DOM writes per
  rAF frame" — adopted but the writes go to the canvas, not to the DOM directly.

**Rejected approaches:**
- React state for hover/drag-over (current behavior): this is what is being replaced.
- Uint32Array framebuffer / packed bitmasks (Run 1 Hardware, Run 2 Hardware): correct engineering
  principle, catastrophic over-engineering for 480 cells in a local desktop app. Rejected.
- Frozen object state bus (Run 1 Direction 2 child idea): indirection without benefit for this
  scale. Rejected.
- SharedArrayBuffer dirty-bit mask (Run 2 Speedrunner): requires cross-origin isolation headers
  in Electron. More complex than CSS vars for the same effect. Rejected.

---

## 3. Interaction layer — drag model

**Decision: keep @dnd-kit; wrap its events in `useDragFSM`; add RESOLVING state for ghost-piece preview.**

The FSM (from `dragFSM.js`) is the single source of truth for all drag state. Its pure
`transition(state, event)` function replaces the scattered boolean atoms in ScheduleScreen
(`isGroupExpandDragActive`, `isDayExpandDragActive`, and equivalent transient states).

**FSM states (synthesized from Run 1 Direction 3 + Run 2 Deepened B, which independently
converged on the FSM pattern — significant deterministic evidence):**

```
IDLE
  → on DragStart: LIFTING
  → on PointerEnter(cell): HOVER

HOVER
  → on DragStart: LIFTING
  → on PointerLeave: IDLE

LIFTING
  (pointer down, movement < 8px — @dnd-kit activation threshold)
  → on DragMove(distance ≥ 8): DRAGGING
  → on PointerUp: IDLE (click fires normally)

DRAGGING
  → on DragOver(valid target): OVER_VALID
  → on DragOver(invalid target): OVER_INVALID
  → on DragEnd(no target): CANCELLED → IDLE

OVER_VALID
  → on DragOver(invalid target): OVER_INVALID
  → on DragEnd: RESOLVING

OVER_INVALID
  → on DragOver(valid target): OVER_VALID
  → on DragEnd(same): CANCELLED → IDLE

RESOLVING
  (pointer released over valid target — showing ghost preview)
  → commit mutation fires: COMMITTED → IDLE
  → on timeout (300ms, no commit): CANCELLED → IDLE
```

**Why RESOLVING state matters:** It creates the ghost-piece commitment from game design (Run 1 Game
design frame + Run 2 Game design: "speculative shadow board"). During RESOLVING, the canvas draws
the "would-land-here" preview — the block appears in its target position as a ghost tint before
the mutation writes through to React state. When the mutation commits, React re-renders and the
ghost disappears naturally. This makes drops feel instantaneous even if the DB write takes a few
milliseconds.

**Why keep @dnd-kit rather than native PointerEvents:**
@dnd-kit is already used, already has the `distance: 8` activation constraint that separates
clicks from drags, already handles palette drag, expand drag, and slot-swap. Its sensor pipeline
handles cross-platform pointer edge cases. Replacing it with raw `setPointerCapture` is a
high-risk refactor whose primary benefit (speed) is not a bottleneck at 480 cells. The FSM
wraps @dnd-kit's events; it does not replace its sensor layer.

The click/drag coexistence is already solved by the `distance: 8` activation constraint. The
LIFTING state in the FSM is the explicit representation of "undecided pointer" — no change to
the existing behavior, but now it is a named state rather than an implicit assumption.

**FSM context in React:**
`useDragFSM` exposes a React context with `{ state, payload }`. Cells compute their visual
appearance as `computeCellAppearance(fsmState, cellKey, slotData)` — a pure function — but they
do NOT re-render during gesture. Their appearance is handled by the canvas layer reading FSM state
via CSS vars. The context is consumed only at commit boundaries.

**Sources from the idea pool this integrates:**
- Run 1 Direction 3 (deepened): "State machine: IDLE → DRAGGING → OVER_VALID → OVER_INVALID →
  COMMITTED/CANCELLED" — adopted with HOVER and LIFTING added.
- Run 2 Deepened B: "useDragFSM hook wraps existing dnd-kit events; maintains {state, payload}
  with pure transition() function" — adopted in full. "RESOLVING state: holds tentative drop
  target after pointer-up but before commit" — adopted.
- Run 2 Game design: "DnD as FSM: IDLE → HOVER → LIFTING → DRAGGING → RESOLVING → COMMITTED" —
  adopted; this is the same FSM arrived at independently in three different frames.

**Rejected approaches:**
- Replace @dnd-kit with raw PointerEvents + setPointerCapture (Run 1 Speedrunner, competitor,
  Direction 3): higher risk, no measurable benefit at 480 cells, breaks existing palette drag
  which has different activation semantics. Rejected.
- Spatial R-tree / interval tree (Run 1 remove-load-bearing-assumption, Run 1 competitor): correct
  pattern for large grids; explicitly noted as overkill for 480 cells in ADHD Run 1. Rejected.
- CSS spring snap on drop (Run 1 competitor): browser CSS springs are not deterministic across
  platforms for a scheduling commit. The RESOLVING state + canvas ghost achieves the same feel
  via a deliberate animation. Rejected.

---

## 4. Game-feel layer — which ideas compose without complicating the architecture

**IN — compose cleanly onto the canvas layer, low complexity cost:**

1. **Faint empty-cell placeholder** (product owner answer: not invisible):
   Canvas draws a subtle noise/gradient on cells where `decideCell` returns `kind: 'empty'`.
   Zero structural change. The canvas's `drawAmbientLayer` already needs the full cellStateMap
   to paint drag-over zones; drawing a faint background on empty cells is a second `fillStyle`
   pass. Estimated cost: 5–10 lines in `canvasGridPainter.js`.

2. **Ghost-piece preview** (RESOLVING state):
   Canvas draws a semi-transparent fill on the target cell during RESOLVING state.
   Entirely a canvas paint behavior driven by `--grid-drag-phase === resolving` and
   `--grid-drag-cell-key`. Zero new state; the FSM already produces these values.

3. **OVER_INVALID conflict pulse** (Run 1 Game design: "conflict cells as enemies"):
   Reject the screen-shake. Accept the pulse. When `--grid-drag-phase === over-invalid`,
   the canvas draws a red-tinted fill with a sinusoidal opacity oscillation tied to
   `performance.now()` in the rAF loop. No new state. Gated on `prefersReducedMotion()`.

4. **Fog-of-row** (Run 1 Game design: "cells outside active group-row dim to 20% opacity"):
   When a drag is in progress, canvas dims all cells outside the active row to 20% opacity via
   a semi-transparent black overlay. The "active row" = the row of `--grid-drag-cell-key`.
   Pure canvas paint. Gated on `prefersReducedMotion()`.

**OUT — scope creep, feature additions, or complexity cost too high:**

- **Broadcast stamp mode** (Run 1 Game design: "double-tap time-block label, single-click to
  clone across groups"): Stamp mode already exists in `useOverlayFillStamp`. This is a feature
  change to how stamp is triggered, not a canvas architecture change. Out of scope.

- **Named save slots A/B/C** (Run 1 Game design): Snapshot functionality already exists in
  `useSnapshots`. Out of scope.

- **Full speculative shadow board** (Run 2 Game design: "applies in-flight drag outcome ahead of
  the drop, showing post-drop world optimistically"): Requires running `buildSchedule` or a
  subset of the engine on every pointer-move. The RESOLVING state ghost-piece covers 90% of the
  game-feel benefit at 1% of the complexity cost. Full speculative board is a Phase 3 candidate
  after the canvas layer is stable.

- **Hold-to-merge friction gate** (Run 1 Game design: "600ms press-and-hold to trigger span"):
  Changes the expand-merge interaction model. The existing drag-to-expand works and directors
  understand it. Out of scope.

- **Screen-shake on invalid drop** (Run 1 Game design): Distracting in a professional scheduling
  context. The OVER_INVALID pulse achieves the same information transfer without vestibular
  disruption. Rejected.

---

## 5. Row height design question — Designer recommendation

**The product owner's open question:** cell height fills the window (option A) vs. type size is
fixed and cell height accommodates it (option B).

**Honest tradeoffs:**

| Dimension | Option A (viewport-fill) | Option B (content-driven) |
|-----------|--------------------------|--------------------------|
| Scan quality | Director sees full week at a glance — no scroll | May require vertical scroll to see all blocks |
| Text legibility | Cell may be too tall or too short depending on window; text size must still be fixed or it becomes illegible at small windows | Fixed font size → consistent legibility |
| Print safety | Cell height in px units is not a print unit; print output depends on screen size at time of print | Predictable print output |
| Resize behavior | Grid height tracks window; coordinate cache must refresh on resize (ResizeObserver already planned) | Stable dimensions; ResizeObserver still needed but for canvas alignment only |
| Multi-block spans | Span height = spanCount × derived ROW_HEIGHT — correct by the same formula | Span height = spanCount × fixed ROW_HEIGHT — simpler |

**Recommendation (Designer call required before implementation):**

A hybrid: **viewport-bounded with a floor.**

```
ROW_HEIGHT = max(MIN_ROW_HEIGHT, floor((viewportHeight - CHROME_HEIGHT) / timeBlockCount))
MIN_ROW_HEIGHT = 48    // fits 12-13px label + 4px identity dot + 8px padding × 2
CHROME_HEIGHT  = measured at mount from header + toolbar + legend
```

This gives Option A behavior on large screens (director sees the full week without scrolling)
and gracefully degrades to Option B behavior (scroll) on small screens where the window cannot
fit all blocks at MIN_ROW_HEIGHT.

**Text does NOT scale with cell height.** Font size stays at 12–13px. Activity labels are clipped
with `overflow: hidden; text-overflow: ellipsis` within the fixed-height cell. This preserves
legibility under all window sizes.

**This is a Designer call.** The tradeoff between Option A and Option B is a visual design
question about scanning vs. reading ergonomics. This synthesis recommends the hybrid, but the
Designer must verify it against the DESIGN_STANDARD before ROW_HEIGHT and MIN_ROW_HEIGHT are
locked. Implementation must not proceed on this question without that verification.

---

## 6. Module boundaries

### New modules (net-new files)

**`src/screens/schedule/dragFSM.js`**
- Owns: pure `transition(state, event) → { nextState, sideEffects[] }` function; all
  state × event pairs defined exhaustively; no React, no DOM, no CSS
- Input: current FSM state + dnd-kit event type + event payload
- Output: next state + list of CSS custom property writes to perform
- Must have: 100% unit test coverage of every state × event pair before any component touches it
- Nothing else may depend on this module at Phase 1 (it is a black box the hook consumes)

**`src/screens/schedule/useDragFSM.js`**
- Owns: React hook that subscribes to @dnd-kit's `onDragStart`/`onDragOver`/`onDragEnd` events;
  calls `transition()`; applies the returned CSS custom property writes to the grid root element;
  schedules canvas repaint via requestAnimationFrame
- Exposes: `{ state, payload }` React context value for commit-boundary consumers
- Does NOT expose: any state that changes during gesture (the canvas reads CSS vars, not context)

**`src/screens/schedule/canvasGridPainter.js`**
- Owns: all canvas paint functions — pure, no React, no DOM reads
- API: `drawAmbientLayer(ctx, cellRects, cellStateMap, fsmPhase, motionReduced)`
  - `cellRects`: `Map<cellKey, DOMRect>` from `computeCellRects`
  - `cellStateMap`: `Map<cellKey, { kind, flagHighlight, selected, empty }>` — snapshotted
    from current slot data at render time, not per-frame
  - `fsmPhase`: string from CSS var — no React dependency
  - `motionReduced`: boolean from `prefersReducedMotion()`
- Separate functions: `clearCanvas(ctx)`, `drawGhostPiece(ctx, rect)`,
  `drawConflictPulse(ctx, rect, t)`, `drawFogOverlay(ctx, canvasRect, activeRowRect)`
- Testable in isolation with a mock canvas context

### Extended modules (existing files, additive changes only)

**`src/screens/schedule/gridGeometry.js`** — ADD one function:
- `computeCellRects(tableRef) → Map<cellKey, DOMRect>`
  Walks the table's `<td>` elements that have `data-cell-key` attributes, calls
  `getBoundingClientRect()`, builds and returns the map.
  Unit tested with a mock DOM in isolation before any component calls it.
  All existing functions in this file remain unchanged.

**`src/styles/shared.js`** — ADD constants:
- `GRID_CSS_VARS`: named object mapping each CSS custom property name to its default value,
  providing the typed protocol between the FSM and the canvas
- `MIN_ROW_HEIGHT`: 48 (pending Designer sign-off)
- No deletions from this file

### Preserved modules (zero changes)

- `src/engine/buildSchedule.js` — hard constraint, untouched
- `src/screens/schedule/dragHandlers.js` — the commit logic (expandSlot, placeActivityManual,
  swapSlots) is already clean. The FSM calls these handlers on COMMITTED transition via the
  existing ScheduleScreen-level handlers. No structural change needed.
- `src/screens/schedule/findingHighlight.js` — canvas reads the highlight map it produces; no
  API change
- `src/data/scheduleRepository.js` — untouched
- `src/engine/readiness.js`, `weekCatalog.js` — untouched
- All hooks in `src/screens/schedule/use*.js` — untouched (useUndoRedo, useClipboardSelection,
  useOverlayFillStamp, useSnapshots, useWeeks, useGeneration, useSlotMutations, useRouteState,
  useScheduleData)

### Changed components (modifications to existing files)

**`src/components/schedule/ScheduleGroupView.jsx`**
- ADD `data-cell-key` attribute to every `<td>` for canvas coordinate mapping
- ADD canvas element inside scroll container (`position:absolute, aria-hidden, pointer-events:none`)
- CHANGE `DroppableEmptyCell`: remove `isOver`-driven `background` and `outline` inline styles;
  keep `useDroppable` for dnd-kit drop detection (the visual response moves to canvas)
- ADD ResizeObserver effect that calls `computeCellRects` and schedules a canvas repaint

**`src/components/schedule/ScheduleDayView.jsx`**
- Same `data-cell-key`, canvas element, ResizeObserver treatment

**`src/components/schedule/SlotCell.jsx`**
- REMOVE hover-driven `background` inline style changes during drag-over (move to canvas)
- KEEP all structural borders, click handlers, DnD drag handles, text rendering, identity dot,
  flag icons, lock/anchor bars — these are content, not visual state

### Deleted modules

None in Phase 1 through Phase 3. The goal is to add the canvas layer and FSM, verify the
behavior, then remove the redundant React visual state path in Phase 3. No file should be
deleted until the canvas layer draws exactly what the React path drew.

---

## 7. Migration path (corrected from Architect's preliminary sequencing)

The Architect's preliminary design led with replacing the table in Phase 1. This synthesis inverts
that: start with the pure-JS modules that have no user-visible risk, then add the canvas in a way
that can coexist with the current visual state before removing it.

### Step 1 — Pure-JS foundations (no user-visible change, fully unit tested)

1. Add `computeCellRects(tableRef)` to `gridGeometry.js` with unit tests
2. Write `dragFSM.js` with `transition()` and exhaustive unit tests for every state × event pair
3. Write `canvasGridPainter.js` with pure paint functions and mock-canvas unit tests

**Success predicate:** all new unit tests pass; no existing tests regress; no component touched.

### Step 2 — Canvas layer added (parallel to existing visual state)

1. Add canvas element to `ScheduleGroupView` and `ScheduleDayView` scroll containers
2. Wire `computeCellRects` to a ResizeObserver on mount
3. Implement `useDragFSM` wrapping @dnd-kit events
4. Canvas draws ambient state (empty placeholders, hover tint, drag-over zone)

At this point both paths exist simultaneously: canvas draws and so does the React inline-style
path. This lets visual verification happen — is the canvas drawing what the React path drew? —
before the React path is removed.

**Success predicate:** canvas draws correct hover/drag-over zones; existing behavior is unchanged
(React path still active); no visual regressions in Tester report.

### Step 3 — Remove React visual state path

1. Remove `isOver`-driven `background` and `outline` from `DroppableEmptyCell`
2. Remove hover-driven `background` from `SlotCell` drag-over states
3. Replace the scattered `isGroupExpandDragActive` / `isDayExpandDragActive` booleans in
   `ScheduleScreen` with FSM state reads
4. Add `data-cell-key` attributes to all `<td>` elements

**Success predicate:** Tester finds no visual regression vs. Step 2 baseline; FSM is the single
source of truth for drag phase; no `isOver`-driven inline styles remain.

### Step 4 — Game-feel additions

1. Fog-of-row dimming in `canvasGridPainter.js` (gated on `prefersReducedMotion()`)
2. RESOLVING state ghost-piece preview
3. OVER_INVALID conflict pulse animation
4. Faint empty-cell placeholder (canvas)

**Success predicate:** Tester confirms game-feel additions are visible and correct; motion-sensitive
users (prefersReducedMotion) see no animation.

### Row-height design question (Step 0, blocking Step 1)

The row-height formula cannot be deferred to Phase 2. `computeCellRects` reads from the DOM, so
the DOM must be sized correctly before coordinates are measured. **The Designer must sign off on
the viewport-bounded formula before Step 1 begins.**

---

## 8. Accessibility — in scope, not deferred

Per product owner: accessibility is tied in, not deferred.

**ARIA:** The HTML table structure is unchanged, so its ARIA grid semantics are preserved. The
canvas element is `aria-hidden="true"`. No change to existing tab order or keyboard handlers.

**ARIA live region:** On FSM COMMITTED and CANCELLED transitions, `useDragFSM` writes to a
visually-hidden `aria-live="polite"` region with a human-readable description:
`"Swimming moved to Tuesday, Block 3"` or `"Move cancelled"`. The text is constructed from the
FSM's `payload` (activity name, target day, target block) which is already available in the
committed state.

**Motion:** All canvas animations (fog-of-row, conflict pulse, ghost-piece fade) check
`prefersReducedMotion()` from `shared.js` (already exists). When reduced motion is set, the
canvas draws the state statically with no animation.

**Color:** All canvas fills use `var(--primary)`, `var(--danger)`, `var(--text)` via
`getComputedStyle(rootEl).getPropertyValue(...)` — they participate in the existing color token
system and correctly adapt to the app's theme.

---

## 9. ADR — required

This design meets the ADR bar on three grounds:
1. Introduces a new rendering primitive (canvas as ambient-visual owner) that other code will
   depend on
2. Changes an existing contract: visual state is currently owned by React inline styles on `<td>`
   elements; after this change it is owned by the canvas rAF loop. Any future code that writes
   `background` inline styles to cell `<td>` elements during gesture will violate the new contract.
3. Makes a tradeoff that is not obviously reversible: the CSS custom property state bus creates a
   non-React update path for grid state that sits outside React DevTools visibility.

The ADR records:
- Canvas-as-ambient-layer as the visual state owner for the schedule grid
- CSS custom property protocol as the interface between interaction (FSM) and rendering (canvas)
- The decision to keep the HTML table (rejecting the abs-positioned div replacement)
- The decision to keep @dnd-kit (rejecting raw PointerEvents)
- The style ownership contract: React never writes background-color to cell `<td>` elements
  during gesture

ADR will be filed at `docs/adr/2026-08-06-schedule-canvas-visual-layer.md` after product owner
approval of this spec.

---

## Open items requiring product owner or Designer resolution before Step 1 begins

1. **Row-height formula** (Section 5): Designer must confirm the viewport-bounded hybrid
   recommendation with `MIN_ROW_HEIGHT = 48` before any implementation. If Designer rejects it,
   the alternative is Option B (fixed `ROW_HEIGHT = 56`) which is simpler and equally valid.

2. **Fog-of-row** (Section 4): The product owner should confirm this behavior is desirable for
   the intended user (camp scheduling director). It dims cells outside the active row during drag.
   Visually distinctive but potentially disorienting for a first-time user. If uncertain, exclude
   from Step 4 and revisit after user testing.

3. **RESOLVING state timeout** (Section 3): 300ms before RESOLVING transitions to CANCELLED if the
   mutation does not commit. The mutation is synchronous (SQLite write through localClient). In
   practice the commit should fire in under 50ms. The 300ms is a safety value. No product decision
   needed — this is an engineering constant — but noted for awareness.

---

## What this design is NOT

- Not a replacement for the schedule engine (`buildSchedule.js` is untouched)
- Not a new data shape — no new tables, no new IPC messages
- Not a replacement for the route system — Manual and Generated remain separate candidates
- Not a browser product adaptation — all decisions are grounded in Electron's local context
- Not designed for a hypothetical 1000-group camp — 480 cells is the specified maximum
