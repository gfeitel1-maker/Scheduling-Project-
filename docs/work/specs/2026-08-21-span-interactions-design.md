---
title: "Arbitrary-length span UI: drag-to-extend + click-any-interior-cell-to-split"
document_type: spec
status: draft
created: 2026-08-21
governing_docs: [docs/adr/2026-08-21-arbitrary-length-activity-span.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_adrs: [docs/adr/2026-08-21-arbitrary-length-activity-span.md]
archive_when: drag-to-extend and click-any-interior-cell-to-split are live on both routes and covered by tests
---

# DESIGN SPEC — Arbitrary-length span interactions (T107 deferred items 1 & 2)

Answers the ADR's Open Questions #1 (drag-preview resolution) and implements the owner's
already-decided #2 (click-any-interior-cell split). Scope is exactly T107 deferred items 1–2: the
DnD/geometry gesture layer over the already-shipped `expandSlot`/`splitSlot` write path. No data
model or mutation-signature change.

---

## Decision 1 — drag preview: LIVE snap-to-block preview, resolve-and-write only on drop

**Recommendation, high confidence.** During the drag, the covered-block boundary snaps live,
block-by-block, as the pointer crosses each block's row track — rendered with the existing
**static** drop-indicator mechanism already in `scheduleGrid.css` (no transition, no tween). The
actual `expandSlot`/`splitSlot` mutation call happens once, only on drop.

**Why not "resolve N only on drop" (no live preview):** violates apple-design's Response
principle — "feedback must be continuous during the interaction, not just at the end." A director
dragging 6 blocks with no visual feedback until release cannot tell if the gesture is tracking
correctly; they would have to drop and possibly undo to find out.

**Why not an animated/tweened preview:** `scheduleGrid.css`'s existing drag section is explicit —
"STATIC ONLY... no transition, no transform, no cell sliding" (T58, citing the Atlassian
react-beautiful-dnd lesson that animated placement feedback makes users wait for the animation
before they can read intent). A live preview is compatible with that rule as long as it is a
same-frame attribute-driven highlight, not an eased/animated boundary.

**The reconciliation:** "live" and "static" are not in tension once you separate *when the boundary
moves* (every pointer-move frame, continuously — apple-design's Response) from *how it moves*
(instant attribute swap, zero transition duration — the existing T58 static-ghost rule). This spec
uses the identical `data-drag-over` / `data-drop-edge` mechanism already shipped for cell-to-cell
drag, extended to cover a *range* of blocks instead of one cell.

---

## Decision 2 — interior split hit target: equal-height invisible sub-block bands, tail band reserved for the extend handle

**Recommendation, high confidence.** The merged `rowSpan` cell is divided, at render time, into N
equal-height invisible click bands (one per covered block), stacked top to bottom in DOM order
matching block order. Band 1 (the head block) is **not** a split target — nothing exists before it
to keep — and keeps today's click-to-edit behavior. Bands 2..N are split targets: clicking band `i`
calls `splitSlot(..., cutBlockId: block[i].id)`. The bottom ~10px of band N is carved out as the
drag-to-extend handle (Decision 1's grab affordance), so the last band's split-click region is
slightly shorter than the others — this is the one place the two gestures share territory, and the
carve-out is what keeps them from conflicting.

**Why bands, not a single "click anywhere below the head" handler:** the owner's stated mental
model is Excel's "un-merge from here" — the cut point must be the *specific* block clicked, not
just "somewhere in the tail." A single handler covering all non-head area couldn't distinguish
which block was clicked without doing the same geometry math bands already do, so bands are the
mechanism, not an alternative to one.

---

## Layout

Both interactions live entirely inside `SlotCell.jsx`'s rendering of a span-head cell (the
`rowSpan > 1` case, `aria-rowspan` set) in `ManualBuildView.jsx` / `ScheduleGroupView.jsx`. No new
component file; this is new markup + data attributes inside the existing `.cell` / `.cell-inner`
structure, following the `scheduleGrid.css` exception boundary (`src/components/schedule/`).

```
.cell[aria-rowspan]                          — existing merged span-head cell (unchanged sizing)
  .cell-inner                                — existing content box
    .cell-name, .identity-dot, flags…        — existing (unchanged)
    .span-band[data-band-index="1"]          — NEW, invisible, band 1 = head, non-split (edit-only)
    .span-band[data-band-index="2..N"]       — NEW, invisible, split targets
      .span-cut-line                         — NEW, hover-only, horizontal indicator
    .span-extend-handle                      — NEW, bottom edge of band N, drag grip
```

Bands are absolutely positioned `div`s inside `.cell-inner`, each `height: calc(100% / N)`,
`top: calc(100% / N * (i - 1))`, `left: 0; right: 0`. They carry no visible chrome at rest — they
are a hit-target layer only, sitting above `.cell-name`/flags in z-order but `pointer-events: none`
except on the specific band elements themselves (so text/flags underneath remain visually
unaffected).

Row-track height for each block already comes from `--grid-rows` (`scheduleGrid.css`); a band's
`calc(100% / N)` divides the *rendered* cell height (sum of N tracks) evenly only when tracks are
equal height, which they are for non-collapsed rows. **Collapsed-row interaction**: a span whose
head block is collapsed (`data-collapsed`) renders at the fixed `COLLAPSED_TRACK` height per block
— bands still divide evenly by count, just into thinner strips. Below `COLLAPSED_TRACK` × 2 total
height (i.e., N ≤ 1 visually distinguishable band), interior split is not offered — see States.

---

## Visual Style

No new colors. Every value below is an existing token.

- **Drop/preview boundary** (extend drag): reuses `.cell[data-drag-over]::after` /
  `::before` exactly as shipped — `outline: 2px solid var(--primary)`,
  `background: color-mix(in srgb, var(--primary) 10%, transparent)` for the covered-range fill,
  and the `::before` bar (`background: var(--primary)`, 3px) marking the *new* boundary edge as it
  crosses each block.
- **Extend handle** (`.span-extend-handle`): a small horizontal grip at the bottom edge of the
  span's last covered block, visually similar to `.overlay-fill-handle` (existing pattern) but
  reusing `--primary` (span is an activity, not an overlay-fill's `--accent`):
  `width: 28px; height: 4px; border-radius: 2px; background: var(--primary); opacity: 0.5`.
  On hover/focus: `opacity: 1`, cursor `row-resize` (change from `s-resize` — this is vertical
  block-count, not a diagonal fill).
- **Split cut-line** (`.span-cut-line`, band hover only): a full-width horizontal line at the
  band's top edge (the actual cut point — cutting "at" a block means the boundary lands above
  that block, consistent with the ADR's "cut here, everything after becomes independent"):
  `height: 2px; background: var(--danger); opacity: 0` at rest, `opacity: 1` on band hover/focus.
  **Danger, not primary** — split is a destructive-to-the-span action (mirrors `.cell-action--split`
  today, which already uses `var(--danger)` on hover per `scheduleGrid.css:407-411`).
- **Truncation feedback** (drag hits a stop condition mid-gesture): the boundary bar
  (`::before`) freezes at the last valid block and gains a **quiet** one-time indication — reuses
  the existing `.cell[data-flag-changed]::after` ring-pulse mechanism's *values* (not the same
  element), applied to the frozen boundary: `border: 1px solid var(--text-secondary)`, animating
  per Animation section below. **Not `--danger` or `--accent`** — a stop condition during a drag is
  informational ("this is as far as it goes"), not an error; matches the Design Standard's rule
  that only destructive/error states get brick.

---

## States (as `scheduleGrid.css` data attributes — no new React state beyond drag-FSM extension)

All of these are ephemeral, per-cell, transient-during-gesture states — they belong in
`scheduleGrid.css` as data-attribute rules per `CLAUDE.md`'s scoped-exception rule, not as new
per-cell React state.

| Attribute | On element | Meaning |
|---|---|---|
| `data-span-dragging` | `.cell` (the span head being dragged) | This span's extend handle is actively gripped. Suppresses the normal cell click-to-edit and hover-reveal affordances for the duration (mirrors how `data-drag-over` today suppresses normal hover chrome elsewhere). |
| `data-drag-over` + `data-drop-edge` | every `.cell` currently covered by the live-previewed extend range | **Reused verbatim** from the existing single-cell drag mechanism — the range is just N cells instead of 1, each independently getting the attribute during the frame it's covered. |
| `data-drag-truncated` | the `.cell` at the last valid block, once a stop condition is hit mid-drag | Triggers the one-time quiet pulse (Animation, below). Cleared on the next pointer-move frame if the drag retreats past that point, or on drop/cancel. |
| `data-span-band-hover` (+ `data-band-index`) | the specific `.span-band` under the pointer/focus | Reveals that band's `.span-cut-line` and (optionally) a `title`/aria-live "Split before {block name}" hint — reuses the existing `cell:hover .cell-reason` display-toggle pattern already in the stylesheet. |
| `data-span-extend-hint` | `.span-extend-handle`, on first render of any span ≥2 blocks the current session hasn't interacted with | One-time discoverability pulse — **reuses the exact `cell-action-hint-pulse` keyframe and clearing convention already shipped** for the merge-down button (`scheduleGrid.css:413-424`, T92), applied to the handle instead. Same bronze color, same single non-looping pulse, same "cleared by the caller after first interaction" contract. |

No new attribute is needed for "split is available" — that gate is already correctly identified in
the ADR (§ Files/modules affected) as `collectSpanTails(...).length > 0`, computed in
`ManualBuildView.jsx`/`ScheduleGroupView.jsx` and passed down as whether band elements render at
all (a plain, non-spanning slot renders zero bands).

---

## Interactions

### Drag-to-extend

1. **Grab** — pointerdown on `.span-extend-handle` (not the cell body — the cell body's existing
   click-to-edit and the whole-card drag-to-replace gesture must not be stolen). Per
   apple-design's Response principle, the handle's own `:active`/grabbed feedback is instant:
   `opacity: 1`, no transition delay, on the same frame as pointerdown.
2. **Track** — as the pointer moves, resolve which block row the pointer's Y coordinate falls
   in (same `data-cell-key` / coordinate-to-block resolution `dragHandlers.js` already does for
   cell-to-cell drops, extended to walk multiple blocks in one gesture rather than resolving a
   single `hit`). For each block between the span's current head and the resolved pointer block:
   - If it fails none of the §3 ADR stop checks (day-end / anchor / `WEEK_CLOSED` / locked-or-
     overridden-by-a-different-activity), mark it `data-drag-over` with the live preview fill.
   - The **first** block that fails a check stops the preview there: that block and everything
     past it do NOT get `data-drag-over`; the last valid block instead gets `data-drag-truncated`.
   - A drag that retreats (pointer moves back up toward the head) shrinks the preview the same
     way, live, block by block — this is the shrink-via-drag case from the ADR (§2), previewed
     identically to an extend, just in the other direction.
3. **Drop** — pointerup. Resolve the final covered range **fresh** (re-run the §3 checks against
   current data, per ADR Red Hat R1 — a block that changed state mid-drag is re-validated at
   dispatch, not trusted from the last preview frame). Call `expandSlot` (grew) with the final
   block list, or the shrink path (also `expandSlot`, releasing dropped tails) if the range got
   shorter than the span's current length. One `gestureId`, one `runMutation` call, exactly as ADR
   §2 specifies — the UI layer's job is only to resolve the final block list, not to perform N
   separate writes.
4. **Cancel** (Escape, or drop outside the grid) — preview clears instantly (no exit animation;
   this is a live-tracking preview, not an entrance/exit — apple-design's rule that gesture-driven
   feedback must be interruptible/redirectable, and CSS transitions are unnecessary overhead on
   something already updating every frame).

### Click-any-interior-cell-to-split

1. **Discover** — hovering/focusing any band 2..N reveals that band's `.span-cut-line` at its top
   edge and (via the existing `cell-reason` show-on-hover pattern) a small text hint identifying
   the block by name ("Split before 2:00 PM").
2. **Commit** — clicking band `i` calls `splitSlot(..., cutBlockId: block[i].id)` immediately
   (no confirmation dialog — per apple-design's Agency principle, reserve confirmation dialogs for
   genuinely destructive *data-loss* actions; a split is reversible via the existing undo stack,
   consistent with how `replaceSlot`/`expandSlot` already commit without confirmation).
3. **Head band (band 1)** never triggers split — clicking it opens the existing inline cell editor
   (today's click-to-edit), unchanged.
4. **Keyboard**: bands are not separately tab-stops (that would fragment one grid cell into N
   focus stops, which the grid's existing single-focus-per-cell model per T59 doesn't support
   without a larger a11y rework, correctly out of scope for T107). Split remains mouse/touch-only
   for this iteration; the existing `cell-action--split` button (head-cell-only merge/split
   control, already keyboard-reachable) stays as the keyboard-accessible equivalent, unchanged and
   NOT removed by this work — it is the accessible fallback, not a redundant control to delete.

---

## Animation

| Moment | Trigger | Type | Duration | Values |
|---|---|---|---|---|
| Live extend/shrink preview boundary | pointer crosses a block row during grab | **Static, instant** (no animation) | 0ms | Same-frame `data-drag-over`/`data-drop-edge` attribute swap; reuses shipped `::before`/`::after` rules verbatim. No transition property on these rules — this is deliberate per T58. |
| Drag-truncated quiet pulse | drag hits a stop condition mid-gesture | **Pulse** (single, non-looping) | `var(--motion-settle)` (340ms), `var(--ease-out)` | `border: 1px solid var(--text-secondary)`, `opacity 0.55 → 0`, `scale(1) → scale(1.015)` — identical curve/values to the existing `flag-changed-ack` keyframe (`scheduleGrid.css:747-749`), reused rather than a new keyframe invented for this. |
| Extend-handle grab feedback | pointerdown on handle | **Press feedback** | instant (no transition delay on opacity), optional `transform: scale(0.94)` on active | Mirrors `.cell-action:active { transform: scale(0.94) }` already shipped |
| Split cut-line reveal | band hover/focus | **Fade** | `var(--motion-fast)` (140ms) `var(--ease-out)` | `opacity: 0 → 1` on `.span-cut-line`; matches the existing `.cell-empty` hover-tint transition speed |
| Extend-handle discoverability pulse | first mount of any span, uncleared this session | **Pulse** (single, non-looping), reused verbatim | `var(--motion-settle)` (340ms) `var(--ease-out)` | Identical to `cell-action-hint-pulse` (`scheduleGrid.css:420-424`), just targeting `.span-extend-handle` instead of `.cell-action` |

**`prefers-reduced-motion: reduce`:**
- Drag-truncated pulse → `animation: none; outline: 2px solid var(--text-secondary); outline-offset: 1px` (static ring instead of the scale/opacity pulse), matching the existing reduced-motion fallback pattern for `.cell[data-flag-changed]`.
- Extend-handle discoverability pulse → `animation: none; outline: 2px solid var(--accent); outline-offset: 1px` (identical fallback already shipped for `cell-action-hint-pulse`, reused verbatim).
- Live preview boundary is already non-animated (0ms) at full motion, so nothing changes under reduced motion.
- Cut-line fade → keep (140ms opacity-only fade is well within the "gentler, not zero" reduced-motion allowance; it is not a translate/slide).

---

## Prototype

Not produced as a standalone HTML mockup. Rationale: every visual primitive this spec reuses
(`data-drag-over`/`::before`/`::after` drop indicator, `cell-action-hint-pulse` keyframe,
`flag-changed-ack` keyframe, `cell-reason` hover-reveal) is already live in the running app on
`claude/admiring-dijkstra-db441a` — the fastest and most accurate verification is Maker building
directly against the real grid and the Designer/Governor reviewing the actual dev server, not a
static reconstruction of a grid that already exists. If Governor wants a throwaway interaction
sanity-check before full implementation (e.g. to validate band-height math at N=3 with a collapsed
head block), that is a `prototype` skill follow-up scoped narrowly to that one geometry question,
not a full mockup of this spec.

---

## Implementation Notes for Maker

1. **Do not extend `useDroppable`/dnd-kit's per-cell droppable model for the extend handle.**
   Per the existing `dragHandlers.js` comment, the grid already resolves targets from pointer
   coordinates against `data-cell-key`, not per-cell `useDroppable`. The extend-handle drag is a
   *new* gesture kind alongside the existing card-drag and fill-drag (`overlay-fill-handle`
   precedent) — model it in the same drag-FSM (`dragFSM.js`) as a third recognized gesture,
   distinguished by its origin element (`.span-extend-handle`), not a new dnd-kit context.
2. **`distance: 8` activation constraint**: the extend handle is a small, deliberate 28×4px target
   — do not apply the whole-cell `distance: 8` click/drag disambiguation to it. A pointerdown
   directly on the handle should begin gesture tracking immediately (per apple-design's Response
   principle: respond on pointer-down). The 8px distance threshold exists to disambiguate a
   whole-cell click (open editor) from a whole-cell drag (move activity) — the handle has no such
   ambiguity because nothing else on the handle itself is clickable.
3. **Live preview must re-validate the ADR §3 stop conditions on every pointer-move frame**, not
   just at drop — this is what makes the truncation feedback (Decision 1, `data-drag-truncated`)
   possible at all. Reuse the same check functions the ADR's R1 resolution requires at dispatch
   time; do not write a second, divergent "preview-time" validity check.
4. **Band geometry**: compute `bandHeight = cellHeight / rowSpan` from the already-known
   `rowSpan` (from `getActivityRowSpan`, unchanged) — do not introduce a new geometry function in
   `gridGeometry.js`; bands are a rendering-only concern inside `SlotCell.jsx`, not a pure-geometry
   concern that belongs alongside `getActivityRowSpan`.
5. **The bottom ~10px carve-out on band N belongs to the extend handle, not band N's split
   click area.** Implement as: band N's click-catching height is `bandHeight - 10px`; the extend
   handle occupies a fixed 10px strip at the very bottom of the cell, always present, always on
   top in z-order. This is the one boundary between the two gestures from Decision 2 — get the
   z-order and the exact pixel carve-out right, or a director aiming for the handle will
   accidentally trigger a split at the last block, or vice versa.
6. **`splitSlot`'s existing per-cell `.cell-action--split` button is NOT removed.** It remains the
   keyboard-accessible split trigger (see Interactions §4). This spec adds the interior-band
   mouse/touch gesture *alongside* it, not instead of it.
7. **Reuse, do not reinvent, every keyframe named in the Animation table** — `flag-changed-ack`
   and `cell-action-hint-pulse` already exist in `scheduleGrid.css`; apply them to the new
   elements via the existing keyframe name, do not author near-duplicate keyframes with slightly
   different values.
8. **No new CSS file.** Everything above is new selectors inside the existing
   `src/components/schedule/scheduleGrid.css`, within its already-established exception boundary.
9. **This spec does not change any data or mutation-call shape.** `expandSlot`/`splitSlot`'s
   signatures are exactly as the ADR left them; this is purely the gesture-to-block-list
   resolution layer feeding those existing calls.
