---
document_type: spec
status: active
created: 2026-08-20
title: T92 — Manual Merge/Span Discoverability
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md, docs/work/tickets/T92-manual-generation-cannot-merge.md]
archive_when: the redesigned merge/split affordance ships on the Manual Build route and a director can discover it without being told (Maker implementation merged + Tester confirms discoverability)
---

# T92 — Manual Merge/Span Discoverability — Design Spec

## Root cause (confirmed against current code)

The capability is not just present, it is **doubled**. Two independent, fully-wired affordances
already exist on every occupied, unlocked, non-anchor cell in `SlotCell.jsx`, and **both are
invisible until hover**:

1. **`.cell-action`** (line ~327) — a 16×16px button, top-right corner, `↕` glyph, `visibility:
   hidden; opacity: 0` until `.cell:hover`. Click-driven: calls `onMergeDown` / `onSplitSlot`
   directly.
2. **`.expand-handle`** (`ExpandHandle`, line 14) — a 10px drag strip along the cell's bottom
   edge, `visibility: hidden; opacity: 0` until `.cell:hover`. Drag-driven: a real `useDraggable`
   wired through `useDragFSM.js` (`DRAG_KINDS.EXPAND_DRAG`) and `dragHandlers.js`, fully
   functional in both group and day views.

Both do the same job (extend the activity into the next block) through different gestures, both
require a mouse hover a non-technical director has no reason to attempt, and neither has any
persistent visual trace on the cell. This is why the capability reads as "doesn't exist" — nothing
on screen suggests a cell *can* grow.

**This spec keeps exactly one of the two mechanisms and makes it permanently, quietly visible.**
The other is removed. Shipping both a fixed-visible click affordance *and* a fixed-visible drag
affordance on the same edge would double the chrome this ticket exists to avoid; discoverability
and restraint both point at consolidation, not addition.

## Options considered

**Option A — Keep `.expand-handle` (drag), remove `.cell-action` (click).**
Pro: drag-to-extend is consistent with how everything else on this grid works (drag activities
from the palette, drag to move a placed activity) — a director already has the mental model
"things on this grid respond to drag." Con: a drag-only affordance is harder to discover than a
click target even when visible, and it has no keyboard equivalent of its own (relies entirely on
dnd-kit's keyboard sensor, which is a real path but a less obvious one to first-time users than
Enter).

**Option B — Keep `.cell-action` (click), remove `.expand-handle` (drag).**
Pro: a click target with a label is the most discoverable primitive there is — no gesture to
learn, works identically for mouse, touch, and keyboard (Enter/Space on a focused button), and
needs no new interaction the grid doesn't already have elsewhere (the row-header collapse toggle
is already a plain click button). Con: breaks pattern with the palette's drag-based placement —
though extending a cell is conceptually closer to "editing this cell's state" than to "moving
an activity," so the mismatch is minor.

**Option C — Keep both, make both visible.**
Rejected outright. Two controls doing the same thing, permanently visible on every occupied cell,
is exactly the clutter §1 of the Design Standard forbids ("everything else supports the grid" —
here two things would compete for the same 4px of corner). Not viable.

## Recommendation: **Option B** — keep the click button, remove the drag handle, redesign the button

**Rationale.** Discoverability is the entire point of this ticket. A labeled, always-visible click
target is legible at a glance without any gesture literacy; a drag handle — even fully visible —
still requires the director to *try* dragging it, which is exactly the hover-then-guess behavior
that produced the original bug report. Click also gives free parity across mouse, touch, and
keyboard with zero extra work, where drag needs its own accessible fallback regardless. The grid
already teaches "click a cell to act on it" (inline editor, row-header toggle); this extends that
vocabulary rather than adding a second one.

Confidence: high on "consolidate to one mechanism," high on "click over drag" for this specific
audience (non-technical director, keyboard/SR must work, DESIGN_STANDARD explicitly favors
click/button patterns for discoverable actions elsewhere in the grid).

---

## DESIGN SPEC

### Layout

- `SlotCell.jsx`: delete the `ExpandHandle` component (lines 14–37) and its render call
  (`showExpandHandle` / lines 141–142, 382–389). Delete the corresponding `.expand-handle` /
  `.expand-glyph*` rules in `scheduleGrid.css` (lines 384–447) and the `data-dragging` prop plumbing
  tied to it.
- Delete the now-dead `EXPAND_DRAG` drag kind path (`useDragFSM.js`, `dragHandlers.js`,
  `dragHandlers.test.js`, `dragFSM.test.js` references) — Maker's job to confirm nothing else
  depends on it; this spec only mandates the UI-facing removal, not the drag-plumbing cleanup,
  but flags it so Maker doesn't leave dead code behind (see Implementation Notes).
- The remaining `.cell-action` merge/split button keeps its position (top-right, `top: 4px; right:
  4px`, 16×16px) — that slot is uncontested once the OVERLAP dot (also top-right, `top: 6px; right:
  6px`, `identity-dot`-scale) is accounted for; they don't collide because merge/split only shows
  on occupied cells while OVERLAP already coexists with `.flag--unfillable` at the same corner
  today via the current 4px/6px offset stacking. No new corner is introduced.

### Visual style

**The button becomes permanently visible but stays quiet — a hairline glyph, not a filled icon,
until interacted with.** This is the crux of "discoverable without cluttering":

- **Default (idle) state** — always rendered, no hover required:
  - `width: 16px; height: 16px; border-radius: 4px`
  - `border: 1px solid var(--border)`
  - `background: var(--surface)` (matches cell, not `--surface-elevated` — stays recessive)
  - Glyph: a two-line "expand" chevron pair (▾▾ stacked, or a simple `⋮⋮`-style double-chevron —
    see Icon below), `color: var(--text-secondary)`, `stroke-width: 1.5` per §1's icon rule
  - `opacity: 0.55` at rest — present but not shouting; visible enough that a director scanning
    the cell notices *something* is there, quiet enough not to compete with the activity name
  - Position unchanged: `top: 4px; right: 4px`
- **Hover / focus-visible state:**
  - `opacity: 1`
  - `border-color: var(--primary)`
  - `background: color-mix(in srgb, var(--primary) 8%, var(--surface))`
  - glyph color → `var(--primary)`
  - transition: `all var(--motion-fast) var(--ease-out)` (140ms) — matches existing `.cell-action`
    transition token, just extended to cover opacity/border/background together
- **Split variant** (`isMerged` true): same box, glyph rotates 90° via `transform: rotate(90deg)`
  on the SVG (splits the same double-chevron into a "collapse" reading) rather than swapping to a
  differently-shaped glyph — keeps one icon vocabulary for "this control changes the cell's block
  span" instead of two unrelated icons for merge vs. split. Hover state:
  `border-color: var(--danger)` (destructive-adjacent — matches the existing `.cell-action--split`
  danger-on-hover rule, kept as-is).
- **Disabled/absent:** cells that are locked, anchors, or empty render nothing here — unchanged
  from today (`showExpandHandle`'s gating logic moves onto `.cell-action`'s existing gate, which
  already excludes those cases via `hasMergeDown`/`isMerged`).

### Icon choice — replace bare `↕`

`↕` (a text-node arrow character) is ambiguous — it reads as "move" or "resize" as easily as
"merge," and it renders inconsistently across fonts/OSes since it's a raw glyph, not an SVG.
Replace with a small outline SVG, consistent with `UnfillableIcon`/`OutdoorIcon`'s existing
pattern (12×12, `stroke-width: 1.5`, outline only, `var(--text-secondary)` idle / `var(--primary)`
hover):

- **Merge (idle) icon:** two horizontal chevrons pointing toward each other vertically (▾ over ▴,
  i.e. "pull the next block up into this one") — reads as "extend down" unambiguously once
  labeled, and the shape is symmetric so the 90°-rotate-for-split reading holds up visually.
- Exact path (12×12 viewBox, mirrors `UnfillableIcon`'s construction):
  ```jsx
  function ExpandGlyph({ direction = 'merge' }) {
    return (
      <svg viewBox="0 0 12 12" width={12} height={12} fill="none"
           style={{ display: 'block', transform: direction === 'split' ? 'rotate(90deg)' : undefined }}>
        <path d="M3 4.5 L6 7.2 L9 4.5" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  ```
  A single chevron-down is enough — it does not need to be a double-chevron; simplicity wins here
  and a single stroke reads cleaner at 12px. `currentColor` lets the existing CSS `color` rules
  (idle `var(--text-secondary)`, hover `var(--primary)`/`var(--danger)`) drive it with no extra
  inline style.

### States

| State | Trigger | Visual |
|---|---|---|
| Idle | default, cell occupied + mergeable | 16×16 box, `opacity: 0.55`, `var(--border)` border, chevron-down glyph `var(--text-secondary)` |
| Hover | mouse over the button | `opacity: 1`, `var(--primary)` border + tint, glyph `var(--primary)` |
| Focus-visible | keyboard focus lands on the button | same as hover, plus `outline: 2px solid var(--primary); outline-offset: 1px` (mirrors the cell's own `:focus-visible` treatment so keyboard users get an unambiguous ring on the control itself, not just the cell) |
| Split variant idle | `isMerged` true | same box, chevron rotated 90°, tooltip "Split this back into two periods" (unchanged text) |
| Split variant hover | mouse/focus over split button | `var(--danger)` border + glyph (unchanged from current `.cell-action--split:hover`) |
| Pressed | `:active` | `transform: scale(0.94)` — reuse the existing press pattern already on `.cell-inner`, `--motion-fast` |
| Collapsed row | `data-collapsed` on the cell | hidden — existing rule `.cell[data-collapsed] .cell-action` already covers this, unchanged |
| First-run hint | see Interactions below | one-time bronze pulse ring, `--accent`, on the very first mergeable cell a fresh Manual Build session renders |

### Interactions

1. **Discovery without being told (the ticket's actual ask):** the always-visible idle glyph is
   the primary fix — a director scanning the grid sees a small consistent mark in the same corner
   of every fillable cell and, per the personality's "precise" value, one mark = one meaning once
   they've hovered it once (native `title` tooltip: "Let this activity run into the next period" /
   "Split this back into two periods" — unchanged copy, still correct).
2. **One-time onboarding pulse (additive, not required, but closes the "without being told" bar
   more completely):** on the **first Manual Build session ever** for a camp (a `localStorage` flag
   scoped to the device, e.g. `shoresh:manualMergeHintSeen`, not synced — this is a UI hint, not
   camp data), the first rendered mergeable cell's `.cell-action` gets a single non-looping pulse:
   `box-shadow: 0 0 0 0 → 0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent) → 0 0 0 0`,
   `--motion-settle` (340ms) `--ease-out`, once, on mount. Bronze (`--accent`) is correct here per
   §4 of the standard — this is an "attention, something new here" cue, not a status or a danger.
   Clears the flag on first interaction with any `.cell-action` (click or Enter), not on dismiss
   timeout — the hint should not disappear before it's noticed. Under
   `prefers-reduced-motion: reduce`: no pulse animation; instead a single `2px` bronze outline
   ring around the button for that one render, static.
3. **Click / Enter (mouse, touch, or keyboard on a focused button):** unchanged behavior —
   `onMergeDown` / `onSplitSlot` fire immediately, no confirmation (matches existing pattern; this
   is a fast, reversible action — split immediately un-merges).
4. **Drag is removed entirely** for this affordance. Nothing else on the grid loses drag — placing
   and moving activities are untouched; only the redundant expand-drag path goes away.
5. **Merged cell rendering** (post-T99): the merged span already renders as one spanning cell via
   `rowSpan`/`aria-rowspan` — unchanged by this spec. The split button sits in the same top-right
   corner of that now-taller spanning cell.

### What NOT to change

- Do not touch the Generated route unless it shares this exact component (it does — `SlotCell.jsx`
  is shared; the merge/split button props `hasMergeDown`/`isMerged`/`onMergeDown`/`onSplitSlot`
  flow from whichever view passes them). Since Manual is the only caller currently wiring those
  props (`ManualBuildView.jsx`), the visual change is Manual-only in practice, but if Generated
  ever wires the same props, it inherits the same fixed-visible button — that's correct, not a
  scope violation, because it's the same control on the same shared component.
- Do not add any control to empty cells. `EmptyDropCell` is untouched — its affordance (click to
  place, drag from palette) is a separate, already-legible pattern this ticket doesn't touch.
- Do not add a persistent label/caption near every cell ("this can expand"). The single glyph
  plus the one-time onboarding pulse is the entire discoverability budget for this ticket — a
  text caption on every fillable cell would be the clutter the grid's restraint exists to prevent.
- Do not increase the button's footprint beyond 16×16px or change its corner position — it must
  stay exactly where OVERLAP/UNFILLABLE flags already establish the top-right cluster's scale.
- Do not introduce a second stylesheet or move any of this into inline React style objects outside
  `scheduleGrid.css` — this is squarely inside the `src/components/schedule/` CSS exception already
  granted for cell pseudo-states.
- Do not persist `manualMergeHintSeen` through the op-log or sync — it's local UI chrome, not camp
  data, and must not become a per-device write conflict.

### Animation

| Moment | Trigger | Type | Duration | Values |
|---|---|---|---|---|
| Idle → hover/focus transition | pointer enter / focus-visible | Ease-out crossfade of opacity/border/background | `--motion-fast` (140ms) `--ease-out` | `opacity 0.55→1`, `border-color var(--border)→var(--primary)` (or `--danger)` for split-hover), `background` tint fade-in |
| Press | pointerdown/keydown activation | Scale (pop, not bounce) | `--motion-fast` (140ms) `--ease-out` | `transform: scale(1)→scale(0.94)→scale(1)` — same pattern as existing `.cell-inner` press |
| First-run onboarding pulse | mount, only when `!manualMergeHintSeen`, only on the first mergeable cell | Settle (single pulse, no loop, no bounce) | `--motion-settle` (340ms) `--ease-out` | `box-shadow: 0 0 0 0 rgba(accent,0) → 0 0 0 4px color-mix(accent 30%) → 0 0 0 0`; single keyframe pass, not `infinite` |
| Split-glyph rotation | `isMerged` toggles true/false | Instant swap (no rotate animation) | n/a | The glyph's `rotate(90deg)` is a state property, not an animated transition — rotating it live would read as spinning/decorative, which §1 forbids; render each state statically |
| Reduced motion | any of the above, `prefers-reduced-motion: reduce` | Crossfade or instant | instant / `--motion-fast` opacity only | Pulse becomes a static ring (no animation); hover/press keep only opacity crossfade, no scale/box-shadow transform |

### Accessibility

- Button retains a real `<button>` element (unchanged) with its native `title` tooltip — but add an
  explicit `aria-label` matching the `title` text so screen readers announce "Let this activity run
  into the next period, button" / "Split this back into two periods, button" rather than relying on
  `title` alone (native `title` is not reliably exposed to all AT). This is a small correctness fix
  riding along with the visual change, not a new requirement — `title`-only buttons are a known SR
  gap.
- Keyboard reachability: the button already sits inside the cell subtree, which `useGridKeyboardNav`
  makes reachable via the roving-tabindex grid. Because `dnd-kit` no longer claims Space/Enter for
  this cell's own drag (the expand-drag path is deleted, not the cell's own move-drag), confirm
  Tab from the focused cell reaches the merge/split button as a natural DOM-order stop — no new
  keyboard trap is introduced by adding a persistently-rendered (rather than conditionally-mounted)
  button; if anything, removing the drag handle *reduces* the number of focusable elements per cell
  by one.
- `:focus-visible` ring on the button itself (see States table) is required — do not rely solely on
  the parent cell's own focus ring, since the button is a separate interactive target a keyboard
  user can Tab into.
- Onboarding pulse must not be the only way a screen-reader user learns of the affordance — SR users
  get the `aria-label` regardless of pulse state, so the pulse is a sighted-only enhancement, never
  load-bearing for accessibility.
- Reduced-motion fallback specified above (static ring, no keyframe animation) is mandatory per
  §5/§8 of the Design Standard.

### Prototype

Not produced as a separate HTML file — the change is scoped enough (one button's persistent-vs-hover
state, one icon swap, one deletion) that the states table plus exact CSS/SVG values above are
sufficient for Maker to implement directly against the existing `scheduleGrid.css` file it's already
editing. If Governor wants a visual check before sign-off, the fastest path is Maker's own dev-server
screenshot of a Manual Build cell in idle/hover/split states — not a separate mockup file.

### Implementation notes for Maker

1. **Delete, don't deprecate:** remove `ExpandHandle` (SlotCell.jsx lines 14–37), its render branch
   (`showExpandHandle`, lines 141–142 and 382–389), and the `.expand-handle`/`.expand-glyph*` CSS
   block (scheduleGrid.css lines 384–447). Then trace `DRAG_KINDS.EXPAND_DRAG` through
   `useDragFSM.js`, `dragHandlers.js`, and their two test files (`dragHandlers.test.js`,
   `dragFSM.test.js`) — those are now dead code paths for a control that no longer exists. Removing
   them is in scope for this ticket (they exist only to serve the deleted handle), not a separate
   cleanup ticket; leaving them would fail `check:governance`/dead-code review expectations no
   differently than leaving an unused component would.
2. **The `.cell-action` button's existing gating logic (`hasMergeDown`, `isMerged`) is unchanged** —
   only its CSS goes from `visibility:hidden;opacity:0` at rest to `opacity:0.55` at rest (no
   `visibility:hidden` at all now — the button is always in normal flow and always hit-testable,
   which is also what makes it a real keyboard/SR target instead of the effectively-hidden state
   `.cell-action` had before this spec).
3. **Icon file location:** the `ExpandGlyph` component belongs in `SlotCell.jsx` alongside
   `UnfillableIcon`/`OutdoorIcon` (same file, same pattern) — do not create a new icons module for
   one glyph.
4. **`manualMergeHintSeen` flag:** plain `localStorage`, read/write directly in `ManualBuildView.jsx`
   or a small local hook — this is intentionally NOT routed through `window.shoresh.*` IPC/op-log;
   it's per-device UI chrome, not camp data, so it should behave the same way `collapsedBlockIds`-style
   local view state already does elsewhere in this file's siblings (verify against how similar
   device-local UI toggles are currently stored in this codebase before inventing a new pattern —
   there may already be a local-only storage helper to reuse rather than a raw `localStorage` call).
5. **Test coverage this ticket needs:** (a) `.cell-action` renders in idle (non-hover) DOM state
   with `aria-label` present — a snapshot/RTL test asserting it's queryable via
   `getByRole('button', { name: /run into the next period/i })` without simulating hover, which is
   the actual regression test for "discoverable," (b) the expand-drag code path's removal doesn't
   break `slot-move`/`palette-drop`/`overlay-fill` drag kinds (the three that remain in
   `dragFSM.test.js`'s kind list once `expand-drag` is removed), (c) reduced-motion fallback renders
   the static ring, not the keyframe pulse.
6. **Do not touch** `template_slots`/`is_span_head` write semantics, `expandSlot`/`splitSlot` in
   `useSlotMutations.js`, or anything in `buildSchedule.js` — this spec is visual/interaction only;
   the underlying merge capability (T92's original "can't merge" claim) already works and is out of
   scope for this pass.
