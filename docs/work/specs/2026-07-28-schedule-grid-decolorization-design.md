---
title: "Schedule grid de-colorization + flag/findings visual grammar — design spec"
document_type: spec
status: active
created: 2026-07-28
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-schedule-flag-findings-reshape.md]
archive_when: this work is merged and Verifier PASS recorded
---

# Schedule grid de-colorization + flag/findings visual grammar — design spec

Companion to the Architect's `2026-07-28-schedule-flag-findings-reshape-design.md`
(binding on data shape) and the canonical `design-system.md` (binding on tokens).
Prototype: `docs/superpowers/specs/prototypes/2026-07-28-schedule-grid-decolorization-prototype.html`
(current vs proposed, 16 groups × 8 blocks, 22-activity name pool, seeded so both
sides show the same underlying data).

## De-colorization call

**Activity hue drops from the grid's loudest channel to a single small identity
chip. It is retained (never removed entirely), but stops being spent three ways.**

Justification, in operational terms:

1. **Hue is the least reliable channel at this N and the most expensive to render.**
   6 colors ÷ 15-30 activities means 3-5 activities share every hue by pigeonhole
   (Architect's own explicit collision statement). Spending three simultaneous
   encodings (text color + 8% fill + border tint) on a channel that cannot
   uniquely identify anything is disproportionate — it triples the render cost
   of a signal that only narrows the guess to "one of 4," never confirms it.
   The activity **name** is the only channel that actually answers "which
   activity" — hue at best pre-filters.
2. **The user-decision that unlocked this round says the director does not use
   hue for a pre-attentive balance read** ("too much waterfront today"). That
   was the only operational job saturated fill could have justified. With it
   gone, full-cell fill has no job left except "the grid image is busy but
   nothing here needs your attention" — the opposite of what a working
   instrument should look like at 400-1400 cells.
3. **Full removal (activity color rendered nowhere) was rejected** because a
   thin, consistent color chip still gives a genuinely useful *secondary* signal
   at zero attention cost: "adjacent cells in this row are the same activity"
   (useful when scanning a merged run) and "this activity reappears elsewhere
   in the column" — a coarse, glanceable grouping cue that costs one 6-8px dot,
   not a saturated cell. Keeping it as a dot rather than deleting it also avoids
   a Maker-side migration that deletes `activityColor()`/`ACTIVITY_COLORS`
   plumbing the Architect's spec explicitly just stabilized (§6, this round) —
   respecting that work while demoting its visual weight is the smaller,
   safer change.
4. **What replaces the emphasis budget:** cell background returns to neutral
   `var(--surface)` for the default case. The reclaimed contrast budget is
   spent entirely on the two things that are actually actionable: the
   `UNFILLABLE` danger mark (promoted, per Architect's instruction) and the
   locked/anchor structural marks (demoted from full-flood to a border-bar,
   see below) — so a director's eye now lands on "what needs a decision," not
   on "which of six brownish/greenish tints is this."

**Observed at N=16×8=128 cells (prototype, representative slice of the full
400-1400 range):** in the *current* scheme, the grid reads as a mosaic — every
cell has visual weight, so bronze-locked, bronze-weather-highlighted, and
brick-flag-dot cells do not separate from the general texture; scanning for
"which cells are broken" requires reading every cell's dot cluster individually.
In the *proposed* scheme, the grid reads as mostly-quiet paper with a small
number of thin danger-bar cells and bronze-bar cells visibly breaking the
rhythm at a glance — no per-cell reading required to find them. This effect
gets strictly stronger, not weaker, as N grows toward 1400, since the "quiet"
cells cost consistently less rendered contrast while the marked cells stay
fixed-emphasis.

## Visual spec — every cell state

All values are inline React style objects per the binding styling constraint.
Corner radius stays `8px` (existing `cellTd`/inner-div convention). Base inner
padding stays `10px 12px`, `minHeight: 56` — unchanged from current code, this
round is a color/emphasis pass, not a layout pass.

### 1. Normal (activity assigned, unlocked, no flags)
- Background: `var(--surface)`.
- Border: `1px solid var(--border)`.
- Identity chip: `6px` circle, `background: activityColor(activity.id)`, positioned inline before the name, `marginRight: 4px`, `verticalAlign: middle`.
- Name: `var(--text)`, `12px`, `fontWeight: 600` (not 700 — reserve 700 for emphasis states below).
- No fill tint, no border tint from activity hue.

### 2. Empty (no slot placed)
- Background: `var(--surface)` (was `var(--bg)` — moving it one step lighter than `unavailable` is what makes the two distinguishable, see #3).
- Border: `1.5px dashed var(--border)`.
- No content, no icon. Reads as "open, waiting" — a director can drop something here.

### 3. Unavailable (slot cannot be scheduled — e.g. outside camp hours for that group)
- Background: `color-mix(in srgb, var(--text) 5%, var(--bg))` — a flat neutral gray-paper fill, **solid, not dashed**.
- Border: `1px solid var(--border)` (solid, not dashed).
- No opacity trick (current code uses `opacity: 0.5` on a dashed box, which is why it currently reads as a dimmer version of `empty` rather than a distinct state). Solid fill vs. dashed outline is the differentiator: empty = "outline only, invite a drop"; unavailable = "filled, not a target." This directly serves the "find a gap" read-task named in the brief.

### 4. Anchor (fixed/immovable event)
- Background: `var(--surface)` (was a 12% anchor-tinted flood — demoted to match the "structural chrome, not data" principle already stated in design-system.md §4 for the anchor token).
- Left border bar: `3px solid var(--anchor)` (border-left only; other three sides `1px solid var(--border)`).
- Label: `var(--anchor)`, `11px`, `fontWeight: 600`.
- No corner mark. The bar alone reads as "structural," consistent across group and day view (see Implementation Notes — this is the fix for the group/day inconsistency).

### 5. Locked
- Background: `var(--surface)` (demoted from the current 8%-accent flood).
- Left border bar: `3px solid var(--accent)`; other three sides `1px solid var(--border)`.
- **No corner triangle.** The current triangle + 2px full-border + 8% flood is three simultaneous bronze encodings for one fact; the left bar alone is sufficient and matches the anchor treatment's grammar (structural state = left bar, not flood+border+corner).
- Name: `var(--text)` at normal weight — **do not** tint the name text bronze (current code does `color-mix(accent 60%, text)`, which competes with the activity-chip color right next to it). Bronze stays confined to the bar.
- Activity identity chip still renders (locked cells still have an activity — the director needs to see what's locked, not just that something is).
- Click behavior unchanged (`onRelease`).
- **Must render identically in group view and day view** — this is a bug-fix instruction from the brief, not a new design decision: `ScheduleGroupView.jsx:134-153` currently omits the locked treatment entirely. Maker applies this exact bar spec in both call sites from the same shared style object (put it in `S.cellLockedBar`, see shared.js additions below) so the two views cannot drift again.

### 6. UNFILLABLE (promoted — the one channel that stays loud)
- Left border bar: `4px solid var(--danger)` (one px heavier than the 3px structural bars above — danger is the only state allowed a heavier bar, so weight itself is part of the severity grammar, not just color).
- Background: `color-mix(in srgb, var(--danger) 6%, var(--surface))` — the only per-cell state that gets a background tint at all in the proposed scheme, which is precisely why it will stand out; every other cell type either has no tint or a structural-bar-only treatment.
- Corner icon: small outline "alert" glyph (not a filled dot), `12px`, `var(--danger)`, `stroke-width: 1.5`, top-right, `position: absolute, top: 4, right: 4`. Using an icon rather than a dot is deliberate — dots are the vocabulary the old scheme overused for three unrelated things; an icon shape is unambiguous even before color registers.
- This is the **only** per-cell flag mark remaining in the grid (UNDERSERVED/DISTRIBUTION move to the findings rail per Architect's decision — see §"Reasons surface" below).

### 7. Outdoor (`activity.is_outdoor`, replaces deleted `WEATHER_RISK`)
- **No border change, no background tint, no dot.** This is the Architect's explicit ask for a lower-emphasis, non-dot treatment, and it must not compete with the danger bar's weight.
- Small outline icon (sun/cloud glyph — reuse whatever outline icon set the app already has; if none, a simple two-arc "sun" SVG at `stroke-width: 1.5`), `10px`, `color: var(--text-secondary)` (**not** `var(--accent)` — accent is reserved for locked/caution per design-system.md §4, and outdoor is informational, not a caution state; using text-secondary keeps it visually inert unless someone is specifically scanning for it).
- Position: `top: 3px, right: 3px` inside the cell, small enough to sit unobtrusively even when an UNFILLABLE icon is also present in the same corner region on the same cell (rare but possible) — in that case render only the UNFILLABLE icon; outdoor is suppressed by the heavier state so two icons never stack in one corner. Document this precedence rule for Maker explicitly (see Implementation Notes).
- Weather-mode toggle (existing `weatherMode` prop): when active, outdoor cells get **one additional cue**, a `1px` outline in `var(--text-secondary)` around the whole cell (not `2px solid var(--accent)` as today) — enough to sweep-scan the grid for outdoor cells when the director is specifically checking weather exposure, without that outline reading as a permanent per-cell state the rest of the time.

### 8. Selected (single selection)
**New channel — moves off navy, which the brief requires because navy is drop-target chrome.** Selection becomes an **elevation** cue instead of a hue: the grid has already exhausted its safe-to-use hue budget (navy=drop-target, bronze=locked/caution, danger=UNFILLABLE, anchor=structural, secondary=info-severity in the findings rail). Elevation is a channel nothing else on the grid currently uses.
- `boxShadow: '0 2px 8px color-mix(in srgb, var(--text) 18%, transparent)'` (a real, visible lift — heavier than the ambient `authCard` shadow since this needs to read at a glance across a busy grid).
- `outline: '1.5px solid var(--text)'`, `outlineOffset: -1px` — a neutral dark hairline, not a colored one. Reads as "this one is picked up," distinct from both the navy drop-target outline and the danger bar.
- `transform: 'translateY(-1px)'` to sell the lift physically (paired with the shadow).
- Motion: on select, **Lift** — `transform`/`boxShadow` transition `var(--motion-fast)` (140ms) `var(--ease-out)`. On deselect, reverse over the same duration. `prefers-reduced-motion`: skip the `translateY`, keep the shadow/outline as an instant state change (shadows/outlines are not motion, they're fine to keep).

### 9. Multi-selected
- Same lift/outline as single-selected, plus a flat neutral fill: `background: color-mix(in srgb, var(--text) 6%, var(--surface))` (replaces whatever `S.cellMultiSelectedFill` currently uses if it's navy-tinted — check and align to this neutral value). Neutral fill keeps the "off-hue" selection channel consistent between one and many selected, and avoids a second navy collision.

### 10. Drag-over / drop-target (transient, DnD feedback)
- **Unchanged** — keep `outline: '2px solid var(--primary)', outlineOffset: -2`. This is transient (only visible mid-drag) so it does not compete with the persistent selection state for attention; the two are temporally exclusive in practice (you don't drag while something else is selected in a way that matters visually), and re-deriving a new color for a well-understood, already-correct piece of feedback is not worth the churn.

### 11. Expand-drop (drag-to-extend target)
- **Unchanged** — keep the existing green dashed treatment (`border: '2px dashed var(--success)'`, `background: 'color-mix(in srgb, var(--success) 9%, transparent)'`). Also transient/drag-only, same reasoning as #10.

### 12. Merged (rowSpan > 1)
- No new visual state — a merged cell is a normal/locked/anchor/unfillable cell rendered taller via `rowSpan`, using whichever of the above states applies. Add one detail for legibility at height: when `rowSpan > 1`, vertically center the name+chip block instead of top-aligning (`justifyContent: 'center'` on the inner flex container) so the identity chip and name don't look stranded at the top of a tall cell. This is the only merged-specific rule.

## Severity grammar (independent of hue)

The Architect's `FLAG_SEVERITY` map (`danger`/`caution`/`info`) is consumed by
the **findings rail**, not by per-cell hue, since only `danger` (`UNFILLABLE`)
still has a per-cell presence after this round. The rail expresses severity
through **shape + position in a sorted list**, not color alone:

- `danger` rows: sort first, left-edge `3px solid var(--danger)` bar on the row, filled circular icon.
- `caution` rows: sort second, left-edge `3px solid var(--accent)` bar, outline circular icon.
- `info` rows: sort last, left-edge `3px solid var(--secondary)` bar, outline circular icon.

Color is present here too, but because each severity also gets a distinct
icon fill state (filled vs. outline) and a fixed sort position, a director
scanning the rail never depends on hue alone to judge urgency — satisfying
the brief's "severity through a channel that is NOT hue alone" requirement.

## Reasons surface — Findings & Flags rail

Not a new screen or view: an **expandable panel anchored under the existing
header badge** in `ScheduleScreen.jsx` (the badge that already shows a flag
count per `:1406-1410`). Click the badge to expand/collapse the rail; it does
not auto-open, so it costs zero space until requested.

- Trigger: existing header badge. Its count changes from "count flagged
  slots" to `unfillableSlotCount + findings.length` (already specified by
  Architect, §"Test impact"). Badge background changes to `var(--danger)` if
  `unfillableSlotCount > 0`, else `var(--accent)` if any `caution` findings
  exist, else `var(--secondary)` if only `info` findings exist, else the
  badge doesn't render at all (zero issues = zero chrome, consistent with the
  "quiet" personality).
- Panel: `position: absolute` below the badge, `background: var(--surface-elevated)`, `border: 1px solid var(--border)`, `borderRadius: 8`, `boxShadow: '0 2px 24px color-mix(in srgb, var(--text) 6%, transparent)'` (reuse the exact `authCard` shadow token from design-system.md §6 — this is a popover, same visual family as a modal/dropdown). `maxWidth: 360px`, `maxHeight: 400px`, `overflowY: auto`.
- Each row: severity bar (per grammar above) + one-line reason text (`13px`, `var(--text)`) reusing the Architect's `reason` string verbatim for findings, and the existing `flags.UNFILLABLE_reason` for per-cell rows + a small `groupId`/day/block locator label (`11px`, `var(--text-secondary)`). Row is clickable: clicking scrolls/highlights the relevant grid cell or column (existing scroll-into-view pattern if one exists in `ScheduleGroupView`/`ScheduleDayView`; otherwise a simple `scrollIntoView({block:'center'})` on the target `<td>` plus a brief `1200ms` outline pulse in the row's severity color, respecting `prefers-reduced-motion` by skipping the pulse and just scrolling).
- Dismissal: a small "×" per row, wired to the existing per-slot dismissal for `UNFILLABLE` and to the Architect's non-persisted `` `${groupId}|${activityId}|${kind}` `` `Set` for findings (§5 of Architect's doc) — the rail is the UI surface for a dismissal mechanism that already has its data model specified; this spec adds no new dismissal semantics, only its visible affordance.
- Motion: panel open/close is **Slide + Fade** — `translateY(-6px) → 0`, `opacity 0 → 1`, `var(--motion-base)` (220ms) `var(--ease-out)`; reverse on close. `prefers-reduced-motion`: crossfade only, no translate.
- This same rail is the mechanism that replaces per-cell `title` hover for `UNFILLABLE` reasons too — the cell no longer needs to carry the full reason string in its native `title`; the icon can keep a short `title` fallback (`"Unfillable"`) for accessibility/screen-reader users, but the rail is the primary, discoverable surface for reading several reasons at once, which a hover tooltip structurally cannot provide.

## What goes into `src/styles/shared.js`

```js
// --- Schedule grid cell states (2026-07-28 decolorization pass) ---

export const cellIdentityChip = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  display: 'inline-block',
  marginRight: 4,
  verticalAlign: 'middle',
  flexShrink: 0,
}

export const cellStructuralBar = accentVar => ({
  // used for both anchor (--anchor) and locked (--accent); pass the token string
  borderLeft: `3px solid ${accentVar}`,
  borderTop: '1px solid var(--border)',
  borderRight: '1px solid var(--border)',
  borderBottom: '1px solid var(--border)',
})

export const cellUnfillableBar = {
  borderLeft: '4px solid var(--danger)',
  borderTop: '1px solid var(--border)',
  borderRight: '1px solid var(--border)',
  borderBottom: '1px solid var(--border)',
  background: 'color-mix(in srgb, var(--danger) 6%, var(--surface))',
}

export const cellUnavailableFill = {
  background: 'color-mix(in srgb, var(--text) 5%, var(--bg))',
  border: '1px solid var(--border)',
}

export const cellEmptyOutline = {
  background: 'var(--surface)',
  border: '1.5px dashed var(--border)',
}

export const cellOutdoorIconStyle = {
  position: 'absolute',
  top: 3,
  right: 3,
  fontSize: 10,
  color: 'var(--text-secondary)',
  lineHeight: 1,
  pointerEvents: 'none',
}

export const cellUnfillableIconStyle = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 12,
  height: 12,
  color: 'var(--danger)',
}

// Selection moves off navy (navy is reserved for DnD drop-target chrome).
export const cellSelected = {
  boxShadow: '0 2px 8px color-mix(in srgb, var(--text) 18%, transparent)',
  outline: '1.5px solid var(--text)',
  outlineOffset: -1,
  transform: 'translateY(-1px)',
  transition: `transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)`,
}

export const cellMultiSelectedFill = {
  background: 'color-mix(in srgb, var(--text) 6%, var(--surface))',
}

// Findings & Flags rail (popover under header badge)
export const findingsRailPanel = {
  position: 'absolute',
  background: 'var(--surface-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: '0 2px 24px color-mix(in srgb, var(--text) 6%, transparent)',
  maxWidth: 360,
  maxHeight: 400,
  overflowY: 'auto',
  zIndex: 20,
}

export const findingsRailRow = severityColor => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 10px',
  borderLeft: `3px solid ${severityColor}`,
  borderBottom: '1px solid var(--border)',
  fontSize: 13,
  color: 'var(--text)',
})
```

Add `cellStructuralBar`/severity color lookups to `slotCellConstants.js`
alongside the existing `FLAG_COLORS`/`activityColor` exports — Maker should
build a `SEVERITY_BAR_COLOR = { danger: 'var(--danger)', caution: 'var(--accent)', info: 'var(--secondary)' }`
map there, consuming the Architect's `FLAG_SEVERITY` export rather than
re-deriving severity from a kind string a second time.

## Animation summary (exact terminology)

| Moment | Type | Duration | Easing | Reduced-motion fallback |
|---|---|---|---|---|
| Select / deselect | Lift (translateY + shadow) | `--motion-fast` 140ms | `--ease-out` | Instant state change, no translate |
| Findings rail open/close | Slide + Fade (translateY -6px + opacity) | `--motion-base` 220ms | `--ease-out` | Crossfade only |
| Row-locate pulse (rail → grid) | outline opacity pulse | 1200ms, one-shot | `--ease-standard` | Skip pulse, scroll only |
| Cell press (existing) | Scale 0.97→1 | unchanged (110ms, existing) | unchanged | unchanged, already sub-threshold |

No bounce, no elastic anywhere in this spec — every listed motion decelerates via `--ease-out` and none overshoots.

## Implementation notes for Maker

- **Precedence when both UNFILLABLE and outdoor are true on one cell:** render only the UNFILLABLE bar + icon; suppress the outdoor sun icon. Do not stack two corner icons. (UNFILLABLE is rare enough combined with outdoor that this is a real but infrequent case — handle it with a simple `if (unfillable) { /* skip outdoor icon */ }` branch, not a layout system.)
- **Locked + anchor never co-occur** (an anchor slot is a different `slot.type` branch in `SlotCell.jsx`, already structurally separate) — no precedence rule needed there.
- **Group view / day view parity for locked:** `ScheduleGroupView.jsx:134-153` must call the same `cellStructuralBar('var(--accent)')` style object `SlotCell.jsx` uses for locked, not a re-implementation. Grep both files for any inline locked-state styling before this change lands and consolidate on the shared export — this is the actual bug being fixed, not just a visual nice-to-have.
- **`activityColor()` signature is unchanged by this spec** — it still takes whatever the Architect's `djb2(activityId) % 6` call site produces; this spec only changes *how much* of the cell that color paints (chip vs. flood), not the color-selection logic itself.
- **`weatherMode` outline** replaces `isWeatherHighlight`'s current `2px solid var(--accent)` cell border with a `1px solid var(--text-secondary)` outline — confirm this doesn't collide with the `cellSelected` outline when a cell is both selected and weather-highlighted; if both apply, `cellSelected`'s `1.5px solid var(--text)` should win (render order: apply weather outline first, then let selection styles spread after it in the style object so selection's outline property overwrites weather's).
- **Do not re-introduce `opacity: 0.5` anywhere** for `unavailable` — the whole point of state #3 is a flat, undimmed, solid fill that reads as distinct from (not a duller version of) `empty`.
- **Findings rail is additive UI, not a replacement for the existing per-cell `title` attribute** — keep a short `title` fallback on the UNFILLABLE icon for accessibility, per the note in that state's spec above.
- Nothing in this spec requires new npm dependencies; the outline "alert" and "sun" icons can be small inline SVGs (`stroke-width: 1.5`, matching design-system.md §1's icon convention) — do not pull in an icon library for two glyphs.

## Prototype

`docs/superpowers/specs/prototypes/2026-07-28-schedule-grid-decolorization-prototype.html` —
standalone, no build step, open directly in a browser. Renders the same seeded
128-cell dataset twice, current scheme left / proposed scheme right, so the
hierarchy collapse (left) and its fix (right) are visible side by side at
representative scale.
