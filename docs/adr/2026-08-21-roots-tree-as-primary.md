---
title: "Roots home screen — tree-as-primary crown cluster + use-the-space inspector (RA-9 / RA-10)"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-21
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-20-roots-audit-remediation.md
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
amends: docs/adr/2026-08-18-rootmap-screen-port.md
archive_when: RA-9 and RA-10 ship and the review scorecard's visual-hierarchy target (8) is confirmed
---

# Roots home screen — tree-as-primary crown cluster + use-the-space inspector

## Decision

**RA-9 (tree-as-primary).** Remove the standalone 4-tile filter row above the canvas. Render the
same 4 state-count controls as a **crown-flanking tag cluster**: four compact real-DOM buttons,
positioned in fixed SVG-canvas-fraction coordinates *relative to the single crown anchor point*
(`x≈0.5, y≈0.30` of the viewBox — the point where the roots converge, just above the domain node
band), never relative to the trunk's silhouette or pixels. Each tag keeps its existing behavior
exactly: `aria-pressed`, click toggles `onSelectTile`, participates in the `none|tile|node`
selection union, dims non-matching nodes.

**RA-10 (use-the-space).** On wide viewports (≥ 900px `canvasWrap` width), `RootMapPanel` renders
*inside* the lower-canvas region (below the node band, y > ~0.66 of the viewBox) as an absolutely
positioned overlay with a translucent parchment surface, instead of below the canvas in normal
flow. Below that width, it drops back to normal document flow beneath the canvas (today's
layout), unchanged.

## Candidate approaches considered

Real divergence was run (`adhd` skill, 5 parallel frames — regulator, game design, biology,
remove-the-load-bearing-assumption, 3am-on-call — 30 ideas total) because this is exactly the kind
of structural, high-stakes visual decision the skill's pre-flight gate does not let through as a
closed case: multiple genuinely different arrangements were viable and the owner explicitly
deferred the *degree* of tree-as-primary to Architect.

Clusters that emerged, with the recurring signal across independently-run frames:

- **Ring/arc gauge wrapping the crown** `[N8 V5 F7]` — four counts as concentric or quadrant arcs
  circumscribing a fixed-radius circle centered on the crown point. Appeared independently in the
  regulator, game-design, biology, and 3am frames — a strong convergent signal that "a ring
  anchored to one point, not the trunk outline" is the right *geometric* idea. **Trap:** legible
  numerals inside a thin arc segment, at production width, over a busy sepia backdrop, is hard to
  guarantee — this is exactly RA-7's WCAG 1.4.1 concern (state not conveyed by hue/shape alone)
  colliding with cramped label space. High redesign risk if it fails a legibility pass; parked as
  a future refinement, not the shipped shape.
- **Off-canvas rail with leader-lines to the crown** `[N4 V9 F3]` — real HTML controls positioned
  beside the canvas, connected to the crown by computed leader-lines (3am frame). Most robust and
  most accessible of all 30 ideas (full HTML flow, i18n, ResizeObserver-driven, zero coordinate
  coupling to art). **Trap for THIS ticket specifically:** the owner's decision text is "pull the
  tile counts INTO/AROUND the crown so the hero IS the control surface." A rail beside the canvas
  wired by a line is the RA-9(b) "tighten" option wearing RA-9(a)'s clothes — it satisfies
  robustness but not the actual IA claim being made. Rejected on fit, not viability.
  ★ *Its core insight (real DOM buttons via `foreignObject`, not SVG-native shapes) is reused —
  just moved onto the crown itself.*
- **Disclosure-gated / hover-to-reveal counts** (whisper mode, sealed escrow badge, seed pods that
  crack open) `[N7 V4 F3]` — TRAP: the spec's success predicate #1 requires a first-time director
  to tell nodes are interactive *without hovering*, and RA-6 already committed to a *permanent*
  at-rest affordance. Anything gated behind hover/click-to-reveal directly regresses a decision
  this same spec just locked. Discarded outright.
- **Bark-texture inlay / camouflaged knots** `[N9 V3 F4]` — TRAP: matches the woodcut register
  beautifully but deliberately blends into the backdrop until interacted with, which is the same
  regression as above (and independently fails "distinguishable in greyscale," RA-7). Discarded.
- **Continuous idle-loop motion (orbiting motes, flowing rivulets)** `[N8 V4 F2]` — TRAP: directly
  contradicts the spec's protect-list ("the restraint at rest") and RA-1's whole point (no
  perpetual paint cost, reduced-motion must degrade cleanly). An idle orbit has no honest
  reduced-motion equivalent short of freezing it, at which point the idea's whole premise is gone.
  Discarded.
- **Hanging tag / parchment-collar strip anchored below the crown** `[N6 V8 F8]` — four
  ribbon/tag shapes hanging from a *single* crown coordinate with fixed vertical offsets, in the
  "chain of custody" register (regulator frame) and the "root-tab pull tag" register (remove-
  assumption frame). ★ This is the shortlisted, shipped shape (below) — real text at real size
  (no arc-cramming), one anchor point (trunk-independent), reuses the parchment/woodcut visual
  language the backdrop already establishes, and is a small, bounded change to `RootMap.jsx`.

**Converged pick:** the crown-flanking tag cluster — the hanging-tag/parchment-collar idea,
implemented with the off-canvas rail's one genuinely load-bearing insight (real `<button>` inside
`foreignObject`, exactly the pattern `Node` already uses) rather than as pure SVG shapes. This is
the smallest change that actually satisfies "the hero IS the control surface" without introducing
new legibility or motion risk, and it is buildable by one Maker pass without new tooling.

## Approach

### (a) Where/how the 4 counts render at the crown

Add a new presentational subcomponent to `RootMap.jsx`, `CrownCluster` (co-located, not a new
file — it is ~40 lines and has no reason to exist outside `RootMap.jsx`'s module boundary; the
deletion test: delete it and `RootMap` loses exactly "the 4 filter controls," nothing else reappears
elsewhere).

- **Anchor:** one point, `CROWN = { x: 0.5, y: 0.30 }` in the same normalized `[0,1]` coordinate
  space `rootMapLayout.js` already uses (`cx = CROWN.x * width`, `cy = CROWN.y * height`,
  computed inside `RootMap`, not a new layout-config file — it's one constant, not a family of
  hand-placed coordinates like `NODE_LAYOUT`). This sits **above** the domain node band (domains
  start at y≈0.33) and inside the region the parallel trunk-rework session owns only for its
  *art*, not for coordinate math — nothing here reads any pixel or path from
  `root-map-3d.webp`.
- **Arrangement:** four tags in a shallow fan, two hanging left-of-crown and two right-of-crown,
  at fixed offsets from `CROWN` (not from each other, so no cascading reflow if one tag's label
  changes width):
  ```
  offsets (normalized, relative to CROWN, before scaling by width/height):
  understood:  { dx: -0.115, dy: 0.045 }
  attention:   { dx: -0.045, dy: 0.070 }
  changed:     { dx:  0.045, dy: 0.070 }
  absent:      { dx:  0.115, dy: 0.045 }
  ```
  This ordering keeps `attention` and `changed` — the two states a director is most likely to
  act on — innermost and lowest (closest to the domain band they filter), `understood`/`absent`
  outermost. Each tag draws a short 1.5px stroke "thread" from its own top edge up to `CROWN`,
  reusing the same `#6b573c` hook-line treatment `Node` already uses for its lantern hook — this
  is what makes four independent tags read as "hanging from one point" instead of a floating row.
- **Shape/legibility:** each tag is a `foreignObject` containing a real `<button>` (same pattern
  as `Node`'s interactive layer), styled as a small rounded-rect parchment tag —
  `background: var(--surface)`, `opacity: 0.94`, `border: 1px solid var(--border)` at rest, with
  the state token color (`STATE_TOKEN[state]`) as a **left accent bar** (3px), not a full-tag
  tint — full-tint-on-sepia is where the ring/arc candidate's legibility risk lived, and a small
  accent bar sidesteps it entirely: the count/label render in `var(--text)` / `var(--text-secondary)`
  at the same 20px/12px sizes the current tiles use, guaranteed-legible regardless of backdrop
  art. This is also the RA-7 non-colour channel: the accent bar's *height fraction filled* can
  later encode magnitude without touching this ADR's scope — not required for RA-9/RA-10, noted
  as a natural RA-7 follow-on, not built here.
- **Active/selected styling:** identical semantics to today's tile — `aria-pressed={active}`,
  border widens to 2px and takes `STATE_TOKEN[state]`, background gets the same
  `color-mix(in srgb, var(--surface) 92%, ${STATE_TOKEN[state]} 8%)` tint the current tile uses.
  Literally the same `styles.tile` / `styles.tileActive` rules, just applied to a smaller tag
  shape instead of a flex-row box — no new visual vocabulary invented.
- **Calm at rest:** no motion added beyond what tags already inherit from `press-97`/opacity
  transitions elsewhere on the screen; nothing pulses, nothing orbits, nothing hides.

### (b) What happens to the current tile row

**Removed entirely** from `ReconciliationScreen.jsx`'s render — `RootMap`'s exported component
already owns `styles.tileRow` (`RootMap.jsx:274`); it is deleted and replaced by the
`CrownCluster` group rendered inside the existing `<svg>` block, alongside the domain/child
`<g>` elements. `TILE_STATES`, `tileCounts`, `STATE_TOKEN`, `STATE_LABEL`, `onSelectTile` and the
tile-vs-node `dimmed()` logic are all **unchanged** — only the render target moves from an HTML
flex row above the canvas to `foreignObject` buttons inside it. `selection.type === 'tile'` stays
the exact same shape consumed by `ReconciliationScreen.jsx` and `RootMapPanel.jsx`; no prop
contract changes at the `RootMap` boundary (`model`, `selection`, `onSelectTile`, `onSelectNode`,
`onClearSelection` — identical signature).

### (c) RootMapPanel repositioning (RA-10)

- **Breakpoint:** `≥ 900px` measured width of `canvasWrap` (the existing wrapping `<div>` around
  the `<img>` + `<svg>`, `RootMap.jsx:386`), read via a `ResizeObserver` on that div (the same
  mechanism the codebase already reaches for elsewhere for element-relative breakpoints — no new
  library). 900px is chosen because it is comfortably above the `maxWidth: 920` column the screen
  is already capped at (`ReconciliationScreen.jsx:476`), so "wide" in practice means "the column is
  at or near its own max width," and "narrow" covers the Electron pane resized down (RA-11's
  named edge case).
- **Wide placement:** `RootMapPanel` renders inside `canvasWrap` as `position: absolute`, pinned
  to the region `top: 66%` to `bottom: 0` (matching the node band's own empty floor,
  y > 0.66 of the viewBox — this is literally the "bottom-third dead space" RA-10 names), full
  width, on a `var(--surface-elevated)` panel with `opacity: 0.97` and a soft top border so it
  reads as sitting *in* the composition, not floating over it. It keeps its own internal scroll
  (`overflow-y: auto`, capped `max-height`) since decision-card content is unbounded.
- **Narrow placement:** unchanged from today — normal document flow below the canvas
  (`ReconciliationScreen.jsx:562`'s existing `<div style={{ marginTop: 16 }}>` wrapper). This is
  the literal "crop on narrow" from the ticket: below 900px, the lower-canvas region simply isn't
  claimed by the panel, and nothing else fills it (the canvas itself is not cropped — cropping the
  *canvas* was RA-10's rejected option; the panel is what moves).
- **Ownership:** the breakpoint state and conditional render both live in `ReconciliationScreen.jsx`
  (which already owns `RootMapPanel`'s mount point at line 562-577) — `RootMap.jsx` does not
  gain knowledge of the panel; it only exposes `canvasWrap`'s DOM node (a `ref` prop,
  `RootMap`'s only new prop) so the parent's `ResizeObserver` has something to measure and, on
  wide, something to render the absolutely-positioned panel inside.

### (d) Readiness banner + header coexistence

Unaffected by either ticket. `PostImportBanner`/`RootsBanner` and the sticky `headerStrip` render
above `RootMap` exactly as today (`ReconciliationScreen.jsx:494-525`) — the crown cluster and
panel changes are entirely inside and below the canvas region; nothing here touches the banner or
header's DOM position, z-index, or sticky behavior. The `styles.legend` (RA-8 domain legend) also
stays exactly where it is, directly above `canvasWrap` — the crown cluster does not compete with
it for space since it lives *inside* the canvas' own viewBox, not in the flow above.

### (e) Acceptance criteria + visual verification

1. No visible tile row above the canvas; the 4 counts appear as tags hanging from the crown point,
   legible (numeral + label at today's font sizes) at production column width (920px) and at the
   narrow Electron floor (RA-11's tested width).
2. Clicking a crown tag toggles the same `selection.type === 'tile'` behavior as today (dims
   non-matching nodes, `RootMapPanel` filters to that state) — verified by the existing
   `RootMap`/`ReconciliationScreen` tests updated to query the new tag buttons instead of
   `styles.tile`, plus one new test asserting `aria-pressed` toggles per tag.
3. On a ≥900px-wide window, `RootMapPanel` renders inside the lower third of `canvasWrap`; on a
   narrow window it renders below the canvas in normal flow — verified with a resize test
   (`ResizeObserver` mock, matching the pattern other resize-driven components in this codebase
   already use) plus a manual check in the running Electron app at both widths (screenshot each).
4. No "unfinished/dead space" read at any supported width — visually confirmed against the
   RA-10 problem statement (empty region below y≈0.66) at both breakpoints.
5. Reduced-motion: crown tags inherit no new animation; confirm `prefers-reduced-motion` still
   degrades the same way the rest of `RootMap` does (no regression test needed beyond the
   existing suite, since nothing new animates).
6. Manual visual pass (webapp-testing / dev server + `mockShoresh`) confirming the composition
   reads as one tree-with-controls unit, not "backdrop + two separate UI stacks" — this is the
   qualitative visual-hierarchy check the spec's scorecard (6→8) is targeting; record the
   before/after screenshot pair in the PR.

### (f) Risks

- **Legibility of 4 tags clustered tightly around one point at small viewport widths.** The fixed
  normalized offsets scale with `width`/`height` like every other node coordinate in this file, so
  tags shrink proportionally rather than colliding — but at the narrowest supported Electron pane
  width this needs the same manual check RA-11 already requires for node registration; add crown
  tags to that existing manual-check list rather than inventing a new one.
- **Re-verification when the parallel trunk-rework session's dissolved/reshaped trunk lands.**
  This design is deliberately trunk-pixel-independent (single anchor point above the node band,
  no dependency on trunk silhouette or `root-map-3d.webp` geometry), so it should not require
  rework — but the *visual read* ("does this look like it's hanging from the crown") is a judgment
  call that can only be confirmed once the new trunk art is in. Flag a follow-up visual check
  against the new backdrop as a fast final step, not a redesign gate.
- **The accent-bar-only colour treatment (chosen specifically to avoid the ring candidate's
  legibility trap) is a lighter non-colour differentiator than RA-7's glyph-based approach on
  the orbs themselves.** Acceptable because RA-7 already targets the *orbs*, not the crown tags;
  the crown tags carry their state via text (the label reads "Needs attention", not just a
  colour), so WCAG 1.4.1 is satisfied by the label text already, independent of RA-7's own scope.

## Files/modules affected

- `src/components/reconciliation/RootMap.jsx` — remove `styles.tileRow`/tile-row JSX; add
  `CrownCluster` subcomponent + its offset constants; add a forwarded `canvasWrap` ref prop.
- `src/screens/ReconciliationScreen.jsx` — add the `ResizeObserver`-driven breakpoint state; move
  `RootMapPanel`'s conditional render (absolute-in-canvas vs. normal-flow) based on that
  breakpoint; pass the new ref down to `RootMap`.
- Existing `RootMap.jsx` / `ReconciliationScreen.jsx` tests updated for the new tag-button query
  targets; one new resize-breakpoint test for the panel placement.
- No change to `rootMapLayout.js`, `root-map-3d.webp`, or any node coordinate — explicitly
  out of scope per the hard constraint (owned by the parallel trunk-rework session).

## Reused vs. new

**Reused:** the existing tile state model (`TILE_STATES`, `STATE_TOKEN`, `STATE_LABEL`,
`tileCounts`, `onSelectTile`, the `selection` union, `dimmed()`), the existing
`foreignObject` + real `<button>` pattern `Node` already established for SVG-embedded
accessible controls, the existing `styles.tile`/`styles.tileActive` visual rules (reapplied to a
smaller shape), the existing hook-line visual motif from `Node`'s lantern hook, and
`RootMapPanel`'s own internal rendering (untouched — only its mount point moves).

**New:** the `CrownCluster` subcomponent (one small presentational unit, no new state), one crown
anchor constant, four fixed tag offsets, and the `canvasWrap`-width breakpoint/ref plumbing between
`RootMap` and `ReconciliationScreen`. Nothing here introduces a new data shape, IPC call, or stored
schema — this is render-layer only, which is also why no second ADR is needed for the RootMapPanel
repositioning even though it's bundled with RA-9 here (see below).

## ADR required: yes

Filed at `docs/adr/2026-08-21-roots-tree-as-primary.md` (this document), per the spec's own
instruction ("Architect writes the ADR before Maker") and per the constitution's bar: this changes
an existing, already-ADR'd contract (`docs/adr/2026-08-18-rootmap-screen-port.md`'s "skeleton =
code-drawn interactive nodes, beauty = static/decorative" architecture, and its five-domain node
layout) by moving where and how the filter controls render relative to that skeleton, and it makes
a non-obviously-reversible IA call (the hero *is* the control surface, not decoration behind one) —
exactly the "architecture changes require an ADR" bar. RA-10 (panel repositioning) is a smaller,
purely-layout decision that would not independently clear the ADR bar, but is recorded here rather
than split out because it shares the same acceptance criteria, the same `canvasWrap` seam, and the
spec bundles both under one Wave 3 gate.

## Open questions for Governor

1. **RA-7's non-colour glyph work (Wave 2, in flight/queued separately) touches `Node`'s orb
   sprites, not the crown tags** — confirm Maker doesn't need to wait on RA-7 landing first; this
   design doesn't depend on it (crown tags carry state via label text already).
2. **The 900px breakpoint is a judgment call**, not something the ticket specified numerically —
   Governor/Designer should confirm it against the actual range of window widths directors resize
   to in practice (T90/RA-11's narrow-Electron-pane testing may already have a canonical narrow
   width worth reusing instead of picking 900px in isolation).
3. **Should the crown tags eventually carry the RA-7 magnitude-as-accent-bar-height treatment**
   noted in risk (f), or is text-only sufficient indefinitely? Flagged as a natural follow-on, not
   decided here — a product call, not a technical one.
