---
title: W3 — Roots Metaphor Visual (foundation-first, Operate-mode)
document_type: spec
status: approved
created: 2026-08-21
archive_when: the metaphor Roots view is implemented and merged or superseded
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
parent_spec: [docs/work/specs/camp-setup-ingestion-program.md]
supersedes:
  - docs/work/specs/2026-08-17-roots-visual-expression-brief.md
  - docs/work/specs/2026-08-18-rootmap-asset-kit.md
---

# DESIGN SPEC — Roots Metaphor Visual (foundation-first stacked layout)

The owner compared two prototypes and chose **Pole 1**: metaphor lives in structure and motion, not
illustration. This spec replaces `RootMap.jsx`'s painted-backdrop-and-orbs layout with a foundation-first
stacked layout of domain layers containing entity chips. It is implementation-facing — it assumes the
Maker will edit real files, not build another prototype.

**Reference prototype (read before implementing):**
`/private/tmp/claude-501/-Users-gregfeitel-dev-shoresh--claude-worktrees-camp-setup-ingestion-0ce0e1/5d3b0f85-cefd-48c5-ab1c-e3fc0e83de14/scratchpad/roots-proto-metaphor.html`
It is a static demo with its own token names and only two states shown per chip (`needs-attention`
confirms → `understood` locally). Treat it as the visual/motion reference only — this spec's data
model, state names, and interaction contract are the real ones from the current codebase and override
anything the prototype's throwaway JS does differently (e.g. the prototype has no `changed`→`understood`
distinction beyond label text, no `not_set_up` empty-domain nuance beyond one demo row, and no crown
filter cluster — those are specified fresh below from the real component).

## What this supersedes

- `docs/work/specs/2026-08-17-roots-visual-expression-brief.md` (status: draft) — superseded in full.
- `docs/work/specs/2026-08-18-rootmap-asset-kit.md` (status: draft) — superseded in full; the asset kit
  it specified (backdrop art + 5 orb sprites) is being deleted, not extended.

Maker should flip both files' frontmatter `status` to `superseded` (pointing at this spec) as part of
the same change, per the doc-staleness governance gate.

## What stays exactly as-is (do not touch)

- **Data model**: `buildRootMapModel()` in `src/ingest/rootMapModel.js` and its return shape
  (`{ domains }`, each domain `{ key, label, state, x, y, children }`, each child
  `{ key, name, count, state, x, y, decisionIds, roster }`). The `x`/`y` normalized coordinates become
  **unused** by the new layout (see below) but the fields themselves are not the Maker's to remove from
  this spec's scope — leave `rootMapModel.js` alone unless a follow-up ticket says otherwise.
- **State vocabulary**: domain-level `understood | attention | changed | absent | not_set_up` (Context
  domain only uses `absent`); child-level `understood | attention | changed | not_set_up`.
- **`STATE_TOKEN` color map** (RootMap.jsx lines 27-38): `understood → var(--secondary)`,
  `attention → var(--accent)`, `changed → var(--primary)`, `absent → var(--anchor)`,
  `not_set_up → var(--border)`. Reuse verbatim.
- **Selection contract**: `selection: { type: 'none' } | { type: 'tile', state } | { type: 'node', domainKey, childKey? }`,
  and the `onSelectTile(state)` / `onSelectNode(domainKey, childKey)` / `onClearSelection()` callbacks
  wired in `src/screens/ReconciliationScreen.jsx` (`selectTile`/`selectNode`/`clearSelection`, lines
  ~502-510). RootMap keeps this exact prop surface — ReconciliationScreen and RootMapPanel do not change.
- **`RootMapPanel.jsx`** (the inspector) — untouched. It already reads `selection` independently of how
  RootMap paints itself.
- **The 4 state-count filter toggles** (today's `CrownCluster`, RA-9/RA-10, PR #130) — this is the
  "filtered by state" affordance (`tileCounts` per `TILE_STATES = ['understood','attention','changed','absent']`,
  clicking one sets `selection = { type: 'tile', state }`, clicking the active one clears it). **Keep this
  control**, but it stops being a crown hanging above painted roots — see Layout below for its new home.
- **Confirm mechanic**: there is no dedicated "confirm" handler on RootMap/RootMapPanel today — the
  attention→understood transition happens via `stage(decisionId, answer)` inside `RootMapPanel`
  (`onAnswer`), which triggers a model rebuild that flips `stateOf()`. This spec's "takes root" animation
  is purely a **visual response to a state prop change** (old state was `attention`, new state is
  `understood`, on the same `key`), not a new interaction to wire. See Animation → "Takes root" trigger.

## What is retired

- `RootMap.jsx`'s `<img rootMapArt>` backdrop, the `Node` SVG/`<image>` sprite rendering, the
  lantern-hook `<line>` decorations, the glow-blur `<filter>`, and the `CrownCluster` SVG group's
  absolute crown-anchor math (`NODE_BAND_CEILING_Y`, `CROWN_TAG_OFFSETS`, `CROWN`, `computeNodeBandCeilingNormalized`).
- `src/components/reconciliation/rootMapLayout.js` — the hand-projected `NODE_LAYOUT` coordinate table
  and `layoutForChild()` fallback are **obsolete for this view**: the new layout is CSS document flow
  (flex column of domain layers, each a flex-wrap row of chips), not projected `x`/`y` percentages onto
  a backdrop image. Retire the file (or leave it in place unused only if another consumer needs it —
  confirm none does before deleting; grep found only RootMap.jsx importing it).
- Delete these now-dead asset files (grep confirmed no other `src/` references):
  - `src/assets/reconciliation/root-map-3d.webp`
  - `src/assets/reconciliation/orb_understood.png`
  - `src/assets/reconciliation/orb_attention.png`
  - `src/assets/reconciliation/orb_changed.png`
  - `src/assets/reconciliation/orb_absent.png`
  - `src/assets/reconciliation/orb_not_set_up.png`
  (Note: `root-map.png` and `root-map-3d.png` referenced in the original task brief do not actually
  exist in the tree — only the `.webp` above does. No action needed for the non-existent filenames.)

## Layout

Replace the `<img>` + absolutely-positioned `<svg>` canvas with a plain block layout, matching the
prototype's DOM shape but built as React components with inline styles (this file lives under
`src/components/reconciliation/`, **outside** the `src/components/schedule/` CSS-file exception, so no
new stylesheet — everything is inline style objects per `DESIGN_STANDARD.md` / `CLAUDE.md`).

```
<RootMap>
  <FilterRow>                          — the 4 state-count toggles (ex-CrownCluster), now a plain
                                          horizontal row of buttons above the domain stack, not hung
                                          from a crown. Order: understood, attention, changed, absent
                                          (same order TILE_STATES already uses).
  <DomainStack>                        — flex column, gap 10px between domain layers
    <DomainLayer> × 5, one per model.domains[i], in the SAME top-to-bottom order the model already
                                          provides (Structure, Scheduling, Time, Facility, Context —
                                          root-depth order, unchanged from today's data)
      <DomainHead>
        depth-mark dot (state-colored, 6px circle)
        domain label (DOMAIN_LABELS[domain.key])
        domain status text, right-aligned (STATE_LABEL, see Status vocabulary below)
      <ChipRow>                        — flex-wrap row, gap 8px, top margin 14px
        <Chip> × domain.children.length, OR
        <EmptyDomainNote>              — when domain.children.length === 0
```

- `FilterRow` renders once, above `DomainStack`, not per-domain.
- Each `DomainLayer` is a `<div>` with `border: 1px solid var(--border)`, `border-radius: 8px`,
  `background: var(--surface)`, `padding: 18px 20px 20px`. No 3D/backdrop art anywhere in this view.
- `ChipRow` items are the reconciliation unit — same semantic as today's per-child SVG `Node`, now an
  HTML `<button>` chip, not an `<image>` sprite.
- Domain layers render even when a domain currently has zero children (Context, pre-import) — see
  Empty-domain treatment below. Do not hide empty domains; their absence-of-roots is itself information.

## Visual Style

Reuse `DESIGN_STANDARD.md` tokens exactly; do not introduce new hex values (the prototype's raw hex
`--understood/--attention/--changed/--not-in-source/--not-set-up` custom properties are a prototype-only
convenience — in the real component, use the existing `STATE_TOKEN` map to `var(--secondary)` /
`var(--accent)` / `var(--primary)` / `var(--anchor)` / `var(--border)`).

- **Domain layer surface**: `background: var(--surface)`, `border: 1px solid var(--border)`,
  `border-radius: 8px` (match existing radius convention, not the prototype's `10px`).
- **Domain head**: flex row, `justify-content: space-between`, `align-items: center`.
  - depth-mark: 6px circle, `background: STATE_TOKEN[domain.state]`.
  - domain name: existing heading weight/size used elsewhere in ReconciliationScreen headers (do not
    invent a new type scale — DESIGN_STANDARD.md has no dedicated type scale; match the nearest existing
    section-header style in `src/screens/ReconciliationScreen.jsx`).
  - domain status text: `color: var(--text-secondary)`, `font-size: 11.5px`, `font-weight: 600`,
    `letter-spacing: 0.04em`, `text-transform: uppercase` (prototype values — fine as inline styles,
    these are typographic treatment values, not new design tokens).
- **Chip** (`<button>`):
  - `display: inline-flex; align-items: center; gap: 8px`
  - `padding: 9px 14px 9px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--elevated)` — if `--elevated` is not a defined token in DESIGN_STANDARD.md, use `var(--surface)` with a 1px lighter border instead; confirm against the standard before implementing, do not invent `--elevated`.
  - state dot: 8px circle, `background: STATE_TOKEN[child.state]`.
  - chip border tints toward the state color when `understood`/`changed`: use
    `border-color: color-mix(in srgb, ${STATE_TOKEN[state]} 30-35%, var(--border))` (prototype's exact
    approach) — this is a per-chip inline computed style, not a CSS rule, consistent with the "data-derived
    colours stay inline" rule in CLAUDE.md.
  - label text: `color: var(--text)`.
  - status sub-label: `color: var(--text-secondary); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em`.
  - clickable chips (state === `attention`) get `cursor: pointer` and a hover border tint to
    `var(--accent)`, gated `@media (hover: hover) and (pointer: fine)` per the existing pattern already
    used in RootMap's current `Node` (finePointer check) — reuse that same `hasFinePointer()` helper,
    don't reimplement.

## Status vocabulary (pin exactly — do not let Maker improvise labels)

| state (child) | label shown | color token |
|---|---|---|
| `understood` | "Rooted" | `var(--secondary)` |
| `changed` | "Rooted · Changed" | `var(--primary)` |
| `attention` | "Not yet rooted" | `var(--accent)` + pulse |
| `not_set_up` | "Not started" | `var(--border)` |

Domain-level status text uses the same label set, keyed off `domain.state` (which additionally can be
`absent` — Context domain only, import mode; when it occurs, label domain status "Not in source",
`var(--anchor)`, no pulse). Do not reuse `not_set_up`'s "Not started" for `absent` — they mean different
things (per `rootMapModel.js`'s existing distinction) and must stay visually distinct.

## Empty-domain treatment

When `domain.children.length === 0` (Context, before any import touches it): render, in place of
`ChipRow`, a single line: `"No entities imported yet — this layer has no root."`
(`font-size: 13px; color: var(--text-secondary); font-style: italic; margin-top: 12px`). Exact copy from
the prototype — keep it verbatim, it is already in the app's voice (plain, specific, no jargon).

## States

- **Chip default** (`understood`/`changed`/`not_set_up`): static, no animation, no pulse.
- **Chip attention** (`needs-attention` equivalent = `attention`): pulsing box-shadow, clickable.
- **Chip hover** (fine pointer, clickable chip only): border tints to `var(--accent)`; a
  `confirm-hint` label ("Click to confirm →", `color: var(--accent)`, `font-size: 11px; font-weight: 600`)
  fades/slides in from `opacity: 0; transform: translateX(-4px)` to `opacity: 1; transform: translateX(0)`
  over `var(--motion-fast)` `var(--ease-out)`.
- **Chip focus** (keyboard): same affordance as hover but must not depend on `hover` media query — show
  the hint on `:focus-visible` unconditionally (this is an accessibility requirement the prototype's
  demo didn't need to handle but the real component must, per the existing `Node` component's
  `focused` state pattern).
- **Chip pressed**: `transform: scale(0.97)` per emil-design-eng button-press convention (prototype
  already has this on `:active`).
- **Domain layer**: no interactive states of its own (not clickable as a unit in this pass — domain-level
  aggregation is read-only status, consistent with today, where clicking a domain node was itself
  optional/secondary to child nodes). If Maker finds the current `RootMap.jsx` treats the domain-level
  node as independently selectable (`onSelectNode(domainKey, null)`), **preserve that** — wrap the
  `DomainHead` in the same selectable affordance (button semantics, `aria-pressed`), just restyled to fit
  the flat layer header instead of an SVG lantern.

## Interactions

1. **Filter row click** (unchanged behavior, restyled container): clicking a state count toggle sets
   `selection = { type: 'tile', state }`; clicking the already-active one clears it
   (`onClearSelection()`). Reuse existing `TILE_STATES` order and `tileCounts` computation verbatim from
   current `RootMap.jsx` (lines 364-370) — this logic is pure data derivation, not layout-specific, and
   does not change.
2. **Chip click** (state === `attention` only is clickable per prototype's `data-clickable` pattern —
   but confirm this matches real behavior: today's real `Node` makes **every** node clickable
   (`onSelect={() => onSelectNode(...)}`) regardless of state, to open the inspector panel. **Do not
   narrow this** — the prototype's "only attention chips are clickable" is a demo simplification for its
   throwaway confirm flow. In the real component, every chip (any state) must remain clickable to drive
   `onSelectNode(domainKey, childKey)`, matching current behavior. The "Click to confirm →" hint only
   shows for `attention`-state chips (that's the one where there's actually something to resolve); other
   states are still clickable to open the panel, just without that hint.
3. **Chip dimming under tile-filter selection**: reuse the existing `dimmed(domainKey, childKey)` logic
   (RootMap.jsx lines 354-362) — when a state-count filter is active, non-matching chips (and the
   `not_set_up`/`absent` states not covered by that filter) drop to `opacity: 0.35` with
   `transition: opacity var(--motion-base) var(--ease-out)`. Applies at the chip level now instead of the
   `<g opacity>` SVG wrapper.
4. **Chip selection**: `selected` chips (matching current `selection`) get a visibly distinct border,
   e.g. 2px `border-color: STATE_TOKEN[state]` (replacing the SVG glow-blur halo, which has no HTML
   equivalent worth reproducing — a crisp border is the correct on-token substitute, not a fake box-shadow
   glow).

## Animation

All durations/easings below are DESIGN_STANDARD.md's existing motion tokens
(`--motion-fast: 140ms`, `--motion-base: 220ms`, `--motion-settle: 340ms`, `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`)
— no new custom cubic-béziers, matching the prototype's values 1:1 since the prototype already used
these exact numbers (it just named its own local vars `--fast`/`--base`/`--settle`).

### Page entrance (domain layers stagger in)
- Each `DomainLayer` animates `opacity: 0 → 1, transform: translateY(10px) → translateY(0)` over
  `var(--motion-settle)` `var(--ease-out)`, **staggered 60ms per layer** (`animation-delay: ${index * 60}ms`),
  matching the prototype exactly. Use CSS `@keyframes` (not springs) — this is a one-shot mount
  animation, not gesture-driven, so `emil-design-eng`'s "transitions over keyframes" rule doesn't apply
  here (nothing interrupts a page-load stagger).
- Header (eyebrow/h1/lede if RootMap has an equivalent header — confirm against ReconciliationScreen;
  if the header lives outside RootMap, skip this) uses the same `settle`/`ease-out` fade+rise, no stagger.

### Attention pulse (reuse, do not reinvent)
- Reuse `src/index.css`'s existing `@keyframes rootmapPulse` and `.rootmap-orb--pulse` class verbatim:
  ```css
  @keyframes rootmapPulse {
    0%, 100% { opacity: 0.22; }
    50%      { opacity: 0.75; }
  }
  .rootmap-orb--pulse { animation: rootmapPulse 2400ms ease-in-out infinite; }
  ```
  and its existing reduced-motion guard (`.rootmap-orb--pulse { animation: none !important; }`).
- **Adapt the target, not the keyframe**: today this animates an SVG glow-blur circle's `opacity`. The
  new chip has no separate glow layer — apply the pulse to a `box-shadow` on the chip itself instead
  (matching the prototype's `attentionPulse` keyframe:
  `box-shadow: 0 0 0 0 rgba(184,131,58,0) → 0 0 0 7px rgba(184,131,58,0.14), 0 0 14px 2px rgba(184,131,58,0.18)`,
  `2400ms ease-in-out infinite`). Since the rgba here is hardcoded to `--accent`'s value (`#B8833A`),
  Maker should generate it from `var(--accent)` via `color-mix` rather than a literal rgba, to stay
  token-derived: e.g. `box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 14%, transparent), 0 0 14px 2px color-mix(in srgb, var(--accent) 18%, transparent)`.
  Add this as a **new** keyframe (`chipAttentionPulse`) alongside the existing `rootmapPulse` in
  `src/index.css` rather than overloading the old one, since the animated property differs
  (`box-shadow` vs `opacity`) — keep `rootmapPulse`/`.rootmap-orb--pulse` in place only if some other
  still-SVG consumer needs it; if RootMap was its only consumer, retire it alongside the SVG code and
  ship only the new chip keyframe.
- Reduced-motion: `.chip[data-pulse] { animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }` inside the existing `@media (prefers-reduced-motion: reduce)` block in `src/index.css` — static ring instead of pulse, never zero affordance (per apple-design §14: reduced motion means gentler, not absent).

### "Takes root" — the signature confirm micro-animation
**Trigger**: a chip's `state` prop transitions from `attention` (or `changed`) to `understood` between
renders (i.e., the model rebuilt after `stage()`/`onAnswer` resolved the underlying decision). This is a
**prop-change-driven** animation, not a click handler — RootMap has no confirm handler of its own (see
"What stays as-is" above). Detect the transition with the same pattern already used elsewhere in
RootMap.jsx for entering/exiting state (`useState` + compare-on-render, as seen in the current `Node`
component's `labelEntered`/`prevShowLabel` pattern) — track "was this child's state `attention`/`changed`
on the previous render, is it `understood` now," and if so, apply the animation class for one cycle.

- **Sequence** (compress-then-overshoot, matching the prototype's `takeRoot` keyframe exactly):
  ```css
  @keyframes chipTakesRoot {
    0%   { transform: scale(1); }
    30%  { transform: scale(0.94); }
    62%  { transform: scale(1.045); }
    100% { transform: scale(1); }
  }
  ```
  Duration `var(--motion-settle)` (340ms), timing `var(--ease-out)`, single iteration
  (`animation-iteration-count: 1`), applied via a transient class/data-attribute
  (`data-rooting="true"`) removed on `animationend` (mirrors the prototype's
  `node.classList.add('rooting')` / `animationend` cleanup exactly — implement with a `useState` +
  `onAnimationEnd` React handler, not manual DOM listeners).
- **Root-tick line**: a 2px-tall bar spanning the chip's inner width (`left: 12px; right: 12px;
  bottom: -1px`), `background: var(--secondary)` (the "understood" color — always green regardless of
  which state it came from, since it always lands on `understood`), draws in and fades:
  ```css
  @keyframes chipRootTick {
    0%   { transform: scaleX(0); opacity: 0.9; }
    70%  { transform: scaleX(1); opacity: 1; }
    100% { transform: scaleX(1); opacity: 0; }
  }
  ```
  Same duration/easing/iteration-count as the scale animation, running concurrently on a child `<span>`
  positioned `absolute` inside the chip (chip needs `position: relative`), `transform-origin: left center`.
- **Reduced motion**: `data-rooting` variants get `animation: none` for both the scale and the tick — the
  chip still updates its color/label/dot instantly (that's a state change, not motion, and stays per
  apple-design §14's "keep opacity/color changes that aid comprehension" — actually here it's more than
  opacity/color, it's a discrete content swap, which is fine under reduced motion since it's instantaneous
  rather than animated).
- **Do not add a toast.** The prototype's toast ("[Entity] has taken root") is a prototype-only
  affordance for its standalone demo; the real screen already has `RootMapPanel`/`stage()` feedback
  mechanisms and existing UX for confirming decisions (per ReconciliationScreen's `runDryRun` /
  `apply()` flow) — introducing a second, uncoordinated toast risks conflicting with whatever confirmation
  feedback already exists there. If Maker believes a toast is genuinely missing, that's a separate,
  smaller follow-up, not part of this spec.

### Hover/selection dimming, chip border/dot color changes
Reuse existing transition treatment already on RootMap's current `Node`/dimming code:
`transition: border-color var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out)`
on the chip, `transition: opacity var(--motion-base) var(--ease-out)` on the dimming wrapper. No new
values needed here — same durations the current component already uses.

## Reduced-motion summary (must all be true)

- Page-entrance stagger: `.domain-layer, .chip-row-hero { animation: none; opacity: 1; transform: none; }` (per prototype's own reduced-motion block, adapted).
- Attention pulse: replaced by a static ring (above).
- "Takes root": scale+tick keyframes suppressed; the discrete state/label/color/dot change still happens instantly.
- Hover/focus confirm-hint: opacity/transform transition may keep a short cross-fade (opacity-only changes are allowed under reduced motion per apple-design §14) — keep `opacity` transition, drop any `transform: translateX()` companion under the media query if Maker wants to be strict, though this is a minor, low-risk motion and not required to change.
- Add all of the above inside the **existing** `@media (prefers-reduced-motion: reduce)` block in `src/index.css` — do not create a second block.

## Responsive behavior

- `ChipRow` is `flex-wrap: wrap` — chips reflow naturally at narrow widths, no breakpoint logic needed.
- `FilterRow` (ex-crown) should also wrap on narrow viewports (`flex-wrap: wrap; gap: 8px`) rather than
  compress — 4 toggle buttons side-by-side is the desktop case, 2×2 wrap is acceptable at narrow widths.
  Since Shoresh is an Electron desktop app (not phone-responsive per the app's actual usage), this is a
  minimum-viable-wrap safeguard, not a mobile-first redesign — don't over-invest here.
- No horizontal scroll container needed anywhere in this view (unlike the schedule grid) — this is a
  vertical stack, not a dense repeated grid.

## Accessibility

- Every chip is a real `<button type="button">` (not a styled `<div>`), consistent with the current
  `Node` component's `<foreignObject><button/></foreignObject>` pattern — except now there's no
  `foreignObject` wrapper needed since we're plain HTML, not SVG.
- `aria-label` per chip: `"${child.name} — ${STATE_LABEL[child.state]}"` (exact pattern reused from
  current `Node`'s `aria-label={`${label} — ${STATE_LABEL[state]}`}`).
- `aria-pressed={selected}` on chip, matching current pattern.
- Domain-layer header, if made selectable (see States → "Domain layer" above), needs the same
  `aria-label`/`aria-pressed` treatment.
- Filter-row toggle buttons keep their existing `aria-pressed={active}` (already present in `CrownCluster`, carry forward unchanged).
- Focus-visible outline: rely on the browser/app's existing default focus ring unless RootMap's current
  code overrides it — grep for a global `:focus-visible` rule before adding a component-specific one;
  don't introduce a second focus-ring convention.
- Keyboard order: filter row, then domain layers top-to-bottom, chips left-to-right within each — natural
  DOM order in plain HTML flow, no `tabIndex` juggling needed (this is strictly simpler than the current
  SVG's manual DOM/tab-order comment about crown-before-nodes, since flow order now equals visual order
  automatically).

## Prototype

`/private/tmp/claude-501/-Users-gregfeitel-dev-shoresh--claude-worktrees-camp-setup-ingestion-0ce0e1/5d3b0f85-cefd-48c5-ab1c-e3fc0e83de14/scratchpad/roots-proto-metaphor.html`
— visual/motion reference only, as noted above. This is a scratchpad file, not committed to the repo;
Maker should treat its exact CSS values as the source of truth for numbers (spacing, radii, keyframe
percentages) but must map every color through `STATE_TOKEN`/DESIGN_STANDARD tokens rather than the
prototype's own hardcoded hex custom properties, and must follow this spec's data/interaction contract
(which differs from the prototype's simplified demo logic) over the prototype's JS.

## Implementation Notes for Maker

- This is a **rewrite of `RootMap.jsx`**, not a new file — keep the same export signature:
  `export default function RootMap({ model, selection, onSelectTile, onSelectNode, onClearSelection, canvasWrapRef })`.
  `canvasWrapRef` currently wraps the `<img>+<svg>` canvas div — repoint it to wrap the new
  `DomainStack` container (grep for other consumers of `canvasWrapRef` before assuming it's purely
  cosmetic; it may be used for scroll-into-view or measurement elsewhere in ReconciliationScreen).
- Delete the `NODE_LAYOUT`/`x`/`y` consumption entirely from RootMap.jsx — do not attempt to reuse the
  coordinates for e.g. initial chip ordering; use `model.domains[i].children` array order as-is (already
  deterministic from `rootMapModel.js`).
- Remove the 5 `orb_*` imports and `rootMapArt` import from RootMap.jsx; delete the underlying asset
  files per "What is retired" above once nothing imports them (verify with a repo-wide grep after the
  edit, not just a visual check).
- `hasFinePointer()` helper — keep this function, it's still needed for the hover confirm-hint gating.
- The `dimmed()` function and `tileCounts` computation (RootMap.jsx lines 354-370) are pure logic,
  unrelated to SVG — port them unchanged.
- `STATE_LABEL` object in current RootMap.jsx (lines 40-46) uses different label text than this spec's
  "Rooted"/"Not yet rooted"/"Rooted · Changed"/"Not started" — **this spec's labels are the new canonical
  ones for chip sub-text**, replacing the current `STATE_LABEL`. Confirm `RootMapPanel.jsx` doesn't also
  import and rely on the old `STATE_LABEL` strings for its own header text before renaming/removing it
  (if it does, keep the old map exported separately, e.g. `PANEL_STATE_LABEL`, distinct from the new
  chip-facing `STATE_LABEL`, so panel copy doesn't silently change too — that's out of scope here).
- Test coverage: RootMap.jsx likely has existing tests asserting SVG structure (`<circle>`, `<image>`,
  node positions) — these will break wholesale and need rewriting against the new DOM shape (buttons,
  divs). This is expected, not a regression signal; Maker should rewrite the test file's assertions
  around the new chip/layer DOM, not attempt to preserve SVG-shaped assertions.

---

## Governor consolidation — adhd + emil + impeccable + feasibility audit (2026-08-21)

AUTHORITATIVE. Refines the baseline above where the three craft passes and the provenance
feasibility audit changed the direction. Where it conflicts with the baseline, this wins.

### Through-line (POV)
The Roots view is an **Operate** surface: a director *certifying their camp's foundation*. The root
metaphor earns its place only where it makes that task faster or more trustworthy — as **information
and precise detail, never spectacle**. The tool disappears into the task.

### Refinements to the baseline
- **CUT the orchestrated entrance stagger.** Operate rule: no page-load sequences. Replace the
  60ms/layer cascade with at most a single quiet ~150ms fade-in of the whole stack, or nothing.
- **Instant press-feedback on confirm (Emil).** Confirmable chip gets `transform: scale(0.97)` @
  ~120ms `ease-out` on `:active`, fired the instant it's pressed, independent of the "takes root"
  settle. The settle plays as a CSS TRANSITION (not keyframe, so rapid confirms retarget), animating
  transform+opacity+color ONLY (GPU), ~200–250ms `var(--ease-out)`. Root-tick underline kept, under
  the 300ms feel.
- **Pulse: scope it.** Pulse only within the currently focused/selected domain layer, not every
  attention chip at once. Elsewhere attention reads by color + status text. Keep reduced-motion guard.
- **Reserve any weighted/deliberate gesture for REJECT, never routine confirm.** Confirm is frequent
  → single crisp action. Reject/uproot is rare → may carry more weight, but as a standard restrained
  affordance, not a theatrical animation.
- **Full component states (Operate).** Every chip ships default, hover, focus-visible, active,
  disabled. Empty-domain state TEACHES ("Nothing has taken root yet — this layer has no root"). The
  RootMapPanel inspector overlay must not be clipped by an `overflow` ancestor.
- **Restrained color.** State/accent colors for state + selection only; no full-saturation on
  inactive chips.
- **Drop the whimsy** from ideation (worms, watering-can, heaving roots, canopy payoff, contractile
  reordering, scroll-into-buried-soil): strangeness without purpose / fights scanability. Not built.

### Information layer — provenance + "why unsure" (SHIPS NOW, per owner "include if data exists")
The data largely exists and is already threaded to the render boundary; build the glanceable-at-rest
layer from data ALREADY present, keeping full detail in the existing RootMapPanel/DecisionCard.
- Each node exposes `decisionIds`; `RootMapPanel.jsx` (~:103) already builds `byId` from the decision
  lanes. Decision-backed nodes have `confidence` (high→"clearly stated", medium→"inferred from
  context", conflict→"in conflict"), `reason` (human text), `unknowns` (which fields are UNKNOWN),
  `evidence` ("observed on N of M days") — see `CONFIDENCE_COPY` / `plainEvidenceSentence` in
  reconciliationCards.jsx.
- SHIP NOW: on a **needs-attention/unknown chip**, surface a one-line "why" from the decision's
  `reason`/`unknowns`/`evidence` (glanceable or on hover/expand) + a light provenance cue (inferred/
  observed/confirmed) for decision-backed nodes — FOLDED INTO the existing status vocabulary, not a
  third ornamental sigil on top of the 5 state colors.
- Maker: REUSE the existing copy maps (`CONFIDENCE_COPY`, `plainEvidenceSentence`); do not invent new
  provenance strings. Full evidence disclosure stays in the panel; the chip carries only the light
  at-rest cue + one-line why.

### Deferred to a fast-follow (documented, NOT this build)
1. Provenance on **decision-less clean nodes** (the `understood` clean-import majority): the census
   snapshot (`fetchCensusSnapshot`) has no `import_evidence.tag`/`operations.source` columns; surfacing
   provenance there needs threading those into the snapshot read. Out of scope.
2. A composed **two-sided conflict sentence** ("two activities both claim 3:00 Thursday"): conflicts
   store only the machine token; a formatter over evidence/op payloads is a moderate add. Out of
   scope; the raw `reason` + evidence ships instead.

### Verification
After build, run the Impeccable mechanical detector once over the changed UI:
`node /Users/gregfeitel/.claude/skills/impeccable/scripts/detect.mjs --json src/components/reconciliation/RootMap.jsx`
and address its findings in the review round, alongside the normal loop + a Tester pass on the
running screen.
