---
title: "CSS Grid as the schedule grid rendering primitive; HTML table and rowSpan retired"
document_type: adr
authority: normative
status: accepted
date: 2026-08-06
supersedes: []
implementation_state: implemented
affects: [src/components/schedule/ScheduleGroupView.jsx, src/components/schedule/ScheduleDayView.jsx, src/components/schedule/ScheduleActivityView.jsx, src/components/schedule/ManualBuildView.jsx, src/components/schedule/SlotCell.jsx, src/components/schedule/slotCellConstants.js, src/screens/schedule/gridGeometry.js, src/screens/schedule/dragHandlers.js, src/screens/ScheduleScreen.jsx, src/styles/shared.js, CLAUDE.md]
---

# CSS Grid as the schedule grid rendering primitive; HTML table and rowSpan retired

**Status:** accepted — implemented (T50 + T53–T60); see
`docs/work/specs/2026-08-06-schedule-canvas-redesign.md`.

**This ADR replaces an earlier draft of the same file** titled "Schedule grid: canvas ambient
layer as visual state owner." That draft was never accepted and never implemented. Its decision
— keep the `<table>` + `rowSpan` and add a `position:absolute <canvas>` ambient layer with a
`requestAnimationFrame` paint loop and a `--grid-*` CSS-custom-property state bus — is **rejected
and withdrawn**. It was written before the empirical survey recorded below.

## Context

The schedule grid renders up to 480 cells (12 groups × 5 days × 8 time blocks) across four views
(`ScheduleGroupView`, `ScheduleDayView`, `ScheduleActivityView`, `ManualBuildView`). Today all four
use an HTML `<table>` with `rowSpan` for multi-block activities, anchors, and overlays, and express
ephemeral visual state (hover, drag-over, selection, flag highlight) as inline style changes driven
by React state — including a `useDroppable` subscription on every cell.

The earlier draft framed this as a **performance** problem. Measurement says it is not: across three
working mockups (table+rowSpan, CSS Grid, absolute positioning) 60 drag frames cost 2.9 / 4.0 /
4.6 ms — no meaningful difference. The real problems are structural:

- Collapsing a period costs a full table re-render (7.1 ms) versus one custom-property write in
  CSS Grid (3.9 ms), and the table's collapse behavior cannot be separated from its content.
- `rowSpan` couples merging into document order, so merge logic leaks into anything that touches
  coordinates, selection, or focus order.
- Cells cannot be reasoned about independently of the rows they sit in.

## Decision

### 1. CSS Grid is the rendering primitive

Each view renders one CSS Grid container. Every slot, overlay, row header, and empty placeholder
is a grid child placed with explicit `grid-row: <n> / span <rowSpan>` and
`grid-column: <n> / span <colSpan>`. No `<table>`, `<tr>`, `<td>`, or `rowSpan` attribute remains
under `src/components/schedule/`.

Row track sizing is `grid-template-rows: repeat(N, minmax(<floor>, auto))`, emitted as one
`--grid-rows` custom property. This **replaces the JS row-height formula and `ResizeObserver`** the
earlier draft proposed. `minmax(floor, auto)` is what makes cells size to their content: with a
long activity name, the CSS Grid mockup clipped 0 cells where the absolute-positioning mockup
clipped 3.

### 2. Canvas is rejected

- 480 cells is 3–4 orders of magnitude below where canvas pays off — below Lighthouse's ~800-node
  warning, below AG Grid's 500-rendered-row cap, and not enough to warrant virtualization at all.
- The mechanism canvas fixes is DOM mount/unmount churn per scroll frame. We have zero churn.
- Daniel Imms, author of both the VS Code canvas and the WebGL terminal renderers: *"Start out with
  virtualizing the DOM so only the visible parts are showing, if the framerate isn't acceptable
  after that then consider switching to canvas."* We have not needed step one. Also Imms:
  *"Supporting screen readers will probably also negate the benefits of using canvas to begin with
  since you need to maintain the DOM structure anyway."*
- The canvas cost ledger is paid in full regardless of grid size: parallel a11y DOM, custom cursor
  and selection, custom hit-testing, IME/RTL regression, loss of Ctrl+F (Glide shipped its own
  search), a `measureText` cache with font-load invalidation, and broken DevTools inspection.
- Monaco/VS Code — the closest structural analogue — uses layered absolutely-positioned DOM and
  reserves canvas for exactly one thing: the minimap.
- Mozilla Bespin is the documented case of a team abandoning canvas after Ace proved DOM was
  equally fast.

### 3. `rowSpan` is retired in favor of `span N`

`decideCell`'s existing `{ kind: 'skip' }` branch — "this cell is a tail covered by a head's span,
render nothing" — maps onto CSS Grid unchanged, because grid children are placed rather than
flowed. That branch is the same "render the spanning cell once, suppress the covered cells"
mechanism AG Grid built in a dedicated `rendering/spanning/` layer and MUI X built with
`calc(var(--height) * ${rowSpan})` + covered cells returning `null`. `grid-row: span N` is the
native expression of the pattern both teams hand-built. Of the grids surveyed, only Handsontable
uses real HTML `rowSpan`, and only because it kept a `<table>`; Glide declined row spanning
entirely and RevoGrid paywalled it.

### 4. Absolute positioning is rejected

It is the dominant data-grid pattern (5 of 7 surveyed) and unanimous among calendars, but both
rationales are inapplicable. The data-grid rationale is virtualization-specific (bvaughn's stated
reason is that spacer padding cannot go negative, breaking scroll anchoring) and we do not window.
The calendar rationale is continuous time, and our lattice is discrete and uniform. The decisive
flaw is verified: an absolutely-positioned box cannot size to its content, so long names clip —
which is why FullCalendar needs `eventMinHeight`/`eventMaxStack`/"+N more" and Syncfusion needs
`maxEventsPerRow`. With T41 (elective scheduling) putting several activities in one period, a cell
that cannot size to its content is the wrong foundation.

### 5. Collapse is two concerns, explicitly separated

**Track geometry** is the grid container's job (`--grid-rows` replaces one track with a fixed
`COLLAPSED_TRACK`). **Content presentation** is the cell's job (`[data-collapsed]` re-presents the
cell at that height: reduced padding, smaller dimmed single-line label, hidden dot/flag/handle).

The table conflated these because table cells are content-sized. CSS Grid separates them, which is
why collapse costs one property write — but it means the collapsed content state must be authored
explicitly rather than falling out for free. That omission, not CSS Grid, was the cause of the poor
collapse behavior observed in the first grid mockup.

Binding constraints: a collapsed track is a fixed length, never `auto`; collapsed content is
single-line and ellipsized (the one scoped exception to the no-clipping rule); only a span
**head**'s block determines collapsed presentation; collapse never changes DOM membership,
focusability, or accessible names.

### 6. Drag is one explicit finite state machine

`src/screens/schedule/dragFSM.js`: pure `transition(state, event) → { nextState, sideEffects }`
over `Idle → Pointing → Dragging → Resolving → Idle`. `Pointing` is the named home of
click-vs-drag ambiguity (tldraw's pattern); `Resolving` covers "released over a valid target,
op-log write not yet committed." It replaces the scattered flags `isExpandDragActive`,
`isGroupExpandDragActive`, `isDayExpandDragActive`, and ad-hoc `fillState` checks.

No data grid surveyed uses an FSM — AG Grid, Handsontable, RevoGrid, and Glide all use ad-hoc
nullable flags scattered across files. Calendars do: FullCalendar splits three ways
(`PointerDragging` / `FeaturefulElementDragging` / `HitDragging`), Toast UI has a `DraggingState`
enum.

Supporting decisions:

- **Never HTML5 native drag-and-drop.** Across every product surveyed it appears in exactly one
  role: accepting drops from outside. No touch support, no screen-reader signaling, uncontrollable
  preview styling.
- **@dnd-kit is retained** as the sensor/input-normalization layer — notably for its keyboard
  sensor, which is load-bearing for the accessibility commitment. But **per-cell `useDroppable` is
  removed** in favor of one container droppable plus pointer→cell resolution
  (`elementFromPoint(...).closest('[data-cell-key]')`), FullCalendar's `HitDragging` pattern. This
  removes up to 480 collision-detection subscribers and is the only way to implement `closest-edge`.
- **Drop feedback is static, never animated placement.** Atlassian replaced `react-beautiful-dnd`
  because animated placement made interfaces feel sluggish — users had to wait for animations to
  finish to read intent — and their replacement uses *"lines, borders and background color
  changes,"* stating *"a lack of animations helps make the interface feel snappy."*
  (https://www.atlassian.com/blog/design/designed-for-delight-built-for-performance)
- **Drag preview and drop indicator are separate concerns** (Atlassian). A distinct ghost element
  beats dimming in place (3 of 5 calendars). Hit detection uses the `closest-edge` pattern.

### 7. Accessibility is in scope, with real ARIA row structure

`role="grid"` container → `role="row"` wrappers with `display: contents` → `role="gridcell"`
children placed on the grid, carrying `aria-rowindex`/`aria-colindex` and `aria-rowspan`/
`aria-colspan`. `display: contents` removes only the box, so children become direct grid items
while the wrapper keeps its row role — the TanStack pattern of discarding the layout algorithm but
not the semantics.

`display: contents` had documented a11y-tree bugs, fixed in Chromium ~89; this app ships Electron
43. **This is treated as unverified**: migration Step 2 carries an explicit acceptance gate to
inspect the rendered accessibility tree. Documented fallback on evidence of failure: no row
wrappers, `aria-rowindex`/`aria-colindex` on cells only.

### 8. The styling constraint is narrowly relaxed

The "inline styles only, no CSS files" rule has **no recorded rationale** (earliest appearance is a
tech-stack line in an archived 2026-05-23 plan) and is **already false** — `src/index.css` and
`src/App.css` exist and `src/index.css` defines the entire design token set. The operative
convention is narrower than stated: global tokens in CSS, component styles inline.

**Decision: add exactly one scoped stylesheet, `src/components/schedule/scheduleGrid.css`**,
owning the grid container rules, cell interaction pseudo-states (`:hover`, `:focus-visible`,
`:active`), cell data-attribute states (`[data-collapsed]`, `[data-drag-over]`, `[data-selected]`,
`[data-drop-edge]`, `[data-flagged]`, `[data-empty]`), and static cell structure. Per-cell computed
geometry (`gridRow`, `gridColumn`) and data-derived colors stay inline. Nothing outside
`src/components/schedule/` changes.

Rationale: inline styles have no `:hover`, no attribute selectors, and no `:has()`. That absence is
currently paid for with React state — `SlotCell` carries three separate `useState` hover flags and
`onPointerEnter`/`onPointerLeave` handlers — and the earlier draft's entire canvas + rAF apparatus
existed to escape the re-renders those handlers cause. **A styling convention with no recorded
rationale was about to justify a parallel rendering system.**

## Consequences

**Positive**

- Collapse becomes one custom-property write plus one attribute, and its two concerns are named
  and separately testable.
- Merging is expressed natively; `decideCell`'s `skip` branch needs no change at all.
- Cells size to their content, which is a precondition for T41 (several activities per period).
- `gridGeometry.js` survives in full, tests untouched — the migration is provably rendering-only.
- Hover and focus cost zero JavaScript.
- Accessibility improves from table semantics to explicit grid semantics with span extents
  announced.
- No second renderer, no rAF loop, no coordinate cache, no `ResizeObserver`, no style-ownership
  contract to police by convention.

**Negative / risks**

- **Grid children do not inherit their column from document order.** Every cell must be given an
  explicit `grid-column`; getting it wrong is silent (cells stack in column 1). Mitigated by a
  shared `gridPlacement.js` and per-view placement unit tests.
- `display: contents` a11y support is asserted, not yet verified. Gated in migration Step 2 with a
  documented fallback.
- Four view components change at once (staged across Steps 2 and 4). Visual-parity screenshots per
  view are the guard.
- One directory now mixes CSS and inline styles. `CLAUDE.md` and
  `docs/work/architecture-reports/TARGET_ARCHITECTURE.md` must be corrected to state the real
  convention, or the codebase and the docs disagree in a new way.

**Future constraints**

- **This design forecloses virtualization.** Grid places every child; windowing would require a
  spacer strategy and per-item placement. Reopening that is a rewrite, and must be driven by
  measurement, not anticipation.
- **Special events (T40) must stay out of this grid.** Product owner decision: special-event days
  get their own view; the weekly lattice does not bend to arbitrary timings. This is what removes
  continuous time — the one genuine risk CSS Grid carried. If special events were ever forced back
  into this grid, the rendering primitive choice would have to be re-examined.
- Any new ephemeral cell state is added as a data attribute plus a rule in `scheduleGrid.css`, not
  as React state.
- Any new drag behavior means a new state or event in `dragFSM.js` with its tests updated first.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| **HTML `<table>` + `rowSpan` (status quo)** | Rejected. Not slow — structurally wrong: collapse cannot separate track from content, and merging leaks into coordinates, selection, and focus order. Only Handsontable does this, and only because it kept a table. |
| **`<table>` + `<canvas>` ambient layer (the earlier draft of this ADR)** | Rejected. Framed a structural problem as a performance problem that measurement shows does not exist. Adds a parallel renderer, a parallel a11y surface, and an unenforceable style-ownership contract. |
| **Absolute positioning** | Rejected. Its rationale is virtualization (which we don't do) or continuous time (which we don't have), and its verified flaw — boxes cannot size to content, 3 cells clipped in the mockup — is disqualifying given T41. |
| **OffscreenCanvas on a worker** | Rejected. Messaging overhead exceeds any gain at 480 cells; flagged as a trap in both ADHD runs. |
| **SVG scene graph** | Rejected. `getComputedTextLength()` reflow per text node. |
| **CSS Houdini Paint Worklet** | Rejected. Not production-ready in Electron without flags. |
| **Replace @dnd-kit with raw `setPointerCapture`** | Rejected. Would require reimplementing the keyboard sensor, which the accessibility commitment depends on. Risk without benefit at this scale. |
| **Animated placement feedback during drag** | Rejected on Atlassian's published reversal: it reads as sluggish because users must wait for the animation to finish to read intent. |
| **Keep the inline-styles-only rule** | Rejected. The rule has no recorded rationale, is already violated by two existing stylesheets, and its cost — no `:hover`, no attribute selectors — is what nearly justified building a canvas renderer. |
