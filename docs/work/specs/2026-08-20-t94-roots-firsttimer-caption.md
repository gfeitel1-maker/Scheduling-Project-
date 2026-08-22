---
title: "T94 — Roots first-timer orientation caption"
document_type: spec
status: superseded
created: 2026-08-20
superseded_by: docs/adr/2026-08-22-roots-as-hub-setup-ia.md
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md]
related_docs:
  - docs/work/tickets/T94-roots-first-timer-orientation-caption.md
  - docs/work/specs/2026-08-19-roots-dashboard-spine-design.md
archive_when: superseded — removed in Slice A of the Roots-as-hub IA (2026-08-22)
---

> **Superseded 2026-08-22.** The first-timer caption was removed in Slice A of the
> Roots-as-hub setup IA (`docs/adr/2026-08-22-roots-as-hub-setup-ia.md` §5): a
> screen-purpose/onboarding explainer is evidence the interface isn't self-evident;
> root-click discoverability is addressed in the visual/motion pass, not a caption.
> This spec is retained for history only.

# T94 — Roots first-timer orientation caption

## Assessment (why this spec exists)

T94's `archive_when` allows closing the ticket if "the roots-as-dashboard rework makes the
affordance self-evident." That rework has shipped (PR #113/#114): `RootMapPanel` now has a primary
**"Manage {Area} →"** button (`S.btnPrimary`, `RootMapPanel.jsx:191-197`) and a `RootsBanner` with a
readiness verdict + Import/Worksheet/Facility-map actions (`rootsBanner.jsx`).

But the rework changed what happens **after** a node is clicked — the panel response — not whether
the canvas itself signals that the nodes are clickable **before** the first click. `RootMap.jsx`'s
`Node` component (lines 39-181) still renders each root as a small circle with no visible affordance
at rest: no border, no button chrome, no persistent label. The label pill and selection ring only
appear on hover/select (`showLabel = hovered || selected`, line 48) — which is the exact chicken-and-
egg problem T94 raised: a first-timer has no reason to hover a plain dot in the first place. The
banner and tiles above the canvas are styled as visible bordered buttons (`RootMap.jsx` `styles.tile`,
`rootsBanner.jsx` `styles.actions`) and do teach "things here are clickable" — but that lesson doesn't
transfer to unstyled circles on an illustration.

**Verdict: (a) still needed.** The rework raised the payoff of clicking a node; it did not raise the
node's own discoverability. The caption's job is narrower and still open: tell a first-time director,
once, that the dots are clickable and what they mean.

## Layout

**Placement:** directly under the canvas, above `RootMapPanel` — the existing conditional
`understoodRow` slot in `ReconciliationScreen.jsx` (lines 485-492), which already sits in that exact
position in the stacked inspect-mode layout (banner → headerStrip → understoodRow → RootMap →
RootMapPanel, `ReconciliationScreen.jsx:452-517`).

Rationale for this slot over the banner: the banner's job is the readiness verdict and bring-data-in
actions (a different concern — "can I build a week," not "what is this picture"). Putting the caption
there would blur two distinct messages into one control cluster. Under-canvas keeps the cue spatially
attached to the thing it explains, consistent with the ticket's own suggestion and with `understoodRow`
already occupying that exact row.

**Structure:** a new conditional row, sibling to (not reusing) `understoodRow` — `understoodRow` is a
static summary line with its own conditional logic; this is a dismissible first-run hint with separate
state. Render as a `<div>` directly below the `RootMap` canvas wrapper, above the `RootMapPanel`
wrapper `<div>` (`ReconciliationScreen.jsx:502`).

```jsx
{showFirstTimerCaption && (
  <div style={styles.firstTimerCaption} data-testid="roots-firsttimer-caption">
    <span>{FIRST_TIMER_CAPTION_TEXT /* PLACEHOLDER — see Copy below */}</span>
    <button
      type="button"
      className="press-97"
      onClick={dismissFirstTimerCaption}
      aria-label="Dismiss hint"
      style={styles.firstTimerCaptionDismiss}
    >
      ×
    </button>
  </div>
)}
```

## Visual Style

Reuses `understoodRow`'s exact token values — no new tokens, per the ticket:

```js
firstTimerCaption: {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '10px 4px',
  color: 'var(--text-secondary)',
  fontSize: 13,
},
firstTimerCaptionDismiss: {
  background: 'none',
  border: 'none',
  color: 'var(--text-secondary)',
  fontSize: 15,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '2px 4px',
  fontFamily: 'inherit',
},
```

No new color, no new font size — `--text-secondary` and `13px` are lifted verbatim from
`understoodRow` (`ReconciliationScreen.jsx:601-605`), matching the ticket's explicit instruction.

## States

- **First visit, not yet dismissed:** caption renders, `opacity: 1`.
- **Dismissed (this device):** caption never renders again — `showFirstTimerCaption` is `false` for
  the rest of this device's lifetime (see Behavior below).
- **No hover/active/disabled/error states** — this is a static text row plus one icon-button; the
  dismiss `×` gets the standard `press-97` class already used throughout Roots for tap feedback
  (`scale(0.97)` on `:active`, consistent with every other pressable in this surface), nothing bespoke.

## Interactions

- **Dismiss (`×` click or tap):** removes the caption for this device, permanently, via localStorage
  (see Behavior). No confirmation — it's a hint, not a destructive action.
- **No interaction with the caption is required to use Roots.** It never blocks, never traps focus,
  never repeats mid-session once dismissed.

## Behavior — once-shown / dismissible (reuses the T92 pattern)

Follow `ManualBuildView.jsx:12-33`'s exact mechanism — plain functions, try/catch defaulting to
"already seen" on storage failure, a new device-local key. Not routed through `window.shoresh`/op-log
(per the same T92 rationale: this is device-local UI chrome, not camp data, and must never become a
per-device sync write conflict).

```js
// Device-local UI chrome, not camp data — same rationale as T92's
// MERGE_HINT_KEY (ManualBuildView.jsx). localStorage can throw (private
// browsing, disabled storage); treat that as "already seen" so the app
// never crashes over a hint, and the caption just fails quiet-by-default.
const ROOTS_FIRSTTIMER_CAPTION_KEY = 'shoresh:rootsFirstTimerCaptionSeen'

function readFirstTimerCaptionSeen() {
  try {
    return localStorage.getItem(ROOTS_FIRSTTIMER_CAPTION_KEY) === '1'
  } catch {
    return true
  }
}

function writeFirstTimerCaptionSeen() {
  try {
    localStorage.setItem(ROOTS_FIRSTTIMER_CAPTION_KEY, '1')
  } catch {
    // Storage unavailable — nothing to persist, nothing to crash over.
  }
}
```

`ReconciliationScreen.jsx` initializes `showFirstTimerCaption` state as `!readFirstTimerCaptionSeen()`
on mount; `dismissFirstTimerCaption` calls `writeFirstTimerCaptionSeen()` then sets state to `false`.
Shown only in **inspect mode** (Roots as home) — never in `import` mode, where the banner already
carries a different, mode-specific message ("Imported N → Go to Schedule") and the director's
attention is on the reconciliation decisions, not on learning the canvas.

## Animation

**Entrance (first mount, first-time-only, so this is the Rare/first-time tier — delight budget
applies, but restraint still wins: this is an orientation hint, not a celebration):**

- **Fade in** — `opacity: 0 → 1`, `transition: opacity var(--motion-base) var(--ease-out)`, no
  transform, no scale. A caption is text, not a card; entrance stays minimal (Purpose: preventing a
  jarring appearance — the row shouldn't just snap into the layout with no bridge).
- Uses this repo's existing motion tokens (`--motion-base`, `--ease-out`) — no new duration/easing
  values introduced.

**Exit (dismiss click):**

- **Fade out**, faster than the entrance (asymmetric: dismiss is a system response to a user action,
  should feel immediate) — `opacity: 1 → 0`, `transition: opacity var(--motion-fast) var(--ease-out)`.
  On transition end (or optimistically, since the row unmounts on next render once
  `showFirstTimerCaption` flips false — no need for an explicit `onTransitionEnd` unmount given React
  will remove the row on the next state-driven render; a plain conditional render is sufficient here,
  matching how `understoodRow` itself is a plain conditional with no exit animation).
- If the fade-out is judged unnecessary complexity for a one-line hint (arguable — this is a very low-
  frequency, low-stakes UI element), the simpler alternative is: no exit animation, the row simply
  disappears on next render. **Recommendation: skip the exit fade.** The entrance fade justifies itself
  (the row appears unprompted, mid-layout, on first load — a bridge helps). The exit is a direct user
  action (they just clicked ×) — the causal link between click and disappearance is already clear
  without a transition, and adding one is complexity for a moment that will be seen at most once per
  device. Maker should implement the plain-conditional-render (no exit animation) version unless this
  reads wrong in review.

**Reduced motion:** `prefers-reduced-motion` (via the existing `prefersReducedMotion()` helper already
imported in this file's sibling components, e.g. `RootMap.jsx:2`) suppresses the entrance fade
entirely — render at `opacity: 1` immediately, no transition. This is an opacity-only animation to
begin with (no transform/position motion), so per this repo's reduced-motion convention (keep
opacity/color transitions, remove movement) it could arguably stay even under reduced motion — but
since it's decorative rather than load-bearing (the text is legible either way, with or without the
fade), the simpler and safer choice is to skip it outright under reduced motion, consistent with how
`Node`'s own animations in `RootMap.jsx` gate on `reduced` (lines 42, 87-94).

## Copy — PLACEHOLDER, pending owner's language pass

The exact wording is deliberately not finalized here — T94 explicitly defers this to the owner's
`/didwemenshion` language skill pass (same deferred-copy pattern as the Roots header, per
`docs/work/specs/2026-08-19-roots-dashboard-spine-design.md`'s "Parked follow-ups"). Maker should ship
with this placeholder and treat the final string as a one-line swap, not a structural change:

```js
// PLACEHOLDER — final copy pending owner's /didwemenshion language pass.
// Structure (one sentence, quiet, under understoodRow's 13px/--text-secondary
// styling) is locked; wording is not.
const FIRST_TIMER_CAPTION_TEXT =
  'Each part of your camp is a root — click one to see what Shoresh found.'
```

Do not treat this string as final. It exists so the component has something to render and so the
layout/behavior can be reviewed and shipped now, independent of the copy pass.

## Prototype

Not produced as a separate HTML mockup — the change is a single-line text row reusing an existing,
already-shipped style object (`understoodRow`) in an already-shipped layout position. A prototype
would just be a screenshot of the current Roots screen with one extra line under the canvas; the
existing dev environment (`npm run dev` + `window.__seedDemo()`, per the browser-mock reference) is
sufficient for Maker to eyeball placement against the real canvas art before shipping. No net-new
visual language is introduced that would need mockup validation first.

## Implementation Notes for Maker

- **File to edit:** `src/screens/ReconciliationScreen.jsx` — add the caption row between the `RootMap`
  block (ends ~line 500) and the `RootMapPanel` wrapper `<div>` (starts ~line 502). Add the
  `firstTimerCaption`/`firstTimerCaptionDismiss` entries to the `styles` object near `understoodRow`
  (line 601).
- **Do not reuse `understoodRow`'s style object by reference** — copy the two token values
  (`color: 'var(--text-secondary)'`, `fontSize: 13`) into a new `firstTimerCaption` style object. They
  are two different UI elements with different lifecycles (`understoodRow` is a permanent conditional
  summary; this is a one-time dismissible hint) that happen to share a look — coupling their style
  objects would make an unrelated future edit to one silently affect the other.
- **State/key naming:** `ROOTS_FIRSTTIMER_CAPTION_KEY = 'shoresh:rootsFirstTimerCaptionSeen'` — follow
  the `shoresh:<camelCase>` convention already established by T92's `shoresh:manualMergeHintSeen`.
- **Scope to inspect mode only** — gate the caption's render (not just its state) on
  `mode === 'inspect'`, so it never appears during import/reconcile flows where the banner already
  owns the director's attention.
- **The existing `aria-label="The root system — what Shoresh took in."` on the SVG (`RootMap.jsx:237`)
  stays unchanged** — this caption is a visible supplement for sighted users who currently have no
  orientation cue at all, not a replacement for the screen-reader label. No aria wiring needed on the
  caption row beyond the dismiss button's own `aria-label="Dismiss hint"` — the caption text itself is
  plain visible text, already in the accessibility tree via normal DOM order.
- **Test seam:** a characterization test should assert (1) the caption renders on first load in
  inspect mode when the localStorage key is unset, (2) it does not render when the key is `'1'`, (3)
  clicking dismiss sets the key and removes the row, (4) it never renders in import mode regardless of
  key state.
- **This is a small, independently shippable, test-first change** — no schema change, no engine
  change, no interaction with the readiness/census/panel logic. It touches one screen file and adds
  one new localStorage key.
