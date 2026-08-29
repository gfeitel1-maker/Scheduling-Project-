---
title: Design Standard
document_type: standard
authority: normative
status: active
applies_to: [design]
supersedes: [docs/superpowers/specs/design-system.md]
last_reviewed: 2026-08-07
review_trigger: any change to a token value, the activity palette, or the motion vocabulary
---

# Design Standard

**Authoritative.** The durable contract for Shoresh's visual language: personality, token values,
and the semantic meaning of each token. Every colour, type, spacing, and motion decision answers to
this document.

Per [`CONSTITUTION.md`](../constitution/CONSTITUTION.md) Article I, this standard outranks the code.
Where the implementation diverges, that is a gap to report — not a licence to amend either one.

**Retheme status: shipped.** The token values below are live in `src/index.css`, the activity
palette in `src/components/schedule/`, and the fonts in `index.html`. Verified 2026-07-28. The
"old value" column is retained as history — it explains why deprecated aliases still exist — and
does not describe anything currently in the codebase.

Every token has a semantic meaning, not just a hex.

---

## 1. Personality

Professional. Grounded. Warm. Quiet. Precise. **Never playful.**

Shoresh is a professional planning instrument for a camp director, not a consumer toy. The interface is grounded and quiet: paper-toned surfaces, thin hairline borders, generous whitespace, softly rounded corners, and shadows so faint they only separate a modal from the page behind it. Warmth lives in the paper background and the bronze accent — never in bounce, saturation, or decoration. It is precise: **color is a data channel, not ornament.** On the schedule grid — the product's visual center — every hue means something (which activity, whether an event is locked, whether a slot is flagged), so the palette is deliberately desaturated and mutually separable rather than vivid.

- **Component style:** Minimal shadows. Thin borders. Comfortable whitespace. Soft corners. No unnecessary decoration.
- **Motion:** explains, never entertains. Fade / Lift / Slide / Settle. No bounce, no elastic, no playful animation.
- **Icons:** outline, simple, consistent, never cartoon. `stroke-width` ~1.5.
- **The schedule grid is the visual focus. Everything else supports it.**

---

## 2. Full token map (old → new)

Every current `:root` variable in `src/index.css` is covered, plus three new tokens (`--accent`, `--danger`, `--anchor`). "Meaning" states the semantic role — what the token is *for*.

| Token | Old value | New value | Semantic meaning (what it is FOR) |
|---|---|---|---|
| `--bg` | `#FAF6F0` | `#F4F3EF` | App canvas / page background. Warm paper. Lowest surface; everything sits on it. |
| `--surface` | `#FFFCF8` | `#FCFBF8` | Default card / panel / input fill. One step above `--bg`. |
| `--surface-elevated` | `#FFF8F0` | `#FFFFFF` | Modals, popovers, dropdowns — surfaces that read as lifted *above* cards. Pure white gives the cleanest lift over warm paper without a heavy shadow. |
| `--primary` | `#00ADBB` | `#173B63` | **Deep Navy.** Primary brand + primary action (buttons, active nav, focus rings, logo). Structural authority color. |
| `--primary-dark` | `#008a96` | `#0F2A47` | Hover / active / pressed state of primary; deep-navy scrim base. |
| `--secondary` | `#2F7DE1` | `#2F6B58` | **Forest Green.** Secondary UI accent — secondary emphasis, selected/secondary controls, non-status highlights. |
| `--accent` | *(new)* | `#B8833A` | **Warm Bronze.** Sparing brand accent AND the semantic **caution** hue (temporary/attention states: lockout, "in progress"). Chrome, not data. |
| `--success` | `#00AA59` | `#4C8A63` | Confirmed / online / merged / valid status. Small surfaces: dots, badges, confirm text. Deliberately lighter than `--secondary` forest so status-green ≠ structural forest-green. |
| `--warning` | `#F0585D` | `#B44E48` | **Legacy alias — keep defined = brick value.** Existing `errorBanner`, `btnDanger`, and any `var(--warning)` reference keep rendering. Today's code uses `--warning` for *danger/error* semantics; see §4. New code must not invent a new meaning under this name. |
| `--danger` | *(new)* | `#B44E48` | **Muted Brick.** Canonical name for destructive / error / invalid. New code uses `--danger`; `--warning` holds the same value only for backward-compat. |
| `--anchor` | *(new)* | `#5C6B7A` | **Muted slate.** Fixed / immovable / structurally-locked events on the grid. Reads as "locked structure," clearly *not* a colored activity, harmonizes with navy. Replaces `--purple`'s anchor role. |
| `--purple` | `#A63595` | **DEPRECATED** | Was the fixed/anchor-event color. Keep defined as an alias of `--anchor` until the retheme migrates callers (`SlotCell.ANCHOR_COLOR`). Do not use in new code. |
| `--yellow-green` | `#7DC433` | **DEPRECATED** | Absorbed into the activity palette (§3). Do not use in new code. |
| `--text` | `#2D1F12` | `#1E2A34` | Primary text. Very dark cool slate-navy — aligns type to the brand, replaces the old warm brown. |
| `--text-secondary` | `#7A6152` | `#5C6670` | Secondary / muted text, labels, meta, table headers, hints. Cool muted grey. |
| `--border` | `#E8DDD0` | `#D8DBD9` | Hairline borders and dividers. Thin, cool, quiet. |
| `--font-sans` | `'Nunito'` | `'Inter'` | Interface font. Body, controls, tables. |
| `--font-condensed` | `'Fredoka'` | `'IBM Plex Sans'` | Titles / eyebrows / logo / display-ish headings. **Var name kept `--font-condensed`** for backward-compat with all `S.*` references; only the value swaps. Renaming the var is a separate retheme chore, out of scope. |
| `--font-mono` | `'IBM Plex Mono'` | `'IBM Plex Mono'` | Unchanged. Meta, host IDs, timers, technical strings. |

**Type-weight advisory (retheme note, not a token):** Nunito/Fredoka were rounded and needed `fontWeight: 700` to read bold. Inter / IBM Plex Sans render visually heavier at the same numeric weight. To hold "quiet / precise," the retheme should generally step existing `700` UI labels down to `600` and reserve `700` for logo/display and true emphasis.

---

## 3. Activity data palette

Six muted, professional colors for schedule activity types. Replaces the vivid
`['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']`.

**Current palette** (live in `src/components/schedule/slotCellConstants.js`):

```js
const ACTIVITY_COLORS = ['#305C7B','#3D7D84','#4B8C60','#B6A050','#B68B6B','#BE6BC7']
```

Six hues on six rungs of a lightness ladder — hue carries identity for most people, lightness
carries it for everyone else.

| # | Name | Hex | Rationale / distinctness |
|---|---|---|---|
| 1 | Deep Slate Blue | `#305C7B` | Coolest, darkest-reading blue. Far from every warm hue; separates from `--primary` navy by value and from `--anchor` slate by chroma. |
| 2 | Teal | `#3D7D84` | Blue-green. Separated from Green by hue, and pushed bluer than the previous proposal to widen the greyscale gap against the greens. |
| 3 | Green | `#4B8C60` | Mid-green. Clearly warmer/greener than Teal; hue carries the distinction. |
| 4 | Ochre | `#B6A050` | Yellow-warm. Lightest member — the top of the greyscale ladder, which is what separates it from Clay in print. |
| 5 | Clay | `#B68B6B` | Orange-brown. Separated from Ochre by hue and saturation, and from Plum by hue. |
| 6 | Plum | `#BE6BC7` | Muted violet — the only purple-family hue; no neighbour competes. Deliberately the most chromatic of the six, because violet is the hue most at risk of collapsing into blue under common colour-vision deficiencies. |

(Names are descriptive labels for discussion; `slotCellConstants.js` records the values
positionally and carries no names of its own.)

**Why these values and not the 2026-07-28 proposal.** The previous set was chosen for hue alone,
and three of its six collapsed into one colour for anyone with red-green colour blindness (~6% of
men). Measured as the smallest distance between any two entries:

```
                    normal  deuteranopia  protanopia  greyscale
  was                   39             6           5          2
  now                   34            20          17         17
```

Slightly less separation for normal vision, several times more for everyone else — and the
greyscale figure is the one that matters most in practice, because camps print schedules. At 2, a
printed dot was indistinguishable from any other.

1. **Colour-vision separation.** The original six clustered under deuteranopia and protanopia
   simulation. The current six are chosen so that every pair remains distinguishable under
   simulation, not only under normal trichromatic vision.
2. **Greyscale separation for print.** The original palette was selected for white-label contrast,
   which optimises each colour against white independently and says nothing about how the six
   separate *from each other* in monochrome. The current palette spreads the six across the
   luminance range so that a printed grid stays readable without colour.

This is a token-value change and the aesthetic call is the director's; the constraint that must
survive any reshuffle is the one in `slotCellConstants.test.js`, not these exact values.
**The test is the normative guarantee** — any future re-pick must keep it passing. Do not adjust
these hexes without re-running it, and do not re-derive them from white-label contrast ratios
alone; that was the metric that produced the superseded set.

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

---

## 4. Semantic color roles

- **`--danger` (brick `#B44E48`)** = destructive and error only: delete/remove controls, validation failures, fatal error screens, the `UNFILLABLE` flag. Red, terminal — "this is wrong / this will destroy."
- **`--warning` (same brick value)** = *legacy alias only.* Existing code uses it as danger; keep it defined so nothing breaks, but do not introduce a new meaning under this name.
- **`--accent` (bronze `#B8833A`) carries the caution/attention role.** Anything meaning "temporary, needs attention, in progress, throttled" — the auth lockout box, a soft advisory — uses bronze, **not** red. This keeps red rare and therefore loud when it does appear (a core "quiet, precise" move: reserve the alarm color). There is intentionally **no separate amber `warning` token**; bronze is the caution hue. The shared primitive for this is `S.cautionBanner` (`src/styles/shared.js`) — `color-mix(in srgb, var(--accent) 12%, var(--surface))` fill, `color-mix(in srgb, var(--accent) 45%, var(--border))` hairline, `color-mix(in srgb, var(--accent) 65%, var(--text))` text — used for advisory copy like "set this up first" (e.g. `GroupsScreen.jsx`, `AnchorsScreen.jsx`). Screens must route through it rather than hardcoding an amber block locally.
- **`--anchor` (slate `#5C6B7A`) vs the activity palette:** anchor is deliberately *outside* the six-color data palette. Activity colors say "which activity"; anchor says "this slot is locked/structural and cannot be moved." Slate is low-chroma and cool so it never competes with a hue-coded activity — it reads as chrome/lock, not data. The grid legend must document anchor **separately** from the activity key.
- **`--success` vs `--secondary`:** both green, but success (`#4C8A63`, lighter) means *status* (confirmed/online/merged) while secondary (`#2F6B58` forest) is a *structural UI accent*. Kept distinct on purpose.
- **The colored-fill pill (toggleable filter chip or static status badge) routes through `S.chip(color, selected, overrides)`** (`src/styles/shared.js`) — the shared primitive for the "colored pill, white text" shape used by the schedule group/day pickers, reconciliation's decision chips, device authorization badges, and activity priority tags. `selected` switches between the filled/on look (`background: color`, `color: '#fff'`) and the surface/off look (`background: var(--surface)`, `color: var(--text)`); `overrides` tune radius/padding/font-size per call site without re-deriving the fill logic. `#fff` as a chip text color is only defined here — screens must route through it rather than hardcoding a filled pill locally.

---

## 5. States spec

All states use thin `1px` borders, soft corners (`6–10`), minimal shadow, outline icons, and the motion tokens from §8. Every animation ships a `@media (prefers-reduced-motion: reduce)` fallback (crossfade or instant).

### a. Empty state — no data in a list/screen
(Extends existing `S.mergeEmptyState`.)
- Centered block, `padding: 60px 16px`. **No card, no shadow, no border** — emptiness should feel calm, not boxed.
- Icon: outline, ~40px, `stroke-width: 1.5`, color `var(--text-secondary)`.
- Title: `var(--font-condensed)` (IBM Plex Sans) 600, 15px, `var(--text)`.
- Body: 13px, `var(--text-secondary)`, one line, ≤ ~60ch.
- Optional single primary CTA (`S.btnPrimary`, navy).
- Motion: on mount, **Fade + Lift** — opacity 0→1, translateY 8px→0, `--motion-base` (220ms) `--ease-out`. No stagger.

### b. Loading state
- **Lists/grids: skeleton, not a spinner** (grounded, quiet). Skeleton fill `color-mix(in srgb, var(--text) 6%, var(--surface))`, `borderRadius: 6`, shaped to the content it replaces. Shimmer: slow left-to-right highlight, `1200ms linear infinite`; under `prefers-reduced-motion` render static blocks (no shimmer).
- **Blocking action (save, sync):** a `2px` indeterminate bar in `var(--primary)` pinned to the top of the affected panel, OR a 16px outline spinner (`stroke-width: 2`, `var(--text-secondary)`). No large centered spinners.
- Appearance: **Fade in only**, `--motion-fast` (140ms). Never lift/slide a loader.

### c. Error — recoverable inline
(Extends existing `S.errorBanner`.)
- Container: `background: color-mix(in srgb, var(--danger) 8%, var(--surface))`; `border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border))`; `borderRadius: 6`; `padding: 10px 14px`; text `var(--danger)`, 13px.
- Contains: outline alert icon (16px, `var(--danger)`) + message + an inline **retry/undo** affordance (link-button, `var(--primary)`). Recoverable errors must always offer the next action.
- Motion: **Slide + Fade** — translateY -4px→0, opacity 0→1, `--motion-base`. On dismiss/resolve, fade out `--motion-fast`.

### d. Error — fatal / screen-level
(Extends `S.authPage` + `S.authCard`.)
- Full-viewport centered, one card: `var(--surface)`, `1px solid var(--border)`, `borderRadius: 10`, minimal shadow `0 2px 24px color-mix(in srgb, var(--text) 6%, transparent)`.
- Icon: outline, ~40px, `var(--danger)`, `stroke-width: 1.5`. **Do not flood the screen red** — brick appears only on the icon and (optionally) a hairline. Quiet, not alarmist.
- Title: IBM Plex Sans 700, 22px, `var(--text)`. Body: 13px, `var(--text-secondary)`, ≤ ~60ch. One primary action (Reload / Go back), navy `S.btnPrimary`; optional secondary link for detail/copy-error.
- Motion: **Fade + Settle** on mount — opacity 0→1, translateY 12px→0, `--motion-settle` (340ms) `--ease-out`. No shake, no bounce.

---

## 6. Hardcoded-value audit — `src/styles/shared.js`

Token-based replacements. `color-mix()` is already used in this file (`S.errorBanner`), so it is an established, supported pattern.

| Location | Current hardcoded | Replacement | Notes |
|---|---|---|---|
| `authErrorBox.background` | `#fff5f5` | `color-mix(in srgb, var(--danger) 7%, var(--surface))` | Faint brick tint. |
| `authErrorBox.border` | `#f5c6c6` | `color-mix(in srgb, var(--danger) 30%, var(--border))` | Soft brick hairline. |
| `authErrorBox.color` | `var(--warning)` | `var(--danger)` | Role rename to canonical danger. |
| `authLockoutBox.background` | `#fffaf0` | `color-mix(in srgb, var(--accent) 8%, var(--surface))` | Lockout is **caution**, so maps to bronze `--accent`, not danger. |
| `authLockoutBox.border` | `#f5deb0` | `color-mix(in srgb, var(--accent) 32%, var(--border))` | Bronze hairline. |
| `authLockoutTitle / Desc / Timer.color` | `#8a6110` | `color-mix(in srgb, var(--accent) 60%, var(--text))` | Warm dark bronze-ink. **Verify ≥4.5:1 on the tinted bg during implementation; if short, shift to `70%` toward `--text`.** |
| `authChoiceIcon.background` | `rgba(0,173,187,0.1)` | `color-mix(in srgb, var(--primary) 10%, transparent)` | Navy 10% chip tint; icon glyph already `var(--primary)`. |
| `overlay.background` (scrim) | `rgba(0,0,0,0.45)` | **Default: keep neutral `rgba(0,0,0,0.45)`** (accepted exception — scrims are conventionally neutral and palette-independent). **Optional on-brand upgrade:** `color-mix(in srgb, var(--primary-dark) 50%, transparent)` for a richer deep-navy scrim. Pick the default unless the retheme deliberately opts into the navy scrim. | The one value in this table where a Maker chooses; the default removes the ambiguity. |
| `authHostDot.boxShadow` | `rgba(0,170,89,0.15)` | `color-mix(in srgb, var(--success) 18%, transparent)` | Success-tinted "online" glow ring; follows the refined success token. |
| `authCard.boxShadow` | `0 2px 24px rgba(20,30,40,0.06)` | `0 2px 24px color-mix(in srgb, var(--text) 6%, transparent)` | Old rgba was already essentially `--text`. Keep the minimal blur/spread — on personality. |

**Also flag `S.btnDanger` and `S.errorBanner`:** both key off `var(--warning)`. They render correctly (alias = brick) but new/retheme code should point them at `var(--danger)` for semantic hygiene. Not a line-item fix here since the alias keeps them working.

### Additional retheme surface (out of scope for this doc's line-item fixes — noted so it is not forgotten)
The schedule components carry hardcoded colors a future retheme ticket must migrate to these tokens — they are the real visual center of the app and deserve a scoped retheme spec:
- `src/components/schedule/SlotCell.jsx` — `ACTIVITY_COLORS` array, `ANCHOR_COLOR = '#A63595'` (→ `--anchor`), and `FLAG_COLORS`.
- `src/components/schedule/ActivityPalette.jsx` — local `COLORS` array (→ shared `ACTIVITY_COLORS`).
- `src/screens/ScheduleScreen.jsx` — weather `#2F7DE1` / `#EEF4FD`, flag `StatBadge` colors (`#F0585D`, `#2F7DE1`, `#7DC433`).
- `src/components/schedule/VersionsDropdown.jsx` — `#00ADBB08` / `#00ADBB14`.
- `src/components/schedule/EditModal.jsx` — `#EEF4FD` / `#2F7DE1`.

---

## 7. Font imports needed

Replace the current Fredoka + Nunito + IBM Plex Mono load in `index.html` with **Inter + IBM Plex Sans + IBM Plex Mono**.

Google Fonts families and weights:
- **Inter** — 400, 500, 600, 700
- **IBM Plex Sans** — 400, 500, 600, 700
- **IBM Plex Mono** — 400, 500, 600, 700

Single Google Fonts URL:
```
https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap
```

CSS fallback stacks in `:root`:
```css
--font-sans: 'Inter', system-ui, sans-serif;
--font-condensed: 'IBM Plex Sans', system-ui, sans-serif;
--font-mono: 'IBM Plex Mono', ui-monospace, monospace;
```
Note: Inter + IBM Plex Sans are both sans, so they pair on a **weight/role** axis (Plex for titles, Inter for body), not a contrast axis — acceptable because Plex Sans has a distinct, slightly warmer humanist character vs Inter's neutrality, and they are never set at the same size/weight in the same block. "Display" faces stay reserved for branding only.

---

## 8. Motion tokens

Encodes fade / lift / slide / settle. **No bounce, no elastic.** Three durations, one shared ease-out curve; large state changes get the longer duration, never a springier curve.

```css
--motion-fast:   140ms;  /* hover, focus, micro-state, loader fade-in */
--motion-base:   220ms;  /* fade / lift / slide of panels, banners, empty states, modals in */
--motion-settle: 340ms;  /* large settles: collapsing merge cards, expand/collapse, fatal-error mount */
--ease-out:      cubic-bezier(0.22, 1, 0.36, 1);   /* ease-out-quint feel; decelerates, never overshoots */
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1);     /* symmetric, for reversible toggles */
```

Rules for implementers:
- Only animate `opacity`, `transform` (translate), and `max-height` / `clip` for reveals. Avoid animating layout/color except where already established (existing `S.mergeCard` uses a 0.35s multi-prop transition — align it to `--motion-settle` + `--ease-out`).
- **No bounce/elastic curves. Ever.** The personality forbids overshoot.
- Distances are small and physical: lift/slide 4–12px, never more.
- Every animation ships a `@media (prefers-reduced-motion: reduce)` fallback → crossfade or instant.

---

## 9. Quick reference — canonical values for agent briefs

```
CSS vars (new):
  --bg #F4F3EF · --surface #FCFBF8 · --surface-elevated #FFFFFF
  --primary #173B63 (Deep Navy) · --primary-dark #0F2A47
  --secondary #2F6B58 (Forest Green) · --accent #B8833A (Warm Bronze)
  --success #4C8A63 · --danger #B44E48 (Muted Brick) · --warning #B44E48 (legacy alias of danger)
  --anchor #5C6B7A (fixed events) · --text #1E2A34 · --text-secondary #5C6670 · --border #D8DBD9
  --purple / --yellow-green: DEPRECATED
Fonts:
  --font-sans 'Inter' · --font-condensed 'IBM Plex Sans' · --font-mono 'IBM Plex Mono'
Activity palette (source of truth: src/components/schedule/slotCellConstants.js,
                  separation locked by slotCellConstants.test.js):
  ['#305C7B','#3D7D84','#4B8C60','#B6A050','#B68B6B','#BE6BC7']
  (Deep Slate Blue, Teal, Green, Ochre, Clay, Plum)
  Painted as a ~6-8px identity dot, not a cell fill — see §3.
Motion:
  --motion-fast 140ms · --motion-base 220ms · --motion-settle 340ms
  --ease-out cubic-bezier(0.22,1,0.36,1) · no bounce, no elastic
```
