---
title: "Schedule screen design audit 2026-08-07 — spec set"
document_type: spec
status: active
created: 2026-08-07
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: []
archive_when: all specs in this set are implemented and Verifier PASS recorded
---

# DESIGN SPEC SET — Schedule Screen Design Audit 2026-08-07

**Mode B.** Consumes the DESIGN AUDIT REPORT of 2026-08-07 as brief. All 8 findings approved, Finding 2 split into 2a/2b, plus Finding 9 (modal entry motion) promoted from Section B. Ordered by leverage: 1, 2a, 2b, 3, 4, 5, 6, 7, 8, 9.

---

## SPEC 0 — Shared mechanism decisions (read first; binding on every spec below)

Maker must not re-derive these. Three cross-cutting decisions, made here once.

### 0.1 Where non-inline CSS lives

The codebase is inline-style-first. `:active`, `:hover`, `@keyframes`, and `@media (prefers-reduced-motion)` cannot be expressed inline. `DESIGN_STANDARD` scopes the CSS-file exception to `src/components/schedule/scheduleGrid.css`, and the audit forbids any new motion in that file.

**Ruling:** all new pseudo-state rules, keyframes, and reduced-motion blocks required by this spec set are appended to **`src/index.css`** — the existing global stylesheet that already holds the token `:root` block and global element rules (`button { cursor: pointer; font-family: inherit; }` at line 43). These are *global primitives*, in the same category as tokens — not component styles. **No second stylesheet. No component CSS file outside `scheduleGrid.css`.**

Confidence: high. Evidence: `src/index.css` already carries global element rules; `scheduleGrid.css`'s own header comment scopes it to grid cell pseudo-states; the standard's §6 boundary language forbids *component* CSS elsewhere, not global primitives.

**Append this block verbatim to the end of `src/index.css`.** Every spec below references classes/keyframes from it by name.

```css
/* ---------- Global motion primitives (design audit 2026-08-07) ---------- */
/* Press feedback. No hover-scale anywhere — press only. Personality is
   "quiet, precise": the button acknowledges the finger, it does not perform. */

.press-97,
.press-98 {
  transition: transform var(--motion-fast) var(--ease-out);
}
.press-97:active:not(:disabled) { transform: scale(0.97); }
.press-98:active:not(:disabled) { transform: scale(0.98); }

/* Skeleton shimmer — DESIGN_STANDARD §5b, 1200ms linear infinite. */
@keyframes shoresh-skeleton-shimmer {
  from { background-position: -160% 0; }
  to   { background-position: 260% 0; }
}

/* Indeterminate progress bar travel — DESIGN_STANDARD §5b blocking action.
   Linear is correct for indeterminate progress: an eased loop reads as a
   repeating gesture, a linear one reads as ongoing work. */
@keyframes shoresh-indeterminate {
  from { transform: translateX(-100%); }
  to   { transform: translateX(350%); }
}

@media (prefers-reduced-motion: reduce) {
  .press-97, .press-98 { transition: none; }
  .press-97:active:not(:disabled),
  .press-98:active:not(:disabled) { transform: none; }
  .shoresh-skeleton-block { animation: none !important; background-image: none !important; }
  .shoresh-indeterminate-fill {
    animation: none !important;
    transform: none !important;
    width: 100% !important;
  }
}
```

### 0.2 Mount transitions in inline styles

Entry motion (Findings 1, 5, 9) needs a two-frame flip: mount at the "from" style, then transition to the "to" style. `src/styles/shared.js` line 5 already establishes `prefersReducedMotion()` read via `matchMedia` at render.

**Add one shared hook to `src/styles/shared.js`**, exported alongside `prefersReducedMotion`. This is the single mount-motion implementation for all three findings — do not hand-roll it per call site.

```js
import { useState, useEffect } from 'react'

/**
 * Mount transition for inline-styled elements. Returns a style fragment to
 * spread onto the animated element. Renders one frame in the "from" state,
 * then flips to the "to" state on the next animation frame.
 *
 * variant:
 *   'slideFade' — translateY(-4px)->0 + opacity 0->1, --motion-base   (§5c error banners)
 *   'liftFade'  — translateY(8px)->0  + opacity 0->1, --motion-base   (modals)
 *   'popFade'   — scale(0.97)->1      + opacity 0->1, 180ms           (anchored popovers)
 *
 * Under prefers-reduced-motion the transform is dropped entirely and only
 * opacity crossfades, per DESIGN_STANDARD §8.
 */
export function useEnterTransition(variant, { transformOrigin } = {}) {
  const reduced = prefersReducedMotion()
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const FROM = {
    slideFade: 'translateY(-4px)',
    liftFade: 'translateY(8px)',
    popFade: 'scale(0.97)',
  }
  const DURATION = variant === 'popFade' ? '180ms' : 'var(--motion-base)'

  if (reduced) {
    return {
      opacity: entered ? 1 : 0,
      transition: `opacity ${DURATION} var(--ease-out)`,
    }
  }
  return {
    opacity: entered ? 1 : 0,
    transform: entered ? 'none' : FROM[variant],
    transformOrigin,
    transition: `opacity ${DURATION} var(--ease-out), transform ${DURATION} var(--ease-out)`,
  }
}
```

Notes binding on Maker:
- `transformOrigin` is passed only by Finding 5. Modals and banners leave it undefined (default `center` is correct for centred modals; irrelevant for a full-width banner translating on Y only).
- `requestAnimationFrame`, not `setTimeout(0)` — a timeout can coalesce into the same paint and skip the transition.
- Never `scale(0)`. `popFade` starts at `0.97`; the popover must never appear to grow from nothing.

### 0.3 Reduced motion is never "no feedback"

Under `prefers-reduced-motion: reduce`, every spec keeps its *information* and drops only its *travel*: banners and modals still crossfade, skeletons still render as static blocks, the progress bar still renders as a static rule. Nothing becomes invisible or unacknowledged.

---

## SPEC 1 — Error banner entry motion (conformance, §5c)

**Leverage:** HIGH. **Size:** S. **Audit finding:** 1.

### Framing
This is **conformance work against the already-ratified DESIGN_STANDARD §5c**, not a new design proposal. §5c states verbatim:

> Motion: **Slide + Fade** — translateY -4px→0, opacity 0→1, `--motion-base`. On dismiss/resolve, fade out `--motion-fast`.

That clause is normative and unimplemented. This spec implements it exactly. No values are being chosen here; they are being obeyed.

### Files and anchors
- `src/styles/shared.js:105-113` — `S.errorBanner` (the shared primitive; the fix lands here, **once**).
- `src/screens/ScheduleScreen.jsx:694` (`weekDeletedBanner`), `:700` (`loadError`), `:705` (`templateError`), `:710` (`actionError`) — call sites. **These four are not modified except to attach the hook.**

### Visual style
`S.errorBanner` retains its existing geometry (`borderRadius: 6`, `padding: '10px 14px'`, `marginBottom: 16`, `fontSize: 13`). Three colour references change token only — **no rendered colour change**, since `--warning` and `--danger` hold the identical value `#B44E48`:

| Line | Current | New |
|---|---|---|
| 106 | `background: 'color-mix(in srgb, var(--warning) 8%, var(--surface))'` | `background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))'` |
| 107 | `border: '1px solid color-mix(in srgb, var(--warning) 35%, var(--border))'` | `border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border))'` |
| 112 | `color: 'var(--warning)'` | `color: 'var(--danger)'` |

Rationale: DESIGN_STANDARD §2 marks `--warning` **"Legacy alias — keep defined"** and §6 states *"new/retheme code should point them at `var(--danger)` for semantic hygiene."* This is that repointing. `S.btnDanger` (shared.js:38-40) is **out of scope for this spec** — it is not a banner and is not being otherwise touched.

### Animation
| Property | Value |
|---|---|
| Trigger | Banner mounts (condition flips false→true) |
| Type | **Slide + Fade** (§5c vocabulary) |
| From | `opacity: 0`, `transform: translateY(-4px)` |
| To | `opacity: 1`, `transform: none` |
| Duration | `var(--motion-base)` (220ms) |
| Easing | `var(--ease-out)` |
| Dismiss | `opacity: 1→0` over `var(--motion-fast)` (140ms) `var(--ease-out)`, then unmount |
| Reduced motion | Opacity only. No `translateY`. Same durations. |

**Implementation:** each of the four call sites wraps its banner element with `useEnterTransition('slideFade')` (Spec 0.2) spread after `...S.errorBanner`:

```jsx
const bannerEnter = useEnterTransition('slideFade')
// ...
<div style={{ ...S.errorBanner, ...bannerEnter, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
```

Because the hook must be called unconditionally at component top level (Rules of Hooks) and all four banners share one screen, **call `useEnterTransition('slideFade')` once** near the top of `ScheduleScreen` and spread the same fragment into all four banners. All four mount together or not at all from the user's perspective; a shared entry state is correct and avoids four hooks.

**Dismiss motion scope:** only `weekDeletedBanner` (line 694) has a dismiss control (the `×` button). The fade-out applies to it alone. `loadError` / `templateError` / `actionError` clear by state change; they may unmount instantly — **do not** add exit-animation state machinery to them. Implement the `weekDeletedBanner` fade-out with a local `dismissing` boolean: on `×` click set `dismissing = true` (which sets `opacity: 0`, `transition: opacity var(--motion-fast) var(--ease-out)`), then `setWeekDeletedBanner(null)` after 140ms. Under reduced motion, skip the delay and null it immediately.

### Non-goals
- Do not add the §5c alert icon or the inline retry affordance. §5c describes them, but the audit did not raise them and adding retry actions is behavioural work, not design conformance. Note for Governor as a possible follow-up ticket.
- Do not restyle the four call sites' layout.

### Acceptance criteria
1. Mounting any of the four banners produces a 220ms `cubic-bezier(0.22,1,0.36,1)` slide-down-and-fade from `translateY(-4px)`; the controls bar below reflows without a hard jump.
2. `S.errorBanner` contains zero `var(--warning)` references; rendered colours are byte-identical to before (both tokens = `#B44E48`).
3. With `prefers-reduced-motion: reduce` set, the banner crossfades with **no** vertical travel.
4. Dismissing the week-deleted banner fades it out over 140ms before it unmounts.
5. `useEnterTransition` is called once in `ScheduleScreen`, not four times.

---

## SPEC 2a — Press feedback: StatBadge and day/group pills (in-scope)

**Leverage:** HIGH. **Size:** S. **Audit finding:** 2 (in-scope half). Includes the StatBadge semantics fix.

### Files and anchors
- `src/components/schedule/StatBadge.jsx:12` (`<div onClick>`) and `:23` (transition string).
- `src/components/schedule/ScheduleDayView.jsx:66-72` (day pill `<button>`).
- `src/components/schedule/ScheduleGroupView.jsx:73-78` (group pill `<button>`).
- Consumes `.press-98` from `src/index.css` (Spec 0.1).

### 2a.1 — StatBadge: `<div>` → `<button>`

`StatBadge.jsx:12` is a `<div onClick>` carrying `aria-pressed` (line 14). It is not focusable, not operable by Enter or Space, and `aria-pressed` on a generic `div` is an invalid role/state pairing. It is a toggle button and must be one.

**Change line 12-14 from:**
```jsx
<div
  onClick={clickable ? onClick : undefined}
  aria-pressed={clickable ? active : undefined}
```
**to:**
```jsx
<button
  type="button"
  onClick={clickable ? onClick : undefined}
  disabled={!clickable}
  aria-pressed={clickable ? active : undefined}
  className={clickable ? 'press-98' : undefined}
```
Close the element as `</button>` at line 36.

**Style consequences of the element swap — all mandatory, `<button>` carries UA defaults a `<div>` does not:**

Add to the inline style object (lines 15-24), in addition to what is already there:
```js
font: 'inherit',
color: 'inherit',
display: 'block',
width: 'auto',
```
`textAlign: 'center'` is already present (line 21) and is retained. The global rule `button { cursor: pointer; font-family: inherit; }` (`src/index.css:43`) already covers font-family, but `font: 'inherit'` is specified anyway so the badge is not dependent on that rule's continued existence.

**`disabled` and the non-clickable state:** when `clickable` is false the badge is a plain readout. `disabled` prevents focus and click. The existing `cursor: clickable ? 'pointer' : 'default'` (line 22) is retained — but `disabled` buttons render UA-greyed text in some engines, so the explicit `color: 'inherit'` above and the existing explicit colours on lines 27 and 33 must be preserved. **Do not** add `opacity` or any other disabled treatment: a non-clickable StatBadge is not a disabled control visually, it is a number.

**`title` attribute (line 25):** unchanged.

### 2a.2 — Press feedback

| Element | Class | Scale | Rationale |
|---|---|---|---|
| StatBadge (`clickable` only) | `press-98` | `0.98` | Tens-of-times-per-day frequency tier. §1 "quiet" — at this repetition a 0.97 press reads as fidgety. |
| Day pill (`ScheduleDayView.jsx:66`) | `press-98` | `0.98` | Same tier. |
| Group pill (`ScheduleGroupView.jsx:73`) | `press-98` | `0.98` | Same tier. |

Add `className="press-98"` to each of the three elements. The pills at `ScheduleDayView.jsx:66` and `ScheduleGroupView.jsx:73` are already `<button>` elements — **className only, no other change to those two files beyond this attribute.**

Timing comes from the global rule: `transition: transform var(--motion-fast) var(--ease-out)` — 140ms, `cubic-bezier(0.22,1,0.36,1)`.

### 2a.3 — StatBadge transition retiming (overlaps Finding 7)

`StatBadge.jsx:23` currently reads:
```js
transition: 'border-color 0.15s, background 0.15s',
```
Change to:
```js
transition: 'border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)',
```
`transform` is **not** listed here — it is supplied by the `.press-98` class rule so that the reduced-motion override in `src/index.css` can cancel it. Do not duplicate the transform transition inline; an inline `transition` would win over the class rule and defeat the media query.

### States
| State | Treatment |
|---|---|
| Default (clickable) | `background: var(--bg)`, `border: 1px solid {accent}` — unchanged (lines 19-20) |
| Default (non-clickable) | `background: var(--bg)`, `border: 1px solid var(--border)` — unchanged |
| Active/selected | `background: color-mix(in srgb, {accent} 10%, var(--bg))`, `border: 1px solid {accent}` — unchanged (lines 19-20) |
| Hover | **None. No hover-scale, no hover style added.** The audit forbids hover-scale and the badge already signals affordance via `cursor: pointer` and the `↗` glyph (line 34). |
| Pressed | `transform: scale(0.98)` for the duration of pointer-down |
| Focus | UA default focus ring, now reachable via Tab — this is the accessibility win, do not suppress it with `outline: none` |

### Explicit non-goal — colour is not animated
The pills' selected `background` and `border` swap between `var(--primary)` and `var(--surface)`/`var(--border)` (`ScheduleDayView.jsx:67-69`, `ScheduleGroupView.jsx:74-76`). **Do not add a transition to those properties.** DESIGN_STANDARD §8 rule 1: *"Only animate `opacity`, `transform` (translate), and `max-height` / `clip` for reveals. Avoid animating layout/color."* At day/group-pill click frequency the instant swap is the correct, precise behaviour. This is a deliberate omission, not an oversight.

### Reduced motion
Handled entirely by the `@media (prefers-reduced-motion: reduce)` block in Spec 0.1: `.press-98` loses both its transition and its `:active` transform. The button still receives focus, still fires, still swaps colour — only the scale is removed.

### Acceptance criteria
1. `StatBadge` renders a `<button type="button">`; Tab reaches it, Enter and Space activate it, `aria-pressed` reflects `active`.
2. Non-clickable StatBadges are `disabled`, not focusable, and render visually identical to the current build (same number colour, same label colour, same border).
3. Pressing a clickable StatBadge or a day/group pill scales it to `0.98` over 140ms and releases; nothing scales on hover.
4. The pill's selected background/border change remains instantaneous.
5. Under `prefers-reduced-motion: reduce` no element scales on press.
6. `StatBadge.jsx` contains no raw `0.15s` duration.

---

## SPEC 2b — Press feedback: shared button primitives (cross-screen)

**Leverage:** HIGH. **Size:** S, but **blast radius: every button in the app.** **Audit finding:** 2 (cross-screen half) + Section B type-weight item.

> **Governor sequencing note.** This spec is separated from 2a precisely because `S.btnPrimary` and `S.btnSecondary` are consumed on every screen, not only the schedule screen. It changes the felt behaviour and the visual weight of the app's primary control everywhere at once. Sequence it deliberately — it wants its own ticket, its own visual regression pass across screens, and it is the one item here where a director-facing before/after is worth showing a human. 2a does not depend on it and can ship first.

### Files and anchors
- `src/styles/shared.js:10-19` — `S.btnPrimary`
- `src/styles/shared.js:21-30` — `S.btnSecondary`
- Consumes `.press-97` from `src/index.css` (Spec 0.1).

### 2b.1 — Press feedback

Both primitives receive press feedback at **`scale(0.97)`** — a full step deeper than 2a's pills. Rationale: these are deliberate, consequential, low-frequency actions ("Generate", "Save", "Export"), where a slightly firmer acknowledgement is correct; the pills are navigational and high-frequency.

Because these are style *objects* and not elements, the class cannot be added centrally. **Every call site that spreads `S.btnPrimary` or `S.btnSecondary` onto a `<button>` adds `className="press-97"`.** Maker enumerates the call sites via:

```
grep -rn "S\.btnPrimary\|S\.btnSecondary" src
```

Rules for the sweep:
- Add `className="press-97"` to each `<button>` that spreads either primitive.
- Where the element already has a `className`, append: `className="existing press-97"`.
- Where the primitive is spread onto a **non-button** element (e.g. an `<a>` or a `<div>` acting as a button), **do not add the class** — flag it in the handoff instead. A non-button carrying a button style is a separate accessibility defect (same class as 2a.1) and must not be silently press-animated into looking more legitimate than it is.
- Where `S.buttonDisabled` is also spread, no change is needed: the global rule uses `:active:not(:disabled)`, so disabled buttons correctly do not press. **Verify each such call site also carries the real `disabled` attribute**, not only the greyed style — if a call site only applies `S.buttonDisabled` without `disabled`, it will still press. Add the `disabled` attribute where missing; this is a bug the press feedback merely exposes.

### 2b.2 — Type weight 700 → 600

`src/styles/shared.js:15` — `S.btnPrimary`:
```js
fontWeight: 700,   →   fontWeight: 600,
```

This is conformance with the DESIGN_STANDARD §2 **Type-weight advisory** (line 69), quoted verbatim:

> Nunito/Fredoka were rounded and needed `fontWeight: 700` to read bold. Inter / IBM Plex Sans render visually heavier at the same numeric weight. To hold "quiet / precise," the retheme should generally step existing `700` UI labels down to `600` and reserve `700` for logo/display and true emphasis.

`S.btnSecondary` is already `fontWeight: 600` (line 27) — **no change**. This brings the two primitives into weight agreement, which is itself correct: primary and secondary should differ by colour and fill, not by type weight.

### States (both primitives)
| State | `btnPrimary` | `btnSecondary` |
|---|---|---|
| Default | `background: var(--primary)`, `color: #fff`, `border: none`, `borderRadius: 7`, `fontWeight: 600`, `fontSize: 13` | `background: var(--surface)`, `color: var(--text)`, `border: 1px solid var(--border)`, `borderRadius: 7`, `fontWeight: 600`, `fontSize: 13` |
| Hover | **No change. Do not add a hover state in this spec.** | **No change.** |
| Pressed | `transform: scale(0.97)`, 140ms `var(--ease-out)` | `transform: scale(0.97)`, 140ms `var(--ease-out)` |
| Disabled | `S.buttonDisabled` — `opacity: 0.45`, `cursor: not-allowed`; **no press transform** | same |
| Focus | UA default ring, unsuppressed | UA default ring, unsuppressed |

Hover is explicitly out of scope. DESIGN_STANDARD §2 defines `--primary-dark` as *"Hover / active / pressed state of primary"* and it is currently unused by these primitives — that is a real gap, but it is a **colour** change on a cross-screen primitive and belongs in its own ticket alongside a hover audit. Raising it here would let a colour transition in through the back door. **Flag to Governor; do not implement.**

### Reduced motion
Handled by the Spec 0.1 media block. Buttons remain fully functional and visually unchanged apart from losing the scale.

### Acceptance criteria
1. Every `<button>` spreading `S.btnPrimary` or `S.btnSecondary` carries `className="press-97"` and scales to `0.97` over 140ms on pointer-down.
2. Buttons carrying `S.buttonDisabled` do **not** press, and every such call site also carries the `disabled` attribute.
3. `S.btnPrimary.fontWeight === 600`; no primary button anywhere renders at 700.
4. Any non-`<button>` element found spreading a button primitive is listed in the handoff, unmodified.
5. Under `prefers-reduced-motion: reduce`, no button scales.
6. A visual pass across the auth, schedule, and merge screens shows no unintended layout shift from the weight change (600 is narrower than 700 — check that no button label wraps that previously did not).

---

## SPEC 3 — Schedule screen skeleton loading state (conformance, §5b)

**Leverage:** HIGH. **Size:** M. **Audit finding:** 3.

### Framing
Conformance work. DESIGN_STANDARD §5b, verbatim:

> **Lists/grids: skeleton, not a spinner** (grounded, quiet). Skeleton fill `color-mix(in srgb, var(--text) 6%, var(--surface))`, `borderRadius: 6`, shaped to the content it replaces. Shimmer: slow left-to-right highlight, `1200ms linear infinite`; under `prefers-reduced-motion` render static blocks (no shimmer).

and:

> Appearance: **Fade in only**, `--motion-fast` (140ms). Never lift/slide a loader.

The current implementation is a single line of mono text. Every value below is dictated by that clause; none is a fresh choice.

### File and anchor
`src/screens/ScheduleScreen.jsx:564`:
```jsx
if (loading) return <div style={S.stateLoading}>Loading…</div>
```

### Layout
Replace with a skeleton **shaped to the real post-load layout**, so the transition from skeleton to content is a substitution rather than a teleport. Three bands, matching the actual DOM order at lines 714 (controls bar), 839 (badge row), and 950 (grid content):

```
┌─────────────────────────────────────────────┐
│ ▭▭▭▭▭▭  ▭▭▭▭▭▭▭  ▭▭▭▭   ▭▭▭▭▭  ▭▭▭        │  controls bar   (h 32)
│                                             │  gap 16
│ ▭▭▭▭▭▭  ▭▭▭▭▭▭  ▭▭▭▭▭▭  ▭▭▭▭▭▭            │  badge row      (h 56)
│                                             │  gap 20
│ ┌─────────────────────────────────────────┐ │
│ │                                         │ │  grid frame     (h 420)
│ │                                         │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Extract to a new component `src/components/schedule/ScheduleSkeleton.jsx`.** It takes no props. It lives in `src/components/schedule/` because it is schedule-shaped, not a generic loader. It is a pure presentational component with no state beyond `prefersReducedMotion()`.

### Exact geometry

Root: `<div style={{ maxWidth: '100%' }} role="status" aria-live="polite" aria-busy="true">` containing a visually-hidden `<span>` with the text `Loading schedule…` (position absolute, 1×1, clip-path inset(50%), overflow hidden) so screen readers keep the announcement the mono text used to provide. **Do not** put the loading text on screen.

**Band 1 — controls bar.** Container: `display: flex, alignItems: center, gap: 12, marginBottom: 16, flexWrap: wrap`. Five blocks, each `height: 32, borderRadius: 6`, widths in order: `140, 180, 96, 120, 88` px.

**Band 2 — badge row.** Container: `display: flex, gap: 10, alignItems: center, flexWrap: wrap, marginBottom: 20`. Four blocks, each `height: 56, width: 104, borderRadius: 8`. (Radius 8 matches `StatBadge.jsx:21`; radius 6 is the §5b default used everywhere else.)

**Band 3 — grid frame.** One block, `height: 420, width: '100%', borderRadius: 6`.

### Visual style — the skeleton block

Every block uses this exact style, plus its own `width` / `height` / `borderRadius`:

```js
const skeletonBlock = {
  background: 'color-mix(in srgb, var(--text) 6%, var(--surface))',
  borderRadius: 6,
  backgroundImage: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--text) 4%, transparent) 50%, transparent 100%)',
  backgroundSize: '55% 100%',
  backgroundRepeat: 'no-repeat',
  animation: 'shoresh-skeleton-shimmer 1200ms linear infinite',
}
```
Apply `className="shoresh-skeleton-block"` to every block element so the Spec 0.1 reduced-motion rule can cancel both the animation and the gradient.

Fill colour and radius are §5b verbatim. The shimmer highlight is `var(--text)` at 4% — deliberately *fainter* than the 6% fill so the highlight is a pale sweep across a slightly darker field, reading as quiet paper rather than a glint. **No white highlight** — white would sparkle against the warm `--surface` and violate §1 "never playful."

### Animation
| Property | Value |
|---|---|
| Trigger | `loading === true` |
| Type | Shimmer (traveling highlight), plus a fade-in on the skeleton itself |
| Skeleton appearance | `opacity: 0→1`, `var(--motion-fast)` (140ms) `var(--ease-out)`. **Fade only — no lift, no slide** (§5b: *"Never lift/slide a loader"*). Use `useEnterTransition`? **No** — that hook's variants all carry transform. Implement the fade inline: mount at `opacity: 0`, flip to `1` on rAF, `transition: 'opacity var(--motion-fast) var(--ease-out)'`. |
| Shimmer | `shoresh-skeleton-shimmer 1200ms linear infinite` (§5b verbatim: `1200ms linear infinite`) |
| Stagger | **None.** All blocks shimmer in phase. A staggered skeleton reads as decoration. |
| Exit | **None.** The skeleton unmounts instantly when `loading` flips false. Do not cross-fade skeleton to content — a fade between two different layouts reads as a smear. The skeleton's job is to have already reserved the space. |
| Reduced motion | Static blocks: no shimmer animation, no gradient, flat `color-mix(in srgb, var(--text) 6%, var(--surface))` fill. The skeleton still fades in at 140ms (opacity-only is permitted under §8 reduced-motion fallback, and §5b already mandates fade-only appearance). |

### Implementation notes for Maker
- Replace line 564 with `if (loading) return <ScheduleSkeleton />`.
- The heights above are design-specified targets, not measurements taken from a running app. If the real controls bar or badge row differs by more than ~8px once rendered side by side, **adjust the skeleton to match the real thing and note the change in the handoff** — the whole value of this spec is that the skeleton holds the same space the content will occupy. That is the one measurement Maker is authorised to correct, and it is a fidelity correction, not a design decision.
- `S.stateLoading` (`shared.js:591-595`) stays in the file — it has other consumers. Only this call site stops using it.
- Do not add a spinner anywhere. §5b: *"No large centered spinners."*

### Acceptance criteria
1. While `loading`, the screen shows three skeleton bands shaped to the controls bar, badge row, and grid — not a text string.
2. Block fill is exactly `color-mix(in srgb, var(--text) 6%, var(--surface))` with `borderRadius: 6` (8 on the badge blocks).
3. Shimmer runs at exactly `1200ms linear infinite`, in phase across all blocks.
4. Under `prefers-reduced-motion: reduce`, blocks are static and flat — no shimmer, no gradient.
5. The skeleton fades in over 140ms with no vertical travel.
6. A screen reader announces the loading state via the visually-hidden live region.
7. When loading completes, content replaces the skeleton with no additional animation and no large layout jump.

---

## SPEC 4 — Generation progress bar (conformance, §5b)

**Leverage:** HIGH. **Size:** M. **Audit finding:** 4.

### Framing
Conformance work. DESIGN_STANDARD §5b, verbatim:

> **Blocking action (save, sync):** a `2px` indeterminate bar in `var(--primary)` pinned to the top of the affected panel, OR a 16px outline spinner (`stroke-width: 2`, `var(--text-secondary)`). No large centered spinners.

Schedule generation is the screen's longest blocking operation and currently signals only via a static mono label. The §5b pattern exists and is unused. The bar variant is chosen over the spinner because the affected panel is large and well-defined.

### Files and anchors
- `src/screens/ScheduleScreen.jsx:830` — the existing label:
  ```jsx
  {anyRouteStarted && generating && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Generating…</span>}
  ```
  **Keep this exactly as it is.** The bar supplements the label; it does not replace it. The label carries the *what*, the bar carries the *still working*.
- `src/screens/ScheduleScreen.jsx:950-951` — `const gridContent = (` / `<div style={{ flex: 1, minWidth: 0 }}>`. This is the grid panel and the bar's mount point.

### Layout
Add `position: 'relative'` to the `gridContent` wrapper at line 951:
```jsx
<div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
```
Then insert the bar as that div's **first child**, before the route-offer block at line 956:
```jsx
{generating && <IndeterminateBar />}
```

Anchoring to `gridContent` rather than to the outer screen is deliberate: §5b says *"pinned to the top of the affected panel."* The grid is the panel being regenerated; the controls bar above it stays interactive and must not appear to be under progress.

### Component
New component `src/components/schedule/IndeterminateBar.jsx`. No props. Two nested elements:

**Track** (the clipping rail):
```js
{
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 2,
  overflow: 'hidden',
  background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
  borderRadius: 1,
  zIndex: 3,
  pointerEvents: 'none',
}
```
Add `role="progressbar"` and `aria-label="Generating schedule"` to the track, with **no** `aria-valuenow` — omitting it is the correct ARIA encoding of indeterminate progress.

**Fill** (the traveling segment), `className="shoresh-indeterminate-fill"`:
```js
{
  height: '100%',
  width: '30%',
  background: 'var(--primary)',
  borderRadius: 1,
  animation: 'shoresh-indeterminate 1100ms linear infinite',
}
```

`z-index: 3` clears the grid's own stacking (`scheduleGrid.css:386` uses `z-index: 2` on the resize handle) without approaching the modal layer (`S.overlay` is `z-index: 1000`).

### Animation
| Property | Value |
|---|---|
| Trigger | `generating === true` |
| Type | Indeterminate progress — constant linear travel |
| Keyframes | `shoresh-indeterminate`: `translateX(-100%)` → `translateX(350%)` |
| Duration | `1100ms` |
| Easing | **`linear`** |
| Iteration | `infinite` |
| Appearance | None. The bar appears instantly with `generating`. §5b: *"Appearance: Fade in only, `--motion-fast`"* applies to loaders, and a 2px rail is below the threshold where a 140ms fade reads as anything but a flicker. Mounting it solid is the quieter choice. |
| Exit | None — unmounts with `generating`. |
| Reduced motion | Handled by the Spec 0.1 media block: `.shoresh-indeterminate-fill` loses its animation and its transform, and expands to `width: 100%`. Result is a **static 2px `var(--primary)` rule** across the top of the grid panel — the audit's specified fallback. The state is still fully communicated; only the travel is gone. |

**Why linear, not `--ease-out`.** `--ease-out` is a *decelerating* curve for things that arrive somewhere. An indeterminate loop has no destination; easing it makes the segment slow at each end and read as a repeated gesture — playful, and a violation of §1. Constant velocity reads as machinery running. This is the one place in this spec set where `--ease-out` is deliberately not used, and DESIGN_STANDARD §5b itself specifies `linear` for the sibling shimmer, establishing the precedent.

### States
| State | Grid panel |
|---|---|
| `generating === false` | No bar. Unchanged. |
| `generating === true` | 2px rail pinned to the panel's top edge; existing "Generating…" mono label remains at line 830; grid content beneath is unchanged (this spec adds no dimming or disabling). |
| `generating === true`, reduced motion | Static 2px `var(--primary)` rule, full width. |

### Non-goals
- No large centred spinner (§5b explicitly forbids).
- Do not dim, blur, or overlay the grid content. The director should still be able to read the schedule that is being replaced.
- Do not add a determinate percentage — the engine exposes no progress fraction, and a fake one is a lie.

### Acceptance criteria
1. While generating, a 2px `var(--primary)` bar with a 12%-tinted track sits flush at the top of the grid panel, and a 30%-wide segment travels left-to-right at constant speed on a 1100ms loop.
2. The existing "Generating…" mono label at line 830 is unchanged and still visible.
3. `gridContent`'s wrapper has `position: relative`; the bar does not escape it or overlap the controls bar.
4. The bar exposes `role="progressbar"` with no `aria-valuenow`.
5. Under `prefers-reduced-motion: reduce` the bar is a static full-width 2px `var(--primary)` rule with no travel.
6. No spinner is introduced anywhere.

---

## SPEC 5 — FindingsRail popover entry motion

**Leverage:** MEDIUM. **Size:** S. **Audit finding:** 5.

### File and anchor
`src/components/schedule/FindingsRail.jsx:11-25` — the `reduced` const and the root `<div>` style block.

### The dead code to delete
Lines 20-23 currently read:
```js
animation: reduced
  ? 'none'
  : undefined,
opacity: 1,
```
This is a verified no-op: `S.findingsRailPanel` (`shared.js:488-498`) declares no `animation`, and the codebase contains zero `@keyframes`. **Delete the `animation` ternary and the `opacity: 1` line entirely**, along with the now-unused `const reduced = prefersReducedMotion()` at line 11 and the `prefersReducedMotion` import on line 1 (keep the `S` import). Reduced-motion handling moves into `useEnterTransition`.

### Replacement
```jsx
import { S } from '../../styles/shared'
import { useEnterTransition } from '../../styles/shared'
// ...
export default function FindingsRail({ rows, onDismiss, onLocate, onClose, intro, emptyText }) {
  const enter = useEnterTransition('popFade', { transformOrigin: 'top left' })

  return (
    <div
      style={{
        ...S.findingsRailPanel,
        top: '100%',
        left: 0,
        marginTop: 6,
        ...enter,
      }}
    >
```
(Combine the two imports into one statement.)

### Animation
| Property | Value |
|---|---|
| Trigger | Rail mounts (a StatBadge is clicked) |
| Type | **Pop in** — scale + fade, anchored |
| From | `opacity: 0`, `transform: scale(0.97)` |
| To | `opacity: 1`, `transform: none` |
| Duration | `180ms` |
| Easing | `var(--ease-out)` — `cubic-bezier(0.22, 1, 0.36, 1)` |
| `transform-origin` | `top left` |
| Reduced motion | Opacity only, 180ms. No scale. |

**Why 180ms and not a token.** The rail sits between the token tiers: `--motion-fast` (140ms) is the micro-state tier and undersells a whole panel arriving; `--motion-base` (220ms) is the panel tier but the rail is trigger-anchored and retriggerable, where 220ms starts to feel like waiting. 180ms is the audit's specified value and is retained verbatim. **Maker: do not substitute a token here.** If Governor prefers strict token discipline over the audit's value, that is a standard-amendment question (a fourth duration token), not a Maker choice — flag it, ship 180ms.

**Why `transform-origin: top left`.** The panel is anchored `top: 100%; left: 0` relative to the badge that opened it (lines 17-18). A popover must appear to *come from* its trigger; scaling from `center` would make it grow away from the badge in all four directions and break that link. Top-left matches the anchor exactly.

**Why never `scale(0)`.** Starting from zero is a "poof" — playful, and it makes the panel's arrival the event rather than the content. `0.97` is a settle, not a reveal. §1: motion explains, never entertains.

**Why a CSS transition, not `@keyframes`.** The rail is retriggerable at speed — the director clicks from one StatBadge straight to another. A keyframe animation restarts from frame zero on every remount and cannot be interrupted mid-flight; a transition simply retargets. The `useEnterTransition` hook is transition-based, satisfying this.

### States
| State | Treatment |
|---|---|
| Closed | Not mounted. |
| Opening | 180ms pop-in as above. |
| Open | `S.findingsRailPanel` unchanged — `var(--surface-elevated)`, `1px solid var(--border)`, `borderRadius: 8`, `boxShadow: 0 2px 24px color-mix(in srgb, var(--text) 6%, transparent)`, `maxWidth: 360`, `maxHeight: 400`, `overflowY: auto`, `zIndex: 20`. |
| Switching badges | The rail unmounts and remounts; the new instance plays its own 180ms pop-in from its own anchor. This is correct — the panel genuinely moved to a new trigger. |
| Closing | Instant unmount. **No exit animation.** A dismissed popover should be gone; animating its departure delays the director's next action. |

### Non-goals
- Do not animate the rows inside the rail. No stagger, no per-row entrance. The rail is a reading surface; staggered rows are decoration and slow reading.
- Do not restyle any rail content (rows, Accept button, Close button).

### Acceptance criteria
1. `FindingsRail.jsx` contains no `animation` property and no reference to `prefersReducedMotion`.
2. Opening the rail plays a 180ms `cubic-bezier(0.22,1,0.36,1)` fade + `scale(0.97)→1` from `transform-origin: top left`.
3. Clicking rapidly between two StatBadges produces a clean re-entry each time with no stuck partial-opacity or partial-scale state.
4. Under `prefers-reduced-motion: reduce` the rail crossfades at 180ms with no scale.
5. Closing the rail is instant.
6. The panel is never rendered at a scale below `0.97`.

---

## SPEC 6 — Activity card hover: JS mutation → CSS

**Leverage:** MEDIUM. **Size:** S. **Audit finding:** 6.

### File and anchors
`src/components/schedule/ScheduleActivityView.jsx:35` (transition), `:38-39` (`onMouseEnter` / `onMouseLeave`), and the card's inline style block at `:33-37`.

### The defect
Lines 38-39 imperatively write `e.currentTarget.style.borderColor` and `.boxShadow`. Three problems, all real:
1. `onMouseEnter` fires on touch tap. The inline styles written there are never cleared, because `onMouseLeave` never fires on touch — the card is left permanently highlighted.
2. Inline element styles written by JS outclass everything and cannot be undone by a stylesheet.
3. The shadow is built by hex-alpha string concatenation — `` `0 2px 8px ${color}30` `` — which silently produces garbage the moment `activityColor()` returns a `var(--…)` token instead of a hex literal. DESIGN_STANDARD §6 mandates exactly that migration ("*`ActivityPalette.jsx` and `DisplacedPalette.jsx` — local `COLORS` arrays (→ shared `ACTIVITY_COLORS`)*"), so this is a latent break, not a hypothetical.

### Mechanism
The activity colour is per-card data, so the hover rule needs a value the stylesheet cannot know. Pass it as a **CSS custom property on the element**, and let a global rule consume it.

**Card element** — replace lines 33-39 with:
```jsx
<button
  key={act.id}
  onClick={() => onSelectActivity(act.id)}
  className="activity-card press-97"
  style={{
    '--activity-color': color,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '14px 16px',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)',
    borderTop: `4px solid ${color}`,
  }}
>
```
Both `onMouseEnter` and `onMouseLeave` are **deleted**. `press-97` is added because this is a card-sized deliberate action, matching the 2b tier.

**Global rule** — append to the `src/index.css` block from Spec 0.1:
```css
/* Activity card hover — gated to real pointers so a touch tap does not
   leave a stuck highlight. Colour arrives per-card via --activity-color. */
@media (hover: hover) and (pointer: fine) {
  .activity-card:hover {
    border-color: var(--activity-color);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--activity-color) 19%, transparent);
  }
}
```

`19%` is the exact equivalent of the old `30` hex alpha (`0x30` = 48; 48/255 = 18.8%). The visual result is unchanged; only the mechanism becomes token-safe. `color-mix` is already an established pattern in this codebase (`shared.js:106`, `:394`, `StatBadge.jsx:19`).

`border-top` is `4px solid {color}` and the hover rule sets `border-color` on all four sides — which would recolour the top border to the same value it already has. That is a no-op, which is why the old `onMouseLeave` had to manually restore `borderTopColor` (line 39). With CSS, no restoration is needed and that fragile third assignment disappears.

### Animation
| Property | Value |
|---|---|
| Trigger | Pointer hover, fine pointers only |
| Type | Border-colour + shadow crossfade |
| Duration | `var(--motion-fast)` (140ms) |
| Easing | `var(--ease-out)` |
| Press | `scale(0.97)`, `var(--motion-fast)` `var(--ease-out)`, via `.press-97` |
| Reduced motion | The hover *state* remains (it is information: "this is the card under my cursor"); only the press transform is cancelled by the Spec 0.1 media block. The 140ms colour transition is retained — §8's reduced-motion fallback permits crossfade, and this is a crossfade. |

**On §8 and colour.** §8 rule 1 says to avoid animating colour. This transition already exists in the code (line 35) and this spec is a mechanism fix, not a motion addition — retiming an existing transition to the token curve is explicitly what Finding 7 asks for. Removing the colour transition entirely would be a behavioural change beyond the finding's scope. **Retime it; do not remove it, and do not extend colour transitions to anything new.**

### States
| State | Card |
|---|---|
| Default | `var(--surface)` fill, `1px solid var(--border)`, `4px solid {activity colour}` top border, `borderRadius: 8` |
| Hover (fine pointer) | Border `var(--activity-color)`, shadow `0 2px 8px color-mix(in srgb, var(--activity-color) 19%, transparent)` |
| Hover (touch) | **No hover state.** Gated out by `@media (hover: hover) and (pointer: fine)`. |
| Pressed | `scale(0.97)` |
| Focus | UA default ring |

### Also in this file — type weight (§2 advisory)
Three `fontWeight: 700` occurrences step to `600`, per the §2 type-weight advisory quoted in Spec 2b:
- `:41` — activity name (`fontSize: 13`)
- `:45` — `HIGH` badge (`fontSize: 10`)
- `:75` — drilldown title (`fontSize: 18`)

**Also step the `HIGH PRIORITY` badge at `:76` to `600`** — it is the drilldown twin of the `:45` badge and leaving them mismatched would be a visible inconsistency between the two views of the same data. This is the one addition beyond the audit's enumerated lines; justified in one sentence: it is the same element in the other view, and the audit's list was an enumeration of the same defect, not an exclusion.

### Acceptance criteria
1. `ScheduleActivityView.jsx` contains no `onMouseEnter` or `onMouseLeave` and no `e.currentTarget.style` writes.
2. No template-literal hex-alpha concatenation remains; the shadow is `color-mix(in srgb, var(--activity-color) 19%, transparent)`.
3. Tapping an activity card on a touch device leaves no persistent border or shadow highlight.
4. Hovering on a mouse device transitions border and shadow over 140ms `cubic-bezier(0.22,1,0.36,1)`.
5. If `activityColor()` is changed to return `var(--some-token)`, the hover shadow still renders correctly (verify by temporarily returning a token).
6. `fontWeight: 700` no longer appears at lines 41, 45, 75, 76.
7. Card presses to `0.97`; no hover-scale.

---

## SPEC 7 — Motion token substitution

**Leverage:** MEDIUM. **Size:** S. **Audit finding:** 7.

Mechanical. **No behavioural change intended beyond the easing curve.** Substitution table:

| Raw value | Token |
|---|---|
| `0.1s`, `0.12s`, `0.15s` | `var(--motion-fast)` (140ms) |
| `0.35s` | `var(--motion-settle)` (340ms) |

Every substituted transition gains `var(--ease-out)` as its timing function, replacing the browser default `ease`. DESIGN_STANDARD §8 defines one shared curve for all four motion verbs; the default `ease` is a symmetric curve that starts slowly, which reads as hesitation on a micro-state change.

### Exact edits

**`src/components/schedule/StatBadge.jsx:23`** — covered by Spec 2a.3. Do it once; do not double-apply.

**`src/components/schedule/scheduleGrid.css:291`**
```css
transition: background 0.1s;
→
transition: background var(--motion-fast) var(--ease-out);
```

**`src/components/schedule/scheduleGrid.css:383`**
```css
transition: background 0.15s, opacity 0.15s;
→
transition: background var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out);
```

> **HARD CONSTRAINT — `scheduleGrid.css`.** These two lines are the **only** permitted changes to this file in this entire spec set. The file is intentionally motionless and documented as such. Do **not** add motion to the collapse block (~475-490), the drag block (~588-650), or anywhere else in it. Do not add a `@media (prefers-reduced-motion)` block to it — these are 140ms colour/opacity crossfades that already existed, and adding a reduced-motion block would be new authored behaviour in a file whose stillness is a deliberate decision. If Maker believes a reduced-motion guard is needed here, that is a Governor question.

**`src/components/schedule/ScheduleActivityView.jsx:35`** — covered by Spec 6. Do it once.

**`src/styles/shared.js:534`** (`mergeCard`)
```js
transition: 'max-height 0.35s ease, opacity 0.35s ease, margin 0.35s ease, padding 0.35s ease, border-color 0.35s ease',
→
transition: 'max-height var(--motion-settle) var(--ease-out), opacity var(--motion-settle) var(--ease-out), margin var(--motion-settle) var(--ease-out), padding var(--motion-settle) var(--ease-out), border-color var(--motion-settle) var(--ease-out)',
```
This one is named in the standard. §8, verbatim: *"existing `S.mergeCard` uses a 0.35s multi-prop transition — align it to `--motion-settle` + `--ease-out`."* Direct conformance.

**`src/styles/shared.js:545`** (`mergeChoiceBox`)
```js
transition: 'border-color 0.15s',
→
transition: 'border-color var(--motion-fast) var(--ease-out)',
```

**`src/styles/shared.js:569`** (`mergeBtnKeep`)
```js
transition: 'background 0.12s, color 0.12s',
→
transition: 'background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)',
```

**`src/styles/shared.js:588`** (`mergeConfirmed`)
```js
transition: 'opacity 0.15s',
→
transition: 'opacity var(--motion-fast) var(--ease-out)',
```

`shared.js:399` (`cellSelected`) is already tokenized — the sole existing consumer in scope. Leave it.

### Reduced motion
These are all pre-existing transitions being retimed, not new motion. The `--motion-*` tokens are not themselves reduced-motion-aware, and adding per-property guards to seven retimed lines is out of proportion to the change. **No reduced-motion work in this spec.** The three motion additions in this spec set that genuinely need guards (Specs 1, 5, 9 via `useEnterTransition`; Specs 3, 4 via the Spec 0.1 media block) all have them.

### Acceptance criteria
1. `grep -rnE "transition:.*[0-9]+(\.[0-9]+)?s" src/components/schedule src/screens/schedule src/screens/ScheduleScreen.jsx src/styles/shared.js` returns zero raw-duration transitions.
2. Every transition in the listed files names `var(--ease-out)`.
3. `scheduleGrid.css` diff contains exactly two changed lines.
4. `S.mergeCard` uses `var(--motion-settle)`; every other substitution uses `var(--motion-fast)`.
5. No property was added to or removed from any transition list.

---

## SPEC 8 — DESIGN_STANDARD reconciliation: activity palette (documentation only)

**Leverage:** MEDIUM. **Size:** S. **Audit finding:** 8. **Director's decision: binding.**

> **This is a documentation edit only.** Do **not** change any hex value. Do **not** touch `src/components/schedule/slotCellConstants.js` or `slotCellConstants.test.js`. No source file is modified by this spec. The standard currently records a palette that T18 deliberately superseded on colour-vision and greyscale-separation grounds; the standard's `last_reviewed: 2026-07-28` predates that work. The code is right and the document is stale — this reconciles the document to the ratified reality.

### File
`docs/governance/standards/DESIGN_STANDARD.md` — three edits.

### Edit 8.1 — front matter, line 8
```
last_reviewed: 2026-07-28
→
last_reviewed: 2026-08-07
```

### Edit 8.2 — replace §3 in full (lines 73-95)

Replace everything from the `## 3. Activity data palette` heading through the `**If larger safety margin is wanted**` paragraph with:

```markdown
## 3. Activity data palette

Six muted, professional colors for schedule activity types. Replaces the vivid
`['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']`.

**Current palette** (live in `src/components/schedule/slotCellConstants.js`):

```js
const ACTIVITY_COLORS = ['#305C7B','#3D7D84','#4B8C60','#B6A050','#B68B6B','#BE6BC7']
```

| # | Name | Hex | Rationale / distinctness |
|---|---|---|---|
| 1 | Deep Slate Blue | `#305C7B` | Coolest, darkest-reading blue. Far from every warm hue; separates from `--primary` navy by value and from `--anchor` slate by chroma. |
| 2 | Teal | `#3D7D84` | Blue-green. Separated from Sage by hue, and pushed bluer than the previous proposal to widen the greyscale gap against the greens. |
| 3 | Green | `#4B8C60` | Mid-green. Clearly warmer/greener than Teal; hue carries the distinction. |
| 4 | Ochre | `#B6A050` | Yellow-warm. Lightest member — the top of the greyscale ladder, which is what separates it from Clay in print. |
| 5 | Clay | `#B68B6B` | Orange-brown. Separated from Ochre by hue and saturation, and from Plum by hue. |
| 6 | Plum | `#BE6BC7` | Muted violet — the only purple-family hue; no neighbour competes. Deliberately the most chromatic of the six, because violet is the hue most at risk of collapsing into blue under common colour-vision deficiencies. |

**Why these values and not the 2026-07-28 proposal.** T18 re-picked the palette against two
constraints the original set did not satisfy:

1. **Colour-vision separation.** The original six clustered under deuteranopia and protanopia
   simulation — the Slate Blue / Muted Teal pair and the Ochre / Clay Terracotta pair each
   collapsed toward a single perceived hue. The current six are chosen so that every pair remains
   distinguishable under simulation, not only under normal trichromatic vision.
2. **Greyscale separation for print.** Directors print the schedule. The original palette was
   selected for white-label contrast, which optimises each colour against white independently and
   says nothing about how the six separate *from each other* in monochrome. The current palette
   spreads the six across the luminance range so that a printed grid stays readable without colour.

`src/components/schedule/slotCellConstants.js` records the derivation, and
`slotCellConstants.test.js` locks a `MIN_SEPARATION` property test over the set. **The test is the
normative guarantee** — any future re-pick must keep it passing. Do not adjust these hexes without
re-running it, and do not re-derive them from white-label contrast ratios alone; that was the
metric that produced the superseded set.

**Usage note — the palette is no longer a fill.** After the 2026-07-28 grid decolorization pass,
activity colour paints only a small (~6–8px) identity dot on the cell (`SlotCell.jsx`), not the
cell background. The grid reads as calm paper with colour as a compact identity channel. Two
consequences:

- **White-label contrast is no longer the governing metric.** No bold white label is set on these
  colours any more, so the ≥4.5:1 white-contrast target that shaped the superseded palette no
  longer applies. Mutual separability at dot scale is the metric that does.
- **Do not reintroduce filled activity cells** without reopening this section. A palette tuned for
  a 6–8px dot on `--surface` is not the same palette a full 28px cell fill would want, and
  restoring the fill would silently invalidate the separation work.

**Do NOT re-saturate the palette** to gain margin — that breaks the "quiet" personality (§1). If
more separation is ever needed, add a non-colour channel (shape, a hairline, position), not chroma.
```

### Edit 8.3 — §9 quick reference (lines 227-229)

Replace:
```
Activity palette:
  ['#3F6690','#3C8C86','#5F8A5A','#8C6F26','#B26B47','#7C5E86']
  (Slate Blue, Muted Teal, Sage Green, Ochre, Clay Terracotta, Dusty Plum)
```
with:
```
Activity palette (source of truth: src/components/schedule/slotCellConstants.js,
                  separation locked by slotCellConstants.test.js):
  ['#305C7B','#3D7D84','#4B8C60','#B6A050','#B68B6B','#BE6BC7']
  (Deep Slate Blue, Teal, Green, Ochre, Clay, Plum)
  Painted as a ~6-8px identity dot, not a cell fill — see §3.
```

### Implementation notes for Maker
- The colour names in the table above are descriptive labels assigned by this spec so the palette can be discussed. If `slotCellConstants.js:5-23` already carries its own names for these six, **use those names instead** and note the substitution. The code is the source of truth for naming as well as values.
- The per-colour "Rationale" cells describe hue relationships, not measured values. If `slotCellConstants.js:5-23` records specific measured rationale for any member, prefer that wording verbatim over this spec's paraphrase.
- Do not add contrast-ratio columns. The superseded table's ratios were the metric that produced the wrong answer, and reprinting ratios invites the next reader to re-optimise against them.
- §6's "Additional retheme surface" note (lines 162-166) still references `SlotCell.jsx — ACTIVITY_COLORS array`, which has since moved to `slotCellConstants.js`. **Leave it.** It is a stale pointer in a section explicitly framed as a future-ticket reminder, and correcting it is outside this reconciliation's scope. Flag it to Governor as a trivial follow-up.

### Acceptance criteria
1. `git diff --stat` for this spec shows exactly one changed file: `docs/governance/standards/DESIGN_STANDARD.md`.
2. `slotCellConstants.js` and `slotCellConstants.test.js` are byte-identical to before; the full test suite is unchanged and green.
3. §3 and §9 both list `['#305C7B','#3D7D84','#4B8C60','#B6A050','#B68B6B','#BE6BC7']`.
4. The superseded hexes `#3F6690`, `#3C8C86`, `#5F8A5A`, `#8C6F26`, `#B26B47`, `#7C5E86` appear nowhere in the document.
5. §3 states the colour-vision rationale, the greyscale/print rationale, the identity-dot usage note, and names the test as the normative guarantee.
6. `last_reviewed: 2026-08-07`.
7. `review_trigger` (line 9) is unchanged — this edit is itself an instance of that trigger firing correctly.

---

## SPEC 9 — Modal entry motion

**Leverage:** MEDIUM. **Size:** S. **Source:** Audit Section B, promoted to a numbered spec per the brief.

### Framing
Four modals mount with no entry motion. They share `S.overlay` + `S.modalSm`/`S.modalLg`, so this is **one fix, not four**. DESIGN_STANDARD §8 assigns `--motion-base` to *"fade / lift / slide of panels, banners, empty states, **modals in**"* — the token was specified for exactly this case and has no modal consumer.

### Files and anchors
Call sites named in the audit (all in `src/screens/ScheduleScreen.jsx`): `EditModal` `:1133`, `ExportChooserModal` `:1161`, `ConfirmRegenModal` `:1175`, `DeleteWeekDialog` `:1220`.

The motion lands in the **modal components**, not the call sites:
- `src/components/schedule/EditModal.jsx:15` and `:28` (two `S.overlay` renders — both need it)
- `src/components/schedule/ExportChooserModal.jsx:13`
- `src/components/schedule/ConfirmRegenModal.jsx:16`
- `src/components/schedule/DeleteWeekDialog.jsx` (locate its `S.overlay` render)

### Blast radius — read before implementing
`S.overlay` has consumers **outside** the schedule scope:
- `src/screens/DayOverridesScreen.jsx:200`
- `src/components/RecordHistory.jsx:69`
- `src/components/schedule/ExclusionConfirmDialog.jsx:5`

**Apply the entry motion to all seven `S.overlay` consumers**, not only the four the audit named. Rationale, in one sentence: a modal system where four dialogs animate in and three snap is worse than one where none animate, because the inconsistency reads as a bug. This is a small, uniform extension of an approved finding, and it is the reason this is a *spec of its own* — Governor should know it touches three files outside the audited scope before sequencing it.

### Layout
No layout change. `S.overlay` (`shared.js:95-103`) already centres via flex; `S.modalSm` (`:79-85`) and `S.modalLg` (`:86-94`) are unchanged.

### Animation
| Property | Value |
|---|---|
| Trigger | Modal mounts |
| Type | **Fade + Lift** |
| From | `opacity: 0`, `transform: translateY(8px)` |
| To | `opacity: 1`, `transform: none` |
| Duration | `var(--motion-base)` (220ms) |
| Easing | `var(--ease-out)` |
| `transform-origin` | `center` (default — **not** passed). Modals are centred in the viewport and not anchored to a trigger, so there is no origin to point at. This is the deliberate difference from Spec 5's popover. |
| Exit | **None.** Modals unmount instantly on close. A dismissed dialog should be gone. |
| Reduced motion | Opacity only, 220ms. No lift. |

**Scrim.** The `S.overlay` backdrop fades with the panel — do **not** animate scrim and panel separately, and do not stagger them. A scrim that darkens before the panel arrives is a two-beat entrance; the personality wants one quiet beat.

**8px, not 12px.** §8: *"Distances are small and physical: lift/slide 4–12px, never more."* 8px is the midpoint and matches §5a's empty-state lift, keeping every "arriving panel" in the app on one distance. 12px is reserved by §5d for the fatal-error mount, which is the app's heaviest moment and should stay distinguishable.

### Implementation
Each modal component calls `useEnterTransition('liftFade')` (Spec 0.2) and spreads it onto the **overlay** element — the outermost node — so scrim and panel move as one:

```jsx
const enter = useEnterTransition('liftFade')
// ...
<div style={{ ...S.overlay, ...enter }}>
```

Notes:
- `EditModal.jsx` has two `S.overlay` renders (lines 15 and 28) — presumably a loading/loaded branch. Call the hook **once** at component top level and spread the same fragment into both. Do not call it twice.
- The hook must be called unconditionally, before any early return. Where a modal component early-returns before its overlay render, hoist the hook call above the return.
- Do not add `will-change`. At one modal at a time on a 220ms transform this buys nothing and creates a compositing layer that outlives the animation.

### States
| State | Treatment |
|---|---|
| Closed | Not mounted. |
| Opening | 220ms fade + 8px lift, scrim and panel together. |
| Open | `S.overlay` + `S.modalSm`/`S.modalLg` unchanged. |
| Closing | Instant unmount. |
| Reduced motion | 220ms crossfade, no lift. |

### Non-goals
- No exit animation.
- No content stagger inside modals.
- No change to `S.overlay`'s scrim colour. DESIGN_STANDARD §6 offers an optional navy scrim (`color-mix(in srgb, var(--primary-dark) 50%, transparent)`) but names `rgba(0,0,0,0.45)` the default and says to *"Pick the default unless the retheme deliberately opts into the navy scrim."* This spec does not opt in.

### Acceptance criteria
1. All seven `S.overlay` consumers fade and lift in over 220ms `cubic-bezier(0.22,1,0.36,1)` from `translateY(8px)`.
2. Scrim and panel animate as one element; no stagger, no separate scrim fade.
3. `useEnterTransition` is called once per component, above any early return; `EditModal` calls it once for both overlay renders.
4. Closing any modal is instant.
5. Under `prefers-reduced-motion: reduce`, modals crossfade with no vertical travel.
6. No modal introduces an exit animation, `will-change`, or a scrim colour change.

---

## Handoff to Governor

### Sequencing recommendation

| Wave | Specs | Why grouped |
|---|---|---|
| **0** | Spec 0.1 + 0.2 | Prerequisite. Nothing else lands without the `src/index.css` block and `useEnterTransition`. Small, isolated, independently reviewable. |
| **1** | 8, 7, 1 | Lowest risk, highest certainty. 8 is docs-only. 7 is mechanical. 1 is one primitive + four call sites on one screen. |
| **2** | 2a, 5, 6 | Schedule-scoped. 2a carries a genuine accessibility fix (`div`→`button`) and should not wait. |
| **3** | 3, 4 | The two M-sized builds. New components, no cross-screen risk. Spec 3 carries the one authorised measurement correction. |
| **4** | 2b, 9 | **Cross-screen. Sequence deliberately.** 2b touches every button in the app and changes primary-button type weight; 9 touches three files outside the audited scope. Both want their own visual regression pass. |

### Decisions this spec set made that Governor may want to ratify
1. **Global motion primitives live in `src/index.css`** (Spec 0.1). Confidence high, but it is the first authored CSS outside `scheduleGrid.css` and the standard's §6 boundary language is about component CSS, not global primitives. If Governor reads it otherwise, this is a human gate.
2. **Spec 5 uses a raw `180ms`**, not a token. Retained verbatim from the audit. The alternative is a fourth duration token, which is a standard amendment.
3. **Spec 9 extends to three unaudited files.** Justified as consistency; flagged rather than assumed.
4. **Spec 6 adds `fontWeight` 700→600 at `ScheduleActivityView.jsx:76`**, one line beyond the audit's enumeration. Justified: same element, other view.

### Deliberately not done (raised, not fixed)
- `S.errorBanner` alert icon and inline retry affordance (§5c describes both; behavioural work).
- `S.btnDanger` still keys off `var(--warning)` (§6 flags it; renders correctly).
- Button hover states using `--primary-dark` (§2 defines the role; token currently unused).
- `DESIGN_STANDARD` §6 line 163 still points `ACTIVITY_COLORS` at `SlotCell.jsx` instead of `slotCellConstants.js` (stale pointer in a future-ticket note).
- No prototype HTML mockup was produced. Every spec here is a modification to an existing rendered surface with exact property values; a mockup would restate the spec less precisely than the spec does. Spec 3's skeleton is the only new visual, and its geometry is fully tabulated.