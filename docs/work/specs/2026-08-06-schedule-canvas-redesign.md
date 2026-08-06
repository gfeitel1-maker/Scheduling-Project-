---
title: "Schedule grid redesign — CSS Grid as the rendering primitive"
document_type: spec
authority: normative
status: approved
date: 2026-08-06
authors: [architect]
supersedes: []
ticket_size: large
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
affects: [src/components/schedule/ScheduleGroupView.jsx, src/components/schedule/ScheduleDayView.jsx, src/components/schedule/ScheduleActivityView.jsx, src/components/schedule/ManualBuildView.jsx, src/components/schedule/SlotCell.jsx, src/components/schedule/OverlayCell.jsx, src/screens/schedule/gridGeometry.js, src/screens/schedule/dragHandlers.js, src/styles/shared.js]
---

# Schedule grid redesign — CSS Grid as the rendering primitive

**Status:** draft — awaiting product owner approval before any implementation begins.

**This document is a rewrite.** Its previous revision recommended "keep the HTML `<table>` +
`rowSpan`, add a `<canvas>` ambient layer." That recommendation is **rejected and withdrawn.**
Empirical research over primary sources (four survey passes across VS Code/Monaco, xterm.js,
AG Grid, MUI X, Handsontable, Glide, RevoGrid, react-window, TanStack Virtual, FullCalendar,
DHTMLX, Toast UI, Syncfusion, React Big Calendar, tldraw, Atlassian Pragmatic DnD, dnd-kit,
Mozilla Bespin/Ace) overturned it. The evidence is recorded in §1 and in the accompanying ADR.

Divergence is complete (two full ADHD runs plus four empirical research agents). This document
converges. It does not re-open the direction.

---

## 0. Success predicate and non-goals

**Success predicate (observable, testable):**

1. The group, day, activity, and manual-build schedule views render from a single CSS Grid
   container. No `<table>`, `<tr>`, `<td>`, or `rowSpan` attribute remains in the four schedule
   grid components.
2. A multi-block activity, anchor, or overlay occupies one DOM element whose height equals the
   sum of the tracks it covers, with no separate elements rendered for the blocks it covers.
3. Collapsing a period changes only the collapsed row's track height and that row's cells'
   content presentation. **No cell content overflows its box, at any period, in any view.**
   (Verifiable: `scrollHeight <= clientHeight` for every cell in the collapsed state.)
4. A cell whose activity name is longer than its column width **grows the row** rather than
   clipping. (Verifiable: zero cells with `scrollWidth > clientWidth`.)
5. A drag gesture distinguishes click from drag through one explicit state machine with a named
   undecided state; no boolean drag flags remain scattered across component files.
6. Screen-reader navigation reports row/column position and the span extent of merged cells.
7. Empty cells are visible as faint placeholders, not invisible.

**Non-goals for this work:**

- Virtualization / windowing. 480 cells does not warrant it and this design deliberately
  forecloses it (see §10).
- Canvas or WebGL rendering of any kind.
- Fog-of-row dimming. Deferred by product owner decision; product owner wants to test without it.
- Special-event (T40) arbitrary timings. Special-event days get their own view (§10).
- Retheming to the design-system spec. Out of scope; this work must not regress it either.

---

## 1. Rendering layer — CSS Grid

**Decision: the schedule grid is one CSS Grid container. Every slot, overlay, row header, and
empty placeholder is a direct grid child placed with explicit
`grid-row: <n> / span <rowSpan>` and `grid-column: <n> / span <colSpan>`.**

```
.grid {
  display: grid;
  grid-template-columns: <rowHeaderWidth> repeat(<dayCount>, minmax(<colFloor>, 1fr));
  grid-template-rows: var(--grid-rows);
  gap: 4px;
}
/* a cell */
style={{ gridRow: `${blockIndex + 1} / span ${rowSpan}`, gridColumn: `${dayIndex + 2} / span ${colSpan}` }}
```

Row track sizing, collapse, and density are expressed entirely by the `--grid-rows` string
(§4). Spanning is expressed by `span N` (§3). Nothing computes pixel coordinates in JavaScript.

### Why the table lost

The table is not *broken* — measured collapse cost was 7.1 ms (table, full re-render) vs 3.9 ms
(grid, one custom property), and 60 drag frames measured 2.9 / 4.0 / 4.6 ms across the three
mockups: **no meaningful difference.** There is no performance problem to solve here. The table
loses on structure, not speed:

- **Real HTML `rowSpan` is avoided industry-wide.** Of the data grids surveyed, only Handsontable
  uses it, and only because it kept a `<table>`. Its documented costs: spans clamped to the render
  window, scroll degradation on large spans, merges auto-split on move/freeze, and a ~130 KB plugin
  because merging leaks into coordinate translation, selection, and focus order.
- **AG Grid and MUI X independently reinvented `grid-row: span N` by hand.** Both render the
  spanning cell once at a computed height and suppress the cells it covers — AG Grid in a dedicated
  `rendering/spanning/` layer, MUI X via `calc(var(--height) * ${rowSpan})` + `zIndex: 10` with
  covered cells returning `null`. Glide declined row spanning entirely; RevoGrid paywalled it.
  **`grid-row: span N` is the native expression of exactly the pattern those teams hand-built.**
- **Collapse is structurally wrong in a table.** In a table, row height, cell box, and content are
  one thing. Collapsing forces a full relayout of the table and, in our own mockup, a full
  re-render. The grid separates track geometry from content presentation, which is the correct
  factoring (§2).
- **Timing.** CSS Grid did not exist when these libraries chose their models. FullCalendar's v7
  rewrite moved *toward* modern CSS — "removed nested `<table>`s in favor of Flexbox" — with
  documented results of less layout thrashing, a 2× rendering gain, and accessibility "maintained
  and even improved."

### Why canvas lost (decisively)

- 480 cells is 3–4 orders of magnitude below where canvas pays off: below Lighthouse's ~800-node
  warning, below AG Grid's 500-rendered-row cap, and not enough to warrant virtualization at all.
- The mechanism canvas fixes is **DOM element mount/unmount churn per scroll frame**. We have zero
  churn — nothing recycles.
- Daniel Imms, author of *both* the VS Code canvas and the WebGL terminal renderers: *"Start out
  with virtualizing the DOM so only the visible parts are showing, if the framerate isn't
  acceptable after that then consider switching to canvas."* We have not needed step one. Also
  Imms: *"Supporting screen readers will probably also negate the benefits of using canvas to
  begin with since you need to maintain the DOM structure anyway."*
- The canvas cost ledger is paid in full regardless of grid size: a parallel accessibility DOM,
  custom cursor and selection, custom hit-testing, IME/RTL regression risk, loss of Ctrl+F (Glide
  had to ship its own search), a `measureText` cache with font-load invalidation, and DevTools
  inspection breaking.
- Monaco/VS Code — the closest structural analogue (grid of cells with selections, highlights, and
  decorations) — uses layered absolutely-positioned DOM. VS Code reserves canvas for exactly one
  thing: the minimap.
- Mozilla Bespin is the documented case of a team **abandoning** canvas after Ace proved DOM was
  equally fast.

**Rejected.** The prior revision's canvas ambient layer, its rAF paint loop, its
`computeCellRects` + `ResizeObserver` geometry oracle, and its `--grid-*` CSS-custom-property
state bus are all withdrawn along with it.

### Why absolute positioning lost

Absolute positioning *is* the dominant data-grid pattern (AG Grid, MUI X, RevoGrid, react-window
v2, TanStack Virtual — 5 of 7 surveyed), and calendars use it unanimously. Both rationales are
inapplicable to us:

- The data-grid rationale is **virtualization-specific**. bvaughn's stated reason is that spacer
  padding cannot go negative, which breaks scroll anchoring when a rendered item differs from its
  estimate. That is a correctness argument for windowing. We do not window.
  (The widely repeated "avoids layout thrash" justification does **not** appear in the primary
  sources. Treat it as folklore; do not cite it.)
- The calendar rationale is **continuous time**. FullCalendar, Google Calendar, DHTMLX, Syncfusion,
  Toast UI, and React Big Calendar place events at arbitrary start instants with arbitrary
  durations — an event genuinely cannot be a cell. Our lattice is discrete and uniform, and the
  one case that would have introduced continuous time (special events, T40) has been ruled out by
  product decision: special-event days get their own view (§10).
- **Decisive flaw, verified in a working mockup:** an absolutely-positioned box cannot size to its
  content. With a long activity name, the absolute mockup clipped 3 cells; the grid mockup clipped
  0. This is precisely why FullCalendar needs `eventMinHeight` / `eventShortHeight` /
  `eventMaxStack` / "+N more" and Syncfusion needs `maxEventsPerRow`. Given that T41 (elective
  scheduling) will put several activities into one period, **a cell that cannot size to its
  content is the wrong foundation.**

---

## 2. Collapse — the open problem, solved

This is the one thing the product owner flagged as unresolved: CSS Grid is the best option, *but*
its collapsing behavior was worse than the table's, and the table mockup has the right feel.

### Diagnosis (verified against the mockups)

- **Table mockup** (`1-table-rowspan.html:60-61`): collapse styles the **cell** —
  `.cell.collapsed { min-height:14px; height:14px; padding:0 11px; overflow:hidden }` plus
  `.cell.collapsed .nm { font-size:9px; opacity:.5 }`. It reads as a folded strip that still tells
  you what is in it.
- **First CSS Grid pass** (`3-css-grid.html`, before revision): collapse changed **only the track**
  (`grid-template-rows` sets that row to `14px`). The cell kept `padding: 9px 11px` and 12 px type,
  so 12 px content sat in a 14 px box and looked broken.

### The insight

**Collapse is two concerns, not one:**

| Concern | Owner | Mechanism |
|---|---|---|
| **Track geometry** — how tall is the row | The grid container | the `--grid-rows` track list |
| **Content presentation** — what the cell shows at that height | The cell | a `collapsed` presentation state on the cell |

The table conflated them because table cells are content-sized: shrinking the content shrank the
row, so one rule appeared to do both. **CSS Grid separates them cleanly, which is better** — it is
why collapse costs one property write instead of a full re-render — but it means the collapsed
*content* state must be authored explicitly rather than falling out for free.

That is the entire bug. It is not a CSS Grid limitation; it is one missing half of a two-part
contract.

### The design

**One state, two effects, one write.** Collapse is a set of collapsed block ids held in route
state. From it:

1. The grid container's `--grid-rows` gives each collapsed block a fixed `COLLAPSED_TRACK` height
   instead of `minmax(floor, auto)`.
2. The grid container carries `data-collapsed-blocks` (or, simpler and preferred, each cell
   carries `data-collapsed` when its **head** block is collapsed).

Rules — these are the *only* thing that changes about a cell:

```css
.cell[data-collapsed] { padding: 0 11px; justify-content: center; overflow: hidden; }
.cell[data-collapsed] .cell-name { font-size: 9.5px; opacity: .62; letter-spacing: .04em;
                                   white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.cell[data-collapsed] .identity-dot,
.cell[data-collapsed] .flag,
.cell[data-collapsed] .expand-handle { display: none; }
.row-header[data-collapsed] .block-time { display: none; }
.row-header[data-collapsed] .block-name { font-size: 9.5px; opacity: .62; }
```

Note the row header collapses too — the table mockup's version left it out and it read as
misaligned.

**Rules that fall out and must be honored:**

- **A collapsed track must be a fixed length, never `auto`.** `auto` would let content re-expand
  the row and defeat the collapse. `COLLAPSED_TRACK` is a constant (mockup value: `14px`;
  final value is a Designer call — see below).
- **Content in a collapsed cell must be single-line and ellipsized.** The normal cell uses
  `overflow-wrap: anywhere` and wraps (that is what makes §1's "no clipping" property true);
  the collapsed cell must switch to `nowrap` + ellipsis, because a fixed-height box is the one
  place we accept truncation. This is a deliberate, scoped exception to the no-clipping rule.
- **Only the span *head*'s block determines collapsed presentation.** A cell spanning blocks 4–6
  where block 5 is collapsed keeps normal presentation and simply gets shorter — grid sums the
  tracks it covers plus the gaps automatically. This is correct: the activity is not "in" the
  collapsed period exclusively. Do **not** apply `data-collapsed` to it.
- **Collapse must never change what is in the DOM.** The whole gain is that collapse is a style
  write, not a re-render. Collapsed cells stay mounted, keep their handlers, keep their
  accessible names, and remain focusable and drop-targetable.
- **Accessibility:** a collapsed row is *visually* condensed, not hidden. Do not set
  `aria-hidden`, do not remove from the tab order. The row header button that toggles it carries
  `aria-expanded`.

### Designer decisions — RESOLVED 2026-08-06

> **D1, D2 answered by Designer and approved by the product owner, 2026-08-06.**

**D1 — what a collapsed period shows: (a) thin strip with a micro-label, with two modifications.**

1. **Dim with the token, not with `opacity`.** The label is `var(--text-secondary)` at **full
   opacity**. The recessed strip fill, smaller size, and weight 500 carry the "quiet" read.
   Rationale is measured, not stylistic — see D2.
2. **Carry one row-level flag dot.** If *any* cell in the collapsed row is flagged, show a single
   6px dot at the strip's right edge: `var(--danger)` for UNFILLABLE, `var(--accent)` for
   advisory. Identity dots, per-cell flags, and the expand handle are still `display:none`.

   *Why this and not a summary line:* a collapsed row that can hide a conflict turns a scanning
   aid into a scanning hazard. This is the one piece of aggregate information that changes the
   answer to the director's actual question ("is my week done"). It is derivable in the render
   pass that already visits every cell — `cells.some(c => c.flags?.length)` — so it is derived at
   render, never stored, and has **no sync surface**. Activity counts are not carried: the
   director already knows what is in Lunch.

**D2 — `COLLAPSED_TRACK = 20px`.** Not the mockup's `14px`.

Measured WCAG contrast for `--text-secondary #5C6670` on `--bg #F4F3EF`:

| opacity | ratio |
|---|---|
| 0.62 (mockup) | **2.51:1** |
| 0.75 | 3.18:1 |
| 0.85 | 3.86:1 |
| **1.0** | **5.27:1** |

The mockup's `9.5px @ 0.62` is **2.5:1 — below even the 3:1 large-text threshold, at the smallest
type in the app.** No opacity value reaches 4.5:1; only full opacity does. That is why D1 dims by
token rather than `opacity`. At full opacity the label can also be **11px** without shouting, and
11px x 1.4 line-height + 1px borders = 17.4px, which `14px` cannot hold. `20px` clears it.

Cost: +6px per collapsed row against the ~56px a collapse saves. Negligible.

**Accepted deviation — WCAG 2.2 SC 2.5.8 (target size).** A 20px strip is under the 24x24
minimum. **Product owner accepted the Designer's recommendation, 2026-08-06:** the *entire strip*
is the re-expand target (approx. 1000 x 20px, so the shortfall is height-only), and the keyboard
path — `aria-expanded` toggle on the focused row header, Enter/Space — is the equivalent
mechanism required by the exception. Record this as a known, deliberate deviation, not an
oversight. (`24px` was the strictly-conformant alternative and was not chosen.)

**Resolved values:**

```
COLLAPSED_TRACK   = 20px
collapsed label   : 11px / weight 500 / var(--text-secondary) / opacity 1
                    letter-spacing .02em / nowrap + ellipsis / vertically centred
collapsed extras  : identity dot, per-cell flags, expand handle -> display:none
                    ONE row-level flag dot (6px, --danger or --accent) if any cell flagged
row header        : collapses too -- time hidden, name 11px var(--text-secondary)
```

No animation. Collapse is an instant track-height change (consistent with §5.4 and
DESIGN_STANDARD §8).

**Acceptance fixture the mockups did not cover.** Every mockup collapses Block 5 — a single merged
`Lunch` spanning all five days, which is *not* representative. Designer verified the non-merged
case by collapsing Block 2 (five different activities): five separate strips, names centred,
0 of 5 overflowing horizontally or vertically. **Step 3 must test the non-merged collapse case.**

---

## 3. Merged cells — `span N`

**`decideCell` is preserved unchanged.** Its existing four-way return is already exactly the
shape CSS Grid needs; only the consumer changes.

| `decideCell` result | Table behavior (today) | CSS Grid behavior (new) |
|---|---|---|
| `{ kind: 'skip' }` | `return null` — covered by a head's `rowSpan` | `return null` — covered by a head's `grid-row: span N`. **Identical.** |
| `{ kind: 'empty' }` | `<DroppableEmptyCell>` `<td>` | grid child at `span 1`, faint placeholder (§7) |
| `{ kind: 'overlay', overlay, rowSpan }` | `<OverlayCell rowSpan>` | `<OverlayCell>` with `gridRow: \`${r} / span ${rowSpan}\`` |
| `{ kind: 'slot', slot, rowSpan, cellType }` | `<SlotCell rowSpan>` | `<SlotCell>` with `gridRow: \`${r} / span ${rowSpan}\`` |

This is the cleanest part of the migration: **`rowSpan={n}` becomes `gridRow="{r} / span {n}"`,
and `{kind:'skip'} → null` needs no change at all.** The `skip` branch is the very "suppress the
covered cells" mechanism AG Grid and MUI X built by hand; here the browser honors it natively
because grid children are placed, not flowed.

**Column spanning** (`grid-column: ... / span N`) becomes available for free. Nothing uses it
today. Do not build for it — but note that day-view horizontal merges and T41's multi-activity
periods now have a native expression if they are ever specified.

**The one thing that changes:** `<td>` inherits its column from document order; a grid child does
not. **Every cell must now be given an explicit `grid-column`.** Compute it from the day/group
index the view already has in hand. Getting this wrong is silent (cells stack in column 1), so
it is worth one unit test per view asserting the placement string for a known fixture.

---

## 4. Row height

**Decision: `grid-template-rows: repeat(N, minmax(<floor>, auto))`, emitted as a single
`--grid-rows` custom property on the grid container.**

This **replaces the JS row-height formula + `ResizeObserver`** the prior revision proposed.
Row height is now a declarative statement, not a computation:

- `minmax(floor, auto)` says exactly what we mean: never shorter than the floor, as tall as the
  content needs. That is the property that made the grid mockup clip zero cells where the
  absolute mockup clipped three.
- Density modes are the same string with a different floor (mockup: `56px` normal, `34px` dense).
- Collapse is the same string with one track replaced (§2).
- Cost is one custom-property write. Measured 3.9 ms vs 7.1 ms for the table's full re-render.

The string is built by a small pure function, `buildRowTracks({ timeBlocks, collapsedBlockIds,
density })`, unit-testable without a DOM.

**D3 — floor values: RESOLVED 2026-08-06.** `ROW_FLOOR_NORMAL = 48px`,
`ROW_FLOOR_COMPACT = 40px`.

Measured at 1500x800 in a 692px scroll pane, all 11 blocks, real Adom 4's data:

| floor | grid height | fits without scroll | cells clipped |
|---|---|---|---|
| 56px (mockup) | 656px | barely | 0 |
| **48px** | **568px** | yes, ~120px headroom | 0 |
| 44px | 524px | yes | 0 |
| **40px** | **483px** | yes | 0 |
| 34px (mockup "dense") | **483px** | yes | 0 |

`56px` fits only a generous window; on a 13" MacBook the Electron scroll pane is nearer 600px and
`656px` scrolls. `48px` puts the whole week on screen, which is the property the director needs,
and still holds a 12px name at line-height 1.5 plus 9px padding top and bottom plus borders, with
slack for the identity dot and corner flags — the floor is doing real work, not just tracking
content.

**Finding: `34px` is inert.** Rows at 40px and 34px render *identically* (483px). Below ~40px the
floor stops binding and the **row header** becomes the constraint — it stacks block name (12px/600)
over time (9.5px mono), about 32px of content plus padding. Nothing in the cells sets this. The
mockup's density toggle was measuring a change it was not making. **Compact ships at 40px**, a
real 568 -> 483px gain (~15%).

**Do not go denser in T50.** Below 40px requires restacking the row header onto one line, which is
a separate visual change with its own scanning cost. That is the recorded reason compact bottoms
out at 40px.

---

## 5. Interaction layer — drag

The drag findings are validated and carried forward from the prior revision's research, with the
Atlassian reversal added. This section is largely *preserved*, not rewritten.

### 5.1 Never HTML5 native drag-and-drop

Across every product surveyed, native HTML5 DnD appears in exactly one role: **accepting drops
from outside the application.** Reasons: no touch support, no screen-reader signaling, and
uncontrollable drag-preview styling. Not used for in-grid movement, ever.

### 5.2 One explicit state machine with a named undecided state

**Decision: `src/screens/schedule/dragFSM.js` — a pure
`transition(state, event) → { nextState, sideEffects }`.**

States: `Idle → Pointing → Dragging → Resolving → Idle`.

- **`Pointing` is the formal home of click-vs-drag ambiguity.** This is tldraw's
  `Idle → Pointing → Dragging`. Today that ambiguity is implicit in dnd-kit's `distance: 8`
  constraint and in scattered flags (`isExpandDragActive`, `isGroupExpandDragActive`,
  `isDayExpandDragActive`, `fillState`). Naming it is the point.
- **`Resolving`** = pointer released over a valid target, mutation not yet committed. It exists
  because our commits are op-log writes that can fail, and the UI must have one place to express
  "in flight."
- FullCalendar splits the same problem three ways — `PointerDragging` (input normalization) /
  `FeaturefulElementDragging` (threshold, delay, autoscroll, mirror) / `HitDragging`
  (`initialHit` / `movingHit` / `finalHit`). We adopt the *hit* vocabulary in the FSM's context
  payload but keep one machine; three machines is more structure than four drag kinds need.
- **No data grid surveyed uses an FSM** — AG Grid, Handsontable, RevoGrid, and Glide all use ad-hoc
  nullable flags scattered across files. We would be ahead of that field, not behind it.

The FSM covers all four existing drag kinds: slot move, palette drop, expand/extend drag, and
overlay fill drag. Its state × event table is exhaustive and unit tested before any component
consumes it.

### 5.3 @dnd-kit — retained, with its per-cell droppables removed

**Retain @dnd-kit as the sensor and input-normalization layer.** It already handles pointer/touch
sensor differences, keyboard sensors, and the activation constraint. Replacing it with raw
`setPointerCapture` is risk without benefit at this scale.

**But remove `useDroppable` from individual cells.** Today `DroppableEmptyCell` and `SlotCell`
each subscribe to dnd-kit's collision detection, which is the actual source of per-pointer-event
React work — up to 480 subscribers evaluating `isOver`. Replace with **one droppable on the grid
container** plus our own pointer→cell resolution:

```js
const cellEl = document.elementFromPoint(x, y)?.closest('[data-cell-key]')
```

This is FullCalendar's `HitDragging` pattern (resolve a hit from pointer coordinates against the
grid, rather than registering every cell as a target). It is cheaper, it is the only way to
implement `closest-edge` (§5.5), and it removes 480 subscriptions.

### 5.4 Static drop feedback, not animated placement

**Atlassian's published reversal is binding guidance here.** They replaced `react-beautiful-dnd`
because animated placement feedback made interfaces feel **sluggish** — users had to wait for
animations to finish before they could read intent. Their replacement uses *"lines, borders and
background color changes,"* and they state *"a lack of animations helps make the interface feel
snappy."*
(Source: https://www.atlassian.com/blog/design/designed-for-delight-built-for-performance)

**Therefore: no animated reflow of cells during drag. No cells sliding to make room.** Drop
feedback is a static border/line/background change on the target.

### 5.5 Drag preview and drop indicator are two separate concerns

Per Atlassian's separation:

- **Drag preview** — follows the pointer, represents *what* is moving. A distinct ghost element
  beats dimming in place (3 of 5 calendars surveyed use a distinct ghost).
- **Drop indicator** — static, marks *where* it lands. Never follows the pointer.

**Hit detection: `closest-edge`** (Atlassian's named pattern,
`@atlaskit/pragmatic-drag-and-drop-hitbox`). Given the resolved cell and the pointer position
within its rect, decide which edge the drop attaches to. This is what makes "insert above block 4"
distinguishable from "replace block 4" without a modifier key.

### 5.6 Activation distance

`distance: 8` is on the deliberate end of the range: Windows uses 4 px, Unity 5 px, dnd-kit
defaults to 5 px and varies by input modality (250 ms delay + 5 px on touch; **zero constraint
when dragging an explicit handle**). Recommend reviewing down to 5 px and applying zero constraint
to the expand handle, which is an explicit handle. Low stakes, easily reversed; not a blocker.

---

## 6. Styling constraint — APPROVED 2026-08-06

> **Decision: APPROVED by the product owner, 2026-08-06.** The rule is relaxed exactly as scoped
> below — one stylesheet, `src/components/schedule/scheduleGrid.css`, covering the grid container,
> cell interaction pseudo-states, and cell data-attribute states. Everything listed under *What
> stays inline* stays inline. This relaxation does not extend beyond
> `src/components/schedule/`. `CLAUDE.md` and `TARGET_ARCHITECTURE.md` must be corrected in
> migration Step 6 to state the actual convention rather than the false one.


### The finding

The "inline styles only, no CSS files" rule **has no recorded rationale**, and is **already
false**:

- Earliest appearance — historical origin only, not current guidance:
  `docs/archive/completed-plans/2026-05-23-shoresh-ui-redesign.md` (archived, superseded), as a
  tech-stack line — "React 19, Vite 8, inline styles, src/styles/shared.js for shared tokens."
  A starting choice, never argued.
- `CLAUDE.md` states it as fact with no justification.
- `docs/work/architecture-reports/TARGET_ARCHITECTURE.md:39` promotes it to "load-bearing"
  alongside genuinely load-bearing decisions (op-log-everything, pure engine, hard IPC seam) with
  no supporting argument.
- `src/index.css` (44 lines) and `src/App.css` (184 lines) exist. `src/index.css` defines
  `--primary` and the entire design token set. The constitution itself refers to "the app's live
  stylesheet."

The operative convention is narrower than the stated rule: **global tokens live in CSS; component
styles are inline objects.**

### The cost, and why it lands on this work specifically

Without a stylesheet there is **no `:hover`, no attribute selectors, and no `:has()`.** That is
exactly why `SlotCell` today carries `onPointerEnter` / `onPointerLeave` + `useState` for hover
(three separate `useState` hovers in one component: `cellHovered`, `splitHovered`,
`reasonFocused`), and it is why the prior revision invented a canvas + rAF loop to escape the
React re-renders those handlers cause. **The rAF loop existed to work around a styling
convention.**

It also has a recorded cost outside this work: the design-system spec is defined but unapplied,
and the recorded blocker is a "hardcoded-color migration surface" — the predictable result of
hundreds of style objects each holding their own values.

The collapse design in §2 is written as attribute-selector CSS for a reason: expressed as inline
styles it becomes a per-cell conditional in four view components, and collapse stops being "one
property write" — the thing that made it 3.9 ms instead of 7.1 ms.

### Recommendation

**Relax the rule, narrowly. Add exactly one scoped stylesheet:
`src/components/schedule/scheduleGrid.css`.** Confidence: high.

**What moves into it (and nothing else):**

- The grid container rules (`display: grid`, `grid-template-columns`, `gap`).
- Cell **interaction pseudo-states**: `:hover`, `:focus-visible`, `:active`.
- Cell **data-attribute states**: `[data-collapsed]`, `[data-drag-over]`, `[data-selected]`,
  `[data-drop-edge="top|bottom"]`, `[data-flagged]`, `[data-empty]`.
- Static structural cell styling: padding, radius, border, the name/flag/dot layout.

**What stays inline (unchanged):**

- **All per-cell computed geometry** — `gridRow`, `gridColumn`. These are data, not style; they
  belong with the element that computes them.
- Per-cell data-derived values: activity color, flag color.
- **Every component outside `src/components/schedule/`.** This relaxation is scoped to the grid.
- `src/styles/shared.js` remains the shared-token module for inline objects.

**Why this and not more:** the argument for CSS here is specific and mechanical — pseudo-classes
and attribute selectors do not exist in inline styles, and their absence is currently paid for
with React state and re-renders. That argument applies to interaction states on a dense repeated
element. It does not generalize to "convert the app to CSS," and this spec does not propose that.
Smallest responsible change: one file, one directory, one stated reason.

**What this deletes:** `SlotCell`'s `cellHovered` / `splitHovered` `useState` pairs and their
`onPointerEnter` / `onPointerLeave` handlers; `DroppableEmptyCell`'s `isOver`-driven inline
background; and the entire need for the prior revision's rAF/canvas machinery.

**If the product owner declines this**, the design still works — collapse and spanning are
unaffected, because they are driven by the `--grid-rows` custom property and inline `gridRow`,
both of which are legal inline. Only §7's state propagation gets worse: hover and drag-over
return to React state, and cell counts of 480 make that measurably slower during gesture. It is a
degradation, not a blocker.

---

## 7. Visual state propagation

Given §6's recommendation, ephemeral visual state propagates as **data attributes on cells plus
CSS custom properties on the grid container.** No React state, no rAF loop, no canvas.

| State | Carrier | Written by |
|---|---|---|
| hover | `:hover` | the browser — no JS at all |
| focus ring | `:focus-visible` | the browser |
| collapsed | `data-collapsed` on cell + `--grid-rows` on container | route state, one render |
| density | `--grid-rows` on container | route state, one render |
| drag-over target | `data-drag-over` on one cell | FSM side effect, direct DOM write |
| drop edge | `data-drop-edge="top\|bottom"` on one cell | FSM side effect (`closest-edge`) |
| selection | `data-selected` on cells | React render (selection is committed state, not gesture) |
| flag highlight | `data-flagged` + inline highlight color | React render (data-derived) |
| empty placeholder | `data-empty` | React render (data-derived) |

**The rule:** state that changes *during a gesture* (drag-over, drop edge) is written directly to
the DOM by an FSM side effect — one `setAttribute` on one element, plus one removal on the
previous element. State that changes *on commit* (selection, flags, collapse, data) goes through
React normally. Hover and focus never touch JS.

This is the same "don't re-render 480 cells to tint one" goal the prior revision pursued with
canvas, achieved with two `setAttribute` calls instead of a parallel rendering system.

**Empty cells show a faint placeholder** (product owner decision): `data-empty` cells render a
dashed border and a dimmed label rather than nothing. Not invisible.

---

## 8. Accessibility — in scope

**Decision: keep real ARIA row structure using `display: contents` row wrappers.**

CSS Grid places children on the container's tracks, so grid items must be direct children — which
naively means there is no `<tr>`-equivalent element, and `role="grid"` requires rows. The
resolution:

```jsx
<div role="grid" className="schedule-grid" style={{ '--grid-rows': tracks }}>
  <div role="row" style={{ display: 'contents' }} aria-rowindex={n}>
    <div role="gridcell" aria-colindex={c} aria-rowspan={rowSpan} style={{ gridRow, gridColumn }}>
```

`display: contents` on the row wrapper removes only the box, so its children become direct grid
items and placement works, while the element **keeps its `role="row"` in the accessibility tree**.
This is the TanStack pattern (semantic structure retained; only the layout algorithm discarded).
Spanning cells carry `aria-rowspan` / `aria-colspan`, which is the ARIA-native expression of §3.

**`display: contents` has had documented browser accessibility bugs** (elements dropped from the
a11y tree). Those were fixed in Chromium ~89; this app ships Electron 43 (Chromium ~14x), so it
should be sound — **but this must be verified, not assumed.** Migration Step 2 carries an explicit
acceptance gate: inspect the rendered accessibility tree (Chromium DevTools *Accessibility* pane)
and confirm `grid → row → gridcell` structure with correct `aria-rowindex`/`aria-colindex`.

**Fallback if verification fails:** drop the wrapper and use `role="grid"` with
`aria-rowindex`/`aria-colindex` on every cell and no row elements. This is technically
non-conforming ARIA ownership but is announced correctly by current screen readers. Only take this
path on evidence.

**Also in scope (not deferred):**

- Keyboard grid navigation (arrow keys move focus between cells; roving `tabindex`).
- Accessible name per cell including its span extent ("Swimming, blocks 4 to 5, Tuesday").
- A collapsed row remains focusable and is not `aria-hidden` (§2).
- The row-header collapse toggle carries `aria-expanded`.
- Drag has a keyboard path via dnd-kit's keyboard sensor, with `aria-live` announcements for
  pick-up, move, and drop. This is a concrete reason @dnd-kit is retained (§5.3).

---

## 9. Module boundaries

### Preserved unchanged

- **`src/screens/schedule/gridGeometry.js` — the entire file survives.** This is the single
  largest reuse in the migration. It computes spans, tails, and overlay extents from data with no
  DOM dependency, which is precisely why it transfers: `rowSpan` was never a table concept in this
  module, it was always a number. The surviving surface is exact:
  - `getSlot`, `isAnchorTail`, `getAnchorRowSpan`, `isActivityTail`, `getActivityRowSpan`,
    `overlayForCell`, `isOverlayHead`, `getOverlayRowSpan`
  - `makeGridGeometry({ slots, timeBlocks, groups, overlays, fillState })` — unchanged signature
  - `decideCell(geometry, groupId, dayId, blockId)` — unchanged signature and unchanged four-way
    return, including `{ kind: 'skip' }` (§3)
  - `gridGeometry.test.js` passes untouched. If it does not, the migration has changed semantics
    it was not supposed to change.
- `src/engine/buildSchedule.js`, all `use*` hooks in `src/screens/schedule/`, all repository and
  IPC layers: zero changes. This is a rendering change only.

### New

- `src/screens/schedule/gridTracks.js` — `buildRowTracks({ timeBlocks, collapsedBlockIds,
  density })` → the `--grid-rows` string. Pure, unit tested, no DOM.
- `src/screens/schedule/gridPlacement.js` — `placeCell({ blockIndex, columnIndex, rowSpan,
  colSpan })` → `{ gridRow, gridColumn }`. Pure, unit tested. Exists so the four views cannot
  disagree about the off-by-one (`blockIndex + 1`, `columnIndex + 2`).
- `src/screens/schedule/dragFSM.js` — `transition(state, event)`, pure, exhaustively tested (§5.2).
- `src/screens/schedule/useDragFSM.js` — binds the FSM to @dnd-kit sensors and applies the
  DOM-attribute side effects (§7).
- `src/screens/schedule/closestEdge.js` — `closestEdge(rect, point)` → `'top' | 'bottom'`. Pure.
- `src/components/schedule/scheduleGrid.css` — the scoped stylesheet (§6), **conditional on the
  product owner accepting the §6 recommendation.**

### Changed

- `ScheduleGroupView.jsx`, `ScheduleDayView.jsx`, `ScheduleActivityView.jsx`,
  `ManualBuildView.jsx` — `<table>/<tr>/<td>` → grid container + `display:contents` rows + placed
  cells. `decideCell` call sites unchanged.
- `SlotCell.jsx` — `<td rowSpan>` → `<div role="gridcell" style={{gridRow, gridColumn}}>`; hover
  `useState` deleted in favor of `:hover`; `DroppableEmptyCell`'s `useDroppable` removed.
- `OverlayCell.jsx` — same transformation.
- `slotCellConstants.js` — `cellTd` / `emptyTd` inline objects retire into the stylesheet (or are
  renamed off the `Td` suffix if §6 is declined).
- `dragHandlers.js` — `makeDragHandlers` becomes a thin adapter over `dragFSM`; the scattered
  `isExpandDragActive` / `isGroupExpandDragActive` / `isDayExpandDragActive` flags in
  `ScheduleScreen.jsx` are deleted in favor of FSM state.

### Deleted / never built

Everything the prior revision proposed and nothing else: the `<canvas>` layer, the rAF paint loop,
`computeCellRects` + `ResizeObserver`, the `--grid-*` state-bus custom properties, the JS
row-height formula, and the "React must never write background-color" style-ownership contract
(unnecessary once there is no second renderer to conflict with). None of this was implemented, so
this is a deletion from the design, not from the codebase.

---

## 10. Migration path

Each step is independently shippable with a success predicate. **Do not start Step 1 until D1–D3
(§2, §4) are answered and §6 is decided.**

**Step 0 — decisions. ✅ COMPLETE 2026-08-06.**
- §6 stylesheet relaxation — **APPROVED** by product owner.
- D1 collapsed content — **RESOLVED**: thin strip, token-dimmed label, one row-level flag dot.
- D2 `COLLAPSED_TRACK` — **RESOLVED**: `20px`, with an accepted WCAG 2.5.8 target-size deviation.
- D3 row floors — **RESOLVED**: `48px` normal, `40px` compact (`34px` proved inert).
*Predicate met: three values and one yes/no recorded in this document.*

**Out of scope, split to its own ticket:** `ACTIVITY_COLORS` tokenization. It is the only
remaining hardcoded colour in `src/components/schedule/` (verified 2026-08-06: `ANCHOR_COLOR` and
`FLAG_COLORS` are already token-backed, despite DESIGN_STANDARD's stale note to the contrary).
T50 edits those files but does not retheme them. See `docs/work/tickets/T52-activity-colors-tokenization.md`.

**Step 1 — pure modules, no UI change.** Add `gridTracks.js`, `gridPlacement.js`,
`closestEdge.js`, `dragFSM.js` with tests. Nothing imports them yet.
*Predicate: new unit tests pass; app is byte-identical at runtime; `gridGeometry.test.js` untouched
and green.*

**Step 2 — convert ONE view: `ScheduleGroupView`.** It is the simplest (one group × days × blocks),
and it exercises spanning, overlays, and empty cells. Table → grid, with `role`/`display:contents`
structure and the stylesheet.
*Predicate: (a) visual parity screenshot vs. today; (b) zero cells with `scrollWidth >
clientWidth`; (c) accessibility tree shows `grid → row → gridcell` with correct indices — **this is
the `display:contents` verification gate (§8)**; (d) existing group-view interactions all work.*

**Step 3 — collapse.** Implement §2 in the converted group view only.
*Predicate: collapse toggle writes one custom property + one attribute; zero cells with
`scrollHeight > clientHeight` in the collapsed state; a cell spanning across the collapsed block
shortens without changing presentation.*

**Step 4 — convert the remaining three views.** `ScheduleDayView`, `ScheduleActivityView`,
`ManualBuildView`.
*Predicate: no `<table>` remains under `src/components/schedule/`; per-view placement unit tests
pass; visual parity on each.*

**Step 5 — drag FSM cutover.** Replace `dragHandlers` internals and delete the scattered boolean
flags. Add `closest-edge` drop indicator and the distinct drag preview. Remove per-cell
`useDroppable`.
*Predicate: all four drag kinds (slot move, palette drop, expand, overlay fill) work; no boolean
drag flag remains in `ScheduleScreen.jsx`; keyboard drag announces via `aria-live`; no animated
cell reflow during drag.*

**Step 6 — cleanup.** Delete `cellTd`/`emptyTd` remnants and any dead style constants. Update
`CLAUDE.md` and `TARGET_ARCHITECTURE.md` to state the actual styling convention (§6) rather than
the false one.
*Predicate: no dead exports; docs match code.*

---

## 11. What this design is NOT

- **Not virtualization.** CSS Grid places every child; windowing would require explicit `grid-row`
  per rendered item and a spacer strategy. At 480 cells that is three orders of magnitude from
  mattering. This design deliberately forecloses it. If a camp ever needs it, that is a rewrite,
  and it should be a rewrite made against measured evidence, not anticipated.
- **Not a canvas or WebGL renderer**, and not a "hybrid DOM + canvas ambient layer." §1 records
  why, at length, so this does not get relitigated.
- **Not continuous time.** The lattice is discrete and uniform. Special events (T40) get their own
  view; the weekly lattice does not bend to accommodate arbitrary timings. A note on the printout
  is an acceptable workaround. **This product decision is what removes the one genuine risk CSS
  Grid carried** — record it as load-bearing: if special events were ever forced back into this
  grid, the rendering primitive choice would have to be re-examined.
- **Not fog-of-row.** Deferred by product owner decision; the product owner wants to test without
  it first. Do not implement it speculatively.
- **Not a general grid abstraction.** Four views share `gridGeometry`, `gridTracks`, and
  `gridPlacement`. They do not share a component. Four similar views is better than a premature
  grid framework.
- **Not a retheme.** The design-system spec remains defined-but-unapplied. This work must not
  regress it, and §6 makes applying it easier later, but applying it is a separate task.
- **Not a performance fix.** There was no performance problem: 60 drag frames measured 2.9 / 4.0 /
  4.6 ms across the three mockups. This is a structural change that makes collapse, spanning,
  content-sizing, and accessibility correct and cheap to reason about.
