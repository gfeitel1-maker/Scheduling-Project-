---
title: "Interaction & UX model for the reconciliation root system screen"
document_type: spec
status: draft
created: 2026-08-18
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-08-18-roots-reconstruction-moment-gating.md]
related_tickets: []
archive_when: the ADR this spec feeds is accepted or superseded, and any resulting build lands with the interaction model preserved or the deviation documented
---

# Interaction & UX model — reconciliation root system screen

## Summary

This spec pins the interaction, state, motion, accessibility, and copy model for the reconciliation
screen's root/canopy metaphor. It is SPEC ONLY — no code, no assets — and is written to be assembled
into an ADR by Governor alongside the visual/layout half. The metaphor itself (roots = what was
ingested, canopy = what grows/schedules) is locked and out of scope for redesign here; this document
answers *how a person interacts with it*, not *what it looks like as a drawing*.

The governing constraint throughout: **the roots are an explainer, not a navigation pane.** Nothing
in this model may let a click on a root leave the screen. Every interaction either reveals detail
in place or populates the right-side attention panel.

## 1. Interaction model

### Zones and their affordance class

| Zone | Affordance | Never does |
|---|---|---|
| Summary tiles (4, header row) | Filter/scroll trigger — click narrows the root system to that state | Navigate to another screen |
| Root system (below ground line) | Explainer with in-place detail on hover, item-population on click | Navigate away; expand/collapse the whole screen; drag |
| Canopy (above ground line) | Ambient, largely passive — see §2 for whether it carries state | Accept click-through to schedule detail (that's ScheduleScreen's job, reached only via the screen's own separate navigation, not from a canopy node) |
| Right-side "Needs your attention" panel | Actionable queue — resolves items in place | Never a second navigation destination; resolving an item updates the panel and the root/tile it came from, nothing routes away |

### Resting state

- All root nodes render at their default visual weight, colored by ingested state (§2).
- No node is pre-selected. The attention panel shows its default content: the full needs-attention
  queue, ordered by domain (Structure → Scheduling Model → Time → Resources → Context), each item's
  root of origin named inline (e.g. "Time · lunch periods — 2 gaps".
- The ground line and both zones are static — no idle animation, no ambient motion. Consistent with
  the "motion explains state, never decorates" rule below.

### Hover (root nodes and domain labels)

- Trigger: pointer enters the node's hit area (see hit-target sizing below) or the domain trunk label.
- Response: the node scales via a **subtle static state**, not a hover-scale performance — per the
  Shoresh motion contract ("press only, no hover-scale performance"), hover is communicated by a
  **halo/ring appearing around the node** (2px ring, node's state color at 100% opacity, background
  wash at 12% opacity) and the node's caption label gaining a paper-halo background (see §5) for
  legibility, not by the node growing. If the node belongs to a domain (child node), the domain's
  root path (the connecting line from ground to that node) highlights at the same time — this is the
  "reveal detail + highlight the root path + its children" behavior: hovering a domain trunk
  highlights ALL its children faintly (8% opacity tint on their halos); hovering a single child
  highlights only itself and its direct parent path.
- A tooltip appears after a **300ms hover delay** (standard delay, avoids flicker on pass-through),
  positioned above the node, containing: the item's plain-language label, its state word ("Understood"
  / "Needs attention" / "Changed" / "Not in source"), and — only for needs-attention or changed items —
  a one-line reason ("3 groups conflict with roster count").
- Hover never opens the attention panel. It is preview-only.

### Click (root nodes)

- Trigger: primary click/tap on the node's hit area, or Enter/Space while focused.
- Response: the right-side attention panel's content is replaced (not appended) with that node's
  detail — for a leaf child node, its specific items; for a domain trunk node, all items under that
  domain, grouped by child. The clicked node gets a **selected** visual state (filled ring at 100%
  opacity, persists until another node or tile is clicked, or the panel is explicitly cleared via a
  "Show all" affordance at the panel's top).
- This is in-place: no route change, `onNavigate`/`screen` state in `App.jsx` is untouched. The
  metaphor stays on screen the entire time.
- Clicking a node that is fully "Understood" (nothing to resolve) still populates the panel — with a
  short confirmation list ("Understood — nothing needs your input here") rather than leaving the
  panel empty, so click always has a visible effect and never reads as broken.

### Click (summary tiles)

- Trigger: primary click/tap on one of the four tiles (Understood / Need attention / Changed / Not in
  source).
- Response: two coordinated effects, both required:
  1. The root system visually filters — non-matching nodes dim to 35% opacity (state color desaturates,
     no removal/layout shift), matching nodes stay at full opacity. This uses `opacity` transition
     only, never a layout-affecting property.
  2. The attention panel updates to show all items in that state, across all domains, flat-ordered by
     domain.
- Clicking the same tile again clears the filter (toggle), returning both zones to resting state.
- The active tile gets a **selected** visual state (border/underline in its state color, matches the
  node ring treatment for consistency of "selected" vocabulary across the screen).

### Keyboard

- Tab order: tiles (left to right, Understood → Need attention → Changed → Not in source) → root
  system domains in the fixed order Structure, Scheduling Model, Time, Resources, Context, each
  domain trunk node before its children (children in their existing left-to-right/authoring order) →
  attention panel's own internal focusables (item rows, then any panel-level "Show all" control).
- Canopy nodes are **not** in tab order unless they carry an actionable state (open question, §2) —
  if canopy is fully passive/decorative per this spec's resolution, it is `aria-hidden` and excluded
  from tab order entirely, keeping the tab sequence short and matching the "explainer, not nav"
  intent.
- Focus ring: uses the existing Shoresh focus treatment (2px, `--primary` outline, 2px offset) — do
  not invent a new focus style for this screen.
- Enter/Space on a focused root node performs the same action as click (populate panel, set selected
  state). Enter/Space on a focused tile performs the same action as clicking it.
- Arrow keys are not required to move between nodes — Tab is sufficient given the small total node
  count (5 domains × handful of children each); do not build a custom roving-tabindex grid for this
  screen, that complexity isn't earned by the node count.

### States per interactive node (exhaustive)

| State | Visual |
|---|---|
| Default | State-colored dot, no ring, caption label visible only if space allows (see §5 density rule) |
| Hover | 2px ring at 100% opacity in state color + 12% background wash + path highlight to parent/children + paper-halo caption + tooltip after 300ms |
| Focus (keyboard) | Same ring treatment as hover, PLUS the standard Shoresh focus outline (2px `--primary`, 2px offset) so focus is distinguishable from mouse hover for a11y review, even though the visual is close |
| Active (mid-click/mid-press) | Ring at 100% opacity, no additional wash — matches the "press only" motion contract's press-state expectation |
| Selected (panel is showing this node's content) | Filled ring persists at 100% opacity after release, does not require continued hover/focus |

### Hit targets

Root nodes render as small dots (per the locked metaphor), but the **clickable/hoverable area is a
44×44px invisible circle centered on the dot**, regardless of the dot's rendered diameter (spec'd at
8–10px in the visual layout half of this ADR). This is a `position: absolute` overlay or an
equivalently-sized transparent button element — never rely on the dot's own rendered size as the hit
area. At dense clusters (a domain with 5+ children close together), 44px circles will overlap; when
they do, z-order by the currently-hovered/focused node winning (its 44px area takes priority over
neighbors' in the overlap region) rather than shrinking hit areas below 44px.

## 2. State vocabulary and root/canopy relationship

### The four ingested states (roots only)

| State | Meaning | Token | Distinguishing mark beyond color |
|---|---|---|---|
| Understood | Shoresh parsed this cleanly and has no open question about it | `--secondary` (#2F6B58, pine) | Solid filled dot |
| Needs attention | Shoresh has a question or low-confidence read the director should confirm | Warm amber — closest existing token is `--accent` (#B8833A, brass); use it directly rather than introducing a new hex, since brass already reads as "attention" elsewhere in the app | Solid filled dot, plus a small dot-badge count if the item bundles multiple sub-questions |
| Changed | This differs from what was previously recorded (a re-import scenario) | `--primary` (#173B63, navy) | Solid filled dot with a thin diagonal-split fill (half previous-state color, half navy) is the ideal treatment IF budget allows; if not, solid navy alone is acceptable since "Changed" is the least accessibility-critical of the four (it's informational, not a call to action) |
| Not in source | Nothing in the imported file spoke to this at all | `--anchor` (#5C6B7A, slate) at low opacity, treated as absence | **Hollow ring only, no fill** — this is the mandated non-color distinguisher. A hollow dot reads as "absent" independent of color perception, satisfying the accessibility requirement that state not be color-only |

This reuses Shoresh's own committed palette exactly — no new hexes are introduced. `--danger`/brick
(#B44E48) is deliberately NOT used for any of the four states: brick is reserved for destructive/error
meaning elsewhere in the app, and "needs attention" here is a **question**, not an error — using brick
would overstate the severity and conflict with existing brick usage in ImportScreen/ReconciliationScreen
error banners.

### Does the canopy carry state?

**Resolution: the canopy is neutral/aspirational, not state-colored.** Rationale: the locked metaphor
defines canopy as "what grows from" the roots — it represents schedules, activities, maps, staffing as
an *output*, and those are covered by their own screens with their own state models (UNFILLABLE,
OVERLAP, etc. per the existing schedule flag vocabulary — see PLATFORM_STATE.md). Recoloring the
canopy with the ingest four-state vocabulary would imply the reconciliation screen is a second source
of truth for schedule health, which it is not and must not become. The canopy therefore renders in a
single neutral ink (`--text-secondary` or `--primary` at reduced opacity, TBD in the visual half) with
no per-node state, no hover detail beyond a static label, and is excluded from keyboard tab order (see
§1). This is the one place this spec makes a product decision rather than purely translating the
brief — it is flagged as an open question in §7 in case the owner intends otherwise.

## 3. How tiles, roots, and the attention panel tie together

Single source of truth: **the attention panel's content is always a filtered view of the same
underlying item list**, entered from one of three doors:

1. **Default (nothing clicked):** panel shows the full needs-attention queue only (not all four
   states — showing "Understood" items by default would bury the actionable ones). This is the
   panel's true resting state, distinct from the screen's overall resting state in §1.
2. **Tile click:** panel shows all items matching that tile's state, across all domains. Root system
   dims non-matching nodes (opacity filter, §1).
3. **Root node click:** panel shows all items belonging to that node (or, for a domain trunk, all
   items under it), regardless of state — mixing understood/attention/changed/not-in-source items
   that belong to that one root, so the director sees the full picture for that piece of their camp
   in one place. Root system does NOT dim other nodes in this mode (dimming is a tile-filter behavior
   only, not a node-selection behavior) — selection is communicated by the node's own ring instead.

A "Show all" text control pinned at the top of the panel always returns to state 1 (default) and
clears any tile/node selection. This is the only element that resets both zones at once.

Resolving an item inside the panel (the panel's own affordance, out of scope for this spec's detail
but assumed to exist per the ADR's other half) updates: the item's row (removed or marked resolved),
the origin root's dot state (recolors if the resolution changes its state, e.g. attention → understood),
and the relevant tile counts (decrement/increment). No page reload, no re-navigation — this is a
live, in-place model consistent with the rest of Shoresh's op-log-backed mutation pattern.

## 4. Motion

All motion in this screen obeys `src/index.css`'s committed contract exactly — no values invented
outside it:

| Moment | Duration | Easing | Property |
|---|---|---|---|
| Screen reveal (one-shot, on mount) | `--motion-settle` (340ms) | `--ease-out` | opacity + translateY(8px→0), i.e. the existing `importCardIn` pattern reused verbatim — a calm fade-lift, not staged/sequenced growth. All roots and canopy fade in together as one card-level reveal, not node-by-node choreography. |
| Hover ring/wash appear | `--motion-fast` (140ms) | `--ease-out` | opacity (ring + wash), within the 150-300ms UX guideline band |
| Hover ring/wash disappear | `--motion-fast` (140ms) | `--ease-out` | opacity |
| Tooltip appear | `--motion-fast` (140ms), after the 300ms hover delay | `--ease-out` | opacity + translateY(4px→0) |
| Node selected-ring commit (on click/Enter) | `--motion-fast` (140ms) | `--ease-standard` (press feel, not ease-out's settle feel) | opacity/scale of ring only — no scale on the dot itself |
| Tile filter (root dim/undim) | `--motion-base` (220ms) | `--ease-out` | opacity only |
| Panel content swap | `--motion-base` (220ms) | `--ease-out` | opacity cross-fade of panel body; do NOT slide/translate the panel itself (panel position is fixed chrome, only its content changes) |

Explicitly forbidden per the locked contract: any spring/bounce/overshoot easing, any hover-triggered
scale-up of a node (hover is ring+wash only, per §1), any orchestrated multi-step page-load sequence
(the reveal is one fade-lift, not roots-then-canopy-then-tiles staging), and any animation on
`width`/`height`/`gridTemplate` for the filter or panel-swap moments (opacity only, to avoid layout
thrash per the UX guideline against animating box-model properties).

**Reduced motion:** under `prefers-reduced-motion: reduce`, the mount reveal is instant (no fade/lift —
render at final opacity/position immediately), hover ring/wash and tooltip appear/disappear without
transition (instant show/hide), and the tile-filter opacity change and panel content swap likewise
apply instantly. Every state remains fully legible with zero animation — nothing depends on motion to
convey information (state is always also color + shape, e.g. the hollow ring), only on *timing* of
when it appears, which reduced-motion collapses to zero without losing meaning.

## 5. Accessibility and responsive behavior

- **Contrast:** node caption labels must hit 4.5:1 against whatever sits behind them. Because roots
  sit over a soil/root-texture background (not flat `--bg`), captions render inside a **paper-halo**:
  a small rounded rect in `--surface` (#FCFBF8) at 92% opacity behind the label text, sized to the
  text plus 4px padding. This was an explicit defect in the earlier prototype (labels-over-roots were
  hard to read) and is now mandatory, not optional, for every caption in both roots and canopy.
- **Color independence:** the "Not in source" hollow-ring treatment (§2) is the only state that risks
  reading as color-only elsewhere; the other three all differ in fill (solid vs. hollow) so no state
  in this model relies on hue alone.
- **Focus visibility:** per §1, keyboard focus always shows both the hover-equivalent ring AND the
  standard Shoresh focus outline, so a screen reader/keyboard user's position is never ambiguous even
  at a glance.
- **Icons:** any iconography used in tiles or the attention panel (state icons, resolve/dismiss
  controls) must be SVG, matching Shoresh's existing icon discipline — no emoji anywhere on this
  screen.
- **Semantics:** tiles are real `<button>` elements with `aria-pressed` reflecting filter-active state.
  Root nodes are real `<button>` elements (not `<div onClick>`) with an `aria-label` combining the
  item's plain-language name and its state word (e.g. `aria-label="Lunch periods — needs attention"`),
  so the accessible name carries the same information the tooltip shows visually. The attention panel
  is a labelled region (`aria-label="Needs your attention"`) so it's independently navigable by
  landmark.

### Responsive behavior (desktop Electron app — primary target, but define narrowing)

This is a desktop-primary Electron screen; there is no mobile Shoresh client. "Responsive" here means
graceful behavior across the window sizes a director might actually resize the app to, not a phone
layout.

| Width | Behavior |
|---|---|
| 1440px+ (comfortable default) | Full three-zone layout: tiles row, root/canopy centered, attention panel fixed-width right rail (owner's mockup intent). |
| 1024–1439px | Root/canopy system scales down proportionally (SVG/vector-based, not raster, so this is a viewBox scale, not a redraw) — same node count, same hit-target minimum (44px stays absolute, never scales below it even if the dot art shrinks). Attention panel narrows but does not collapse; if content wraps awkwardly at this width, truncate item labels with an ellipsis and rely on the item's own detail view (not in this spec's scope) rather than wrapping the panel to two lines per row. |
| 768–1023px (minimum supported, per the platform's general narrowing floor) | Attention panel collapses to a slide-over/toggle rather than a persistent right rail — a header control ("3 need attention") opens it as an overlay above the root system rather than squeezing both into a cramped side-by-side. Root/canopy continues to scale down to this floor; below 768px is out of scope since Shoresh is not a touch/mobile product. |

No horizontal scroll is introduced at any of these widths — this is a hard UX guideline (§ table
priority 5) and this screen has no reason to violate it given the metaphor is a bounded vector
illustration, not a data table.

## 6. Copy

Plain Shoresh voice: active, specific, addressed to a non-technical camp director, no apology, no
jargon about "ingestion" or "parsing" in user-facing strings (those words are fine in this spec and in
code, not in the UI).

- **Header:** "Shoresh reconstructed your camp." (as given — keep verbatim, it's already in the
  product's register: plain declarative, past tense, names what happened without narrating the
  mechanism).
- **Tile labels:** "Understood" / "Need attention" / "Changed" / "Not in source" — four words, sentence
  case, no colons, no counts baked into the label text itself (the count is a separate large numeral
  element per typical tile layout, not concatenated into the string).
- **Attention panel header:** "Needs your attention" (matches the locked spec language exactly).
- **Panel default-empty state** (if the queue is genuinely empty — everything understood): "Nothing
  needs you right now. Shoresh understood everything it found." — reassuring, specific, no exclamation
  point (matches the "quiet, precise" personality).
- **Absent-domain caption** (Context domain when nothing in the source spoke to culture/operations at
  all): "Context — nothing about camp culture was in this file yet." (as given). The trailing "yet"
  matters — it frames absence as a future opportunity to add detail, not a failure of the import, and
  should be preserved in this exact form rather than shortened to "Context — not in source" (which
  reads as a system-state label, not a directed sentence to the director).
- **Root system caption** (the small explainer label near the ground line, orienting a first-time
  viewer to what they're looking at): "The root system — what Shoresh took in." (as given).
- **Canopy caption**, parallel construction to the root caption so the metaphor reads as one sentence
  split across two zones: "What grows from it." — deliberately short, since the canopy is neutral/
  passive per §2 and shouldn't compete with the roots for the reader's attention.
- **Node tooltip reason line** (needs-attention/changed items only, per §1): plain cause-and-effect,
  e.g. "3 groups conflict with roster count", "Times don't match last year's file" — always names the
  specific discrepancy, never a generic "please review."

## 7. Open questions for the owner/Governor

1. **Does clicking a domain trunk expand its children inline (revealing more of the root drawing) or
   only populate the panel?** This spec resolves it as panel-only (§1) to keep the metaphor purely an
   explainer with zero layout mutation on click — an inline expand would start to feel like a
   collapsible tree control, which the brief explicitly rules out ("NOT navigation"). Confirm this
   reading before Maker builds it, since an expand-on-click model would change the hit-target and
   motion sections substantially.
2. **Is Context worth showing at all when its source data is entirely absent?** This spec assumes yes
   — Context always renders as a domain trunk with the "nothing about camp culture" caption (§6) rather
   than being omitted, because omitting a whole domain would break the promise that all five domains
   are always visible (consistent explainer, not a variable-length list) and would remove the
   invitation-to-add-detail framing the copy relies on. Flag if the owner instead wants domains with
   zero content hidden entirely.
3. **Does the canopy carry any state at all**, even a coarse one (e.g. "schedule not yet started" vs.
   "schedule in progress")? This spec resolves it as fully neutral (§2) on the grounds that schedule
   state already has its own vocabulary elsewhere in the app and duplicating it here risks two sources
   of truth. Confirm, since if the owner wants a coarse canopy signal it changes §2, §4 (canopy would
   then need its own transition), and §5 (canopy nodes would need to reenter tab order).
4. **Multi-item bundling under one root node** — when a node's tooltip mentions "3 sub-questions" (§2),
   does clicking that node show all 3 as separate rows in the panel, or as one row that expands? This
   spec assumes separate rows (simplest, consistent with "flat-ordered by domain" in §3) but the panel's
   own internal layout is technically out of this spec's scope and belongs to the visual/layout half of
   the ADR — flagging so the two halves don't diverge on this point.
5. **Does resolving the last needs-attention item under a domain trigger any acknowledgment** (e.g. a
   brief "all clear" moment on that node) beyond the plain state recolor described in §3? This spec
   intentionally specifies no celebratory motion here — recoloring is enough per the "motion explains
   state, never decorates" rule — but flagging in case the owner wants a small one-shot moment
   (would need new motion values scoped separately, not reusing hover/select tokens).
