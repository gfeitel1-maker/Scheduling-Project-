---
title: Brand Placement Round 2 — Onboarding Chrome + Empty States (W12b)
document_type: design_spec
status: ready-for-maker
owner_approved: 2026-08-22
scope: onboarding/first-run chrome + empty states only. Populated Operate screens (Roots/Schedule/Setup) stay art-free.
---

# DESIGN SPEC — Brand Placement Round 2 (W12b)

Companion to `src/assets/brand/README.md` and `docs/governance/standards/DESIGN_STANDARD.md`. Palette
and type are FROZEN — nothing here introduces or alters a token. This spec covers only what W12
(app icon/favicon, LoginScreen hero, "foundation is set" celebration, mode-select watermark)
did not: `CampBootstrapScreen`, `JoinScreen`, `PairingPendingScreen`, and every setup-screen /
census / Roots empty state.

---

## 0. What I found before specing (read this before the per-surface calls)

**The icon sheets are not clean-alpha tiles.** `icons-ui.png` (1536×1024, 5×4 grid) and
`icons-decorative.png` (1536×1024) both carry a soft, blurred painterly *background* behind each
glyph — not transparent corners. `icons-ui.png`'s background is a diffuse green/tan wash that
changes per row; `icons-decorative.png`'s is a dark vignette. Slicing a cell out of either sheet
therefore yields a small illustrated **tile** with its own ambient backdrop baked in, not a glyph
you can recolor or drop onto an arbitrary background. This is why the README calls them "large
icons... NOT tiny nav glyphs" — treat every sliced icon as a framed illustration, always placed as
its own rounded card/tile on `--surface`, never as an inline icon substituting a `<svg>` glyph.

**`root-line-divider.png` has an alpha/fringing defect.** Composited over black, the cutout edges
show visible red halo artifacts around the root tendrils — a classic unpremultiplied-alpha issue
from the source generation. It is usable at small display size against `--bg` (the fringe is
sub-pixel at ~40px tall) but **do not scale it up** or place it over a dark background until it's
re-exported with premultiplied/clean alpha. Flagging this for Maker rather than silently avoiding
the asset, since the README lists it as an intended divider.

**No consistent empty-state pattern exists today.** Survey of the six setup screens plus
Roots/RootMap:

| Screen | Style used | Icon today | Notes |
|---|---|---|---|
| TimeBlocksScreen | `S.emptyState` (table cell) | none | |
| ActivitiesScreen | `S.emptyState` + wider padding override | none | |
| TiersScreen | `S.emptyState` (table cell) | none | |
| CohortsScreen | `S.emptyState` (table cell) | none | copy is actually the upstream-missing-programs message, not a cohorts-specific one — separate bug, not this spec's concern |
| SpecialDaysScreen | `S.emptyState` + enter transition | none | |
| EventScreen | own local `emptyStyles`, NOT `S.emptyState` | inline SVG (40×40 document glyph) | only one with a CTA button |
| TrashScreen | `S.emptyStateTall` (60px pad) | none | |
| RootMap (Roots) | per-domain-layer inline note, no full-page state | none | degrades per layer, not a page-level empty state |

Section 3 below establishes the ONE pattern all of these should converge on. This spec does not
fix the CohortsScreen copy bug or unify padding/table-cell mechanics — that's an implementation
detail for Maker to normalize onto the new pattern, not a brand-placement decision.

---

## 1. Slicing plan

### 1a. `icons-ui.png` — 5 col × 4 row grid, cell = 307.2 × 256 px

Crop rectangles (`left, top, width, height` in source px), row-major, left to right:

| # | Name | Slot | Crop (x, y, w, h) | Export as |
|---|---|---|---|---|
| 1 | home | R1C1 | 0, 0, 307.2, 256 | `ui-home.png` |
| 2 | calendar | R1C2 | 307.2, 0, 307.2, 256 | `ui-calendar.png` |
| 3 | people | R1C3 | 614.4, 0, 307.2, 256 | `ui-people.png` |
| 4 | clipboard | R1C4 | 921.6, 0, 307.2, 256 | `ui-clipboard.png` |
| 5 | map-pin | R1C5 | 1228.8, 0, 307.2, 256 | `ui-map-pin.png` |
| 6 | document | R2C1 | 0, 256, 307.2, 256 | `ui-document.png` |
| 7 | bell | R2C2 | 307.2, 256, 307.2, 256 | `ui-bell.png` |
| 8 | magnifier | R2C3 | 614.4, 256, 307.2, 256 | `ui-magnifier.png` |
| 9 | gear | R2C4 | 921.6, 256, 307.2, 256 | `ui-gear.png` |
| 10 | chart | R2C5 | 1228.8, 256, 307.2, 256 | `ui-chart.png` |
| 11 | sync | R3C1 | 0, 512, 307.2, 256 | `ui-sync.png` |
| 12 | upload | R3C2 | 307.2, 512, 307.2, 256 | `ui-upload.png` |
| 13 | download | R3C3 | 614.4, 512, 307.2, 256 | `ui-download.png` |
| 14 | link | R3C4 | 921.6, 512, 307.2, 256 | `ui-link.png` |
| 15 | clock | R3C5 | 1228.8, 512, 307.2, 256 | `ui-clock.png` |
| 16 | warning | R4C1 | 0, 768, 307.2, 256 | `ui-warning.png` |
| 17 | info | R4C2 | 307.2, 768, 307.2, 256 | `ui-info.png` |
| 18 | check | R4C3 | 614.4, 768, 307.2, 256 | `ui-check.png` |
| 19 | pencil | R4C4 | 921.6, 768, 307.2, 256 | `ui-pencil.png` |
| 20 | trash | R4C5 | 1228.8, 768, 307.2, 256 | `ui-trash.png` |

Destination: `src/assets/brand/icons/ui-<name>.png`.

Each cell's own soft background does not reach a clean edge — after cropping, apply a **soft radial
feather / vignette-matched square crop** (not a hard rectangle against a differently-colored
neighboring cell) so no cell shows a visible seam from its neighbor. Concretely: crop the exact
307.2×256 rectangle, then feather the crop's own edges (4–8px radial fade to transparent) so the
tile can sit on `--surface` or `--bg` without a hard box outline from the source photo-blur. This
is a Maker/asset-export step, not a design decision — flagging so it isn't skipped.

**Right-sized derivatives per use** (export multiple sizes per icon, only the ones actually used):
- Empty-state illustration: **96×80px** displayed (crop kept at its 4:3.33 aspect, i.e. scale
  proportionally — do not force to square). Source-export at 2x (192×160) for retina, compressed
  PNG or WebP.
- Onboarding/first-run accent (e.g. a small badge icon next to a step): **56×47px** displayed,
  2x export 112×94.
- Do not use any icon below ~48px displayed — matches the README's "not tiny nav glyphs" warning;
  watercolor + wood-grain detail turns to mush.

### 1b. `icons-decorative.png` — 4 col × 2 row grid (9 icons: 4 in row 1, 5 in row 2)

Source is 1536×1024 but the two rows are NOT equal height (row 1 icons run larger/more padded than
row 2 — visually row 1 cells look ~1536/4 × ~1024/2 = 384×512, row 2 cells ~1536/5 × 512 = 307.2×512).
Crop each icon individually by its actual illustrated bounds (not a rigid grid) since the composite
uses inconsistent icon sizing within each cell — a fixed-grid crop will clip content on at least
one row. Concretely:

| # | Name | Approx region (row/col) | Export as |
|---|---|---|---|
| 1 | magnifier-wreath | R1C1 (~0–384, 0–512) | `decorative-magnifier.png` |
| 2 | checklist-scroll | R1C2 (~384–768, 0–512) | `decorative-checklist.png` |
| 3 | tree-book | R1C3 (~768–1152, 0–512) | `decorative-tree-book.png` |
| 4 | hourglass | R1C4 (~1152–1536, 0–512) | `decorative-hourglass.png` |
| 5 | shovel | R2C1 (~0–307, 512–1024) | `decorative-shovel.png` |
| 6 | sprout | R2C2 (~307–614, 512–1024) | `decorative-sprout.png` |
| 7 | quill-scroll | R2C3 (~614–922, 512–1024) | `decorative-quill-scroll.png` |
| 8 | bundled-scrolls | R2C4 (~922–1229, 512–1024) | `decorative-bundled-scrolls.png` |
| 9 | tree-teardrop | R2C5 (~1229–1536, 512–1024) | `decorative-tree-teardrop.png` |

Destination: `src/assets/brand/icons/decorative-<name>.png`. These carry a dark vignette background
— crop tight to each icon's own vignette circle/frame (most already read as a self-contained
roundel), don't feather further; the vignette IS the frame. Right-size to **120–160px** displayed
wherever used (they read better larger than the UI set because the vignette needs room to breathe).
This set is used sparingly per §2/§3 below — not every empty state gets one.

---

## 2. Onboarding placements

These are first-run chrome (seen once, or a handful of times, per device) — brand-forward is
correct here per the README's placement philosophy. The primary action (create/join/pair) must
stay the visual lead; imagery supports, never competes.

### CampBootstrapScreen.jsx

Currently: `S.authPage` → single centered `S.authCard`, no imagery (this is the "Hosting on this
device" bootstrap form). Add `forest-circle.png` as a small badge above the existing role pill,
inside the card — mirroring how PairingPendingScreen already centers a logo block.

- Insert directly above the existing `S.authRolePill` div (line 40 in current file), inside
  `S.authCard`, its own centered block:
  ```
  <img src={forestCircle} alt="" style={{ width: 64, height: 64, display: 'block', margin: '0 auto 14px' }} />
  ```
- Size: 64×64 displayed (2x export 128×128). `forest-circle.png` already has clean alpha (verified —
  transparent corners, unlike the icon sheets), so no feathering needed.
- `alt=""` — decorative, the title text already carries the meaning ("Set up your camp").
- Do not resize the card or otherwise touch layout; this is a small addition above existing content,
  not a redesign of the form.

### JoinScreen.jsx — searching / found states

Currently: `S.authPage` → `S.authCard`, spinner + text, no imagery. Two sub-states matter:

- **`searching` state:** no image change — a spinner mid-search is a frequent, functional moment
  (device may retry); adding brand art here risks feeling like decoration on a loading state,
  which the Operate-clean instinct correctly resists even in onboarding chrome. Leave as-is.
- **`empty` state ("No camps found nearby")** — currently a bare 📡 emoji at `opacity: 0.5`
  (line 102). Replace the emoji with `decorative-magnifier.png` (the wreathed magnifying glass —
  thematically exact for "searching found nothing"), 72×72 displayed, centered, replacing the
  emoji's position exactly. This is the one moment in JoinScreen that qualifies as a genuine
  first-run empty state (rare, not decoration-for-its-own-sake — it explains "nothing here yet,"
  matching §3's empty-state pattern below). Keep the existing "Double-check that..." body copy
  unchanged.

### PairingPendingScreen.jsx

Currently: `S.authLogoBlock` → wordmark-only "Shoresh" text, then spinner, then copy. This screen
is rare (once per device, while waiting for director approval) and emotionally suspended ("am I
stuck?") — a good candidate for the delight budget, used quietly.

- Replace the plain text logo block with `forest-circle.png` at 56×56 above the existing "Shoresh"
  wordmark (keep the wordmark — don't remove brand text, add the mark above it), matching the
  CampBootstrapScreen treatment for consistency across the three onboarding screens.
- **`pairing_denied` state:** do NOT show the forest-circle mark here — a denial is a
  disappointing/blocking outcome; pairing this rejection message with warm forest imagery reads as
  tonally wrong (the README's personality section: warmth lives in paper/bronze, "never in
  decoration" — and specifically, decoration should never sit next to a message that undercuts it).
  Keep `pairing_denied` exactly as it is today: text-only, `--danger`-adjacent tone via existing
  copy, no imagery. This is the one onboarding surface where the answer is "don't place art here."

---

## 3. Empty-state placements — the ONE reusable pattern

### The pattern (applies to every screen in the table in §0)

Extend `S.emptyState` in `src/styles/shared.js` with an optional icon slot, rather than inventing a
parallel style object (EventScreen's local `emptyStyles` and TrashScreen's `emptyStateTall` both
already exist as siblings to unify — Maker's call how deep to refactor those call sites, but the
new **shape** is:

```
[ icon tile, 96×80, centered, margin-bottom 14px ]
[ title — existing S.emptyStateTitle, unchanged ]
[ body — existing S.emptyStateBody, unchanged, ≤ ~60ch ]
[ optional CTA — existing S.btnPrimary/authBtnPrimary pattern where a screen already offers one
  (EventScreen keeps its CTA; the five that don't, don't gain one — that's a UX-copy decision
  outside this spec's scope) ]
```

- Container stays `S.emptyState`'s existing "no card, no shadow, no border" — DESIGN_STANDARD §5a
  is explicit that emptiness should feel calm, not boxed. The icon tile does NOT get its own card
  either; it sits directly on the page/table background, consistent with that rule.
- Icon source: sliced `ui-*.png` tiles from §1a. **Icon-to-screen mapping:**

| Screen | Icon | Rationale |
|---|---|---|
| TimeBlocksScreen | `ui-clock.png` | time blocks = clock face, exact match |
| ActivitiesScreen | `ui-clipboard.png` | closest available; no dedicated "activity" glyph exists in the 20-icon set |
| TiersScreen | `ui-people.png` | age divisions group campers — people glyph is the closest fit |
| CohortsScreen | `ui-people.png` | same rationale as Tiers (cohorts are also people-groupings); acceptable to reuse — these two screens are adjacent in the setup flow and a repeated icon doesn't read as an error the way it might elsewhere |
| SpecialDaysScreen | `ui-calendar.png` | a special day is still a calendar concept |
| EventScreen | `ui-calendar.png` | same reasoning; EventScreen already has its own inline SVG + CTA — see note below |
| TrashScreen | `ui-trash.png` | exact match, already exists in the 20-icon set |
| Roots (whole-camp empty) | `forest-circle.png`, not a `ui-*` tile | see dedicated treatment below — this is a bigger, first-impression moment, not a routine empty list |

- **No icon available / doesn't fit:** none of the seven setup screens lack a reasonable match, so
  no fallback case exists today. If a future setup screen has no thematic match in the 20-icon set,
  the fallback is: **no icon**, title + body only (i.e. today's default for five of these screens) —
  never force a mismatched icon just to have one.
- **EventScreen exception:** EventScreen already has a custom inline SVG icon and a CTA button
  (the only screen with both). Replace only the icon (inline SVG → `ui-calendar.png` at the same
  96×80 size, same position) and keep its existing CTA and copy untouched — this is the one screen
  where the pattern is "swap the icon into the existing structure," not "build the structure."

### Roots empty-camp state ("open and waiting")

This is a different tier from the routine per-screen empty states above — it's the first thing a
director sees on Roots before any data exists, i.e. closer to onboarding chrome than to a
list-emptiness moment, and per the locked Roots-as-Hub IA (project memory: NO explainer banners,
state carried by UI not narration, positive "open and waiting" framing).

- Use `forest-circle.png` at **140×140** displayed, centered in the Roots panel where the domain
  layers would otherwise render, once none of the five domains (units/groups/activities/locations/
  staff) have any data.
- Pair with a single line of copy already established by the roots-as-hub design lock — this spec
  does not re-litigate that copy, only the art placement. If Roots doesn't yet have that copy
  wired, default to something in the register of "Nothing imported yet — bring in your roster to
  get started," one line, `S.emptyStateBody` styling, no separate title.
- Per-domain-layer notes (RootMap's existing "No entities imported yet — this layer has no root")
  stay exactly as they are — small, inline, text-only. Do not add per-layer icons; the single
  full-camp forest-circle moment is the only art in this surface. Layering icons onto every
  individual domain note would violate the Operate-clean boundary (§4) — these layers are inside
  the working Roots screen, which stays clean once any data exists, and stays clean even before
  data exists except for this one whole-camp moment.

---

## 4. The Operate-clean boundary

**Stays completely art-free, always, regardless of data state:**
- Schedule screens (`ScheduleScreen.jsx` and all `src/components/schedule/*`) — grid, toolbar,
  drag-and-drop surfaces. Already a strict CSS-exception zone per `CLAUDE.md`; do not add a second
  reason to touch it.
- Every populated (non-empty) setup screen — TimeBlocks/Activities/Tiers/Cohorts/SpecialDays/
  Event/Trash once they contain rows. The icon tiles in §3 exist ONLY inside the `.length === 0`
  branch; they must never appear once a screen has data, and must never render as a persistent
  header/corner decoration on a populated table.
- Roots domain layers once any entity exists in them — the forest-circle full-camp moment in §3
  is a one-time-only render, gone the instant even one entity exists anywhere in the camp; it does
  not partially fade or persist as a corner watermark.
- Any screen not explicitly named in §2 or §3 (Days screen, Locations screen if one exists, System/
  Settings, Device Manager, etc.) is unchanged by this spec — no art added anywhere not listed
  above.

If Maker finds a screen that seems like a plausible empty-state candidate but isn't in the §3 table,
the default is **don't add art** — flag it back rather than extending scope past what's specced.

---

## 5. Restraint + motion notes

- **Onboarding badges (CampBootstrap, JoinScreen empty, PairingPending):** on mount, **Fade + Lift**
  matching DESIGN_STANDARD §5a — opacity 0→1, translateY 8px→0, `--motion-base` (220ms) `--ease-out`.
  This is the same treatment the standard already specs for empty states generally; brand art
  mounting alongside a card is not a special case that earns its own motion language.
- **Setup-screen empty-state icons (§3):** icon and text fade/lift together as one block, not
  separately staggered — a title+icon+body appearing as a single coordinated unit reads as "this is
  one message," which is the correct read for an empty state. Same values as above:
  `--motion-base` (220ms), `--ease-out`, no stagger between icon/title/body.
- **Roots whole-camp forest-circle:** this is the single highest-emotion moment in this spec's
  scope (first real look at an empty camp) — it earns the **`--motion-settle`** duration (340ms)
  rather than `--motion-base`, still `--ease-out`, still no bounce. Longer settle for a rarer,
  weightier first-impression moment; DESIGN_STANDARD §8 already reserves `--motion-settle` for
  "large settles," and this qualifies more than a routine list emptying.
- **No animation on transition INTO the populated state.** When a screen goes from empty (icon
  showing) to populated (first row added), the icon simply unmounts — do not animate it away with
  a special exit sequence. That moment is covered by whatever entrance animation the newly-added
  row already gets; adding a farewell animation to the icon on top of that is exactly the kind of
  decoration-for-its-own-sake `emil-design-eng` and `find-animation-opportunities` both reject
  (this transition happens rarely per screen, but the *icon exit* itself carries no state
  information worth animating — the row appearing already tells the whole story).
- **`prefers-reduced-motion`:** every fade+lift above degrades to opacity-only crossfade at the same
  duration, per DESIGN_STANDARD §5a/§8 — no translateY under reduced motion.
- **Nothing here loops, pulses, or plays ambient motion.** All of it is a one-time entrance tied to
  a state transition (screen mount or list becoming empty), consistent with "brand imagery is
  presence, not decoration for its own sake."

---

## 6. Prototype

Not produced. The per-surface changes in this round are additive insertions into existing,
already-built screens (a badge above existing content, an icon swap in an existing empty-state
branch) rather than a new layout or a genuinely open visual question — the existing screens
already establish every layout parameter (card width, centering, spacing rhythm) that the new
art must simply sit inside. A throwaway HTML mockup would mostly reproduce `S.authCard`/
`S.emptyState` with a swapped-in `<img>`, which doesn't resolve any ambiguity a static crop
preview and this written spec don't already resolve. If Maker or Governor wants a visual check
before building, the fastest path is a quick in-app screenshot after the first surface lands
(CampBootstrapScreen is the smallest change) rather than a separate prototype file.

---

## 7. Implementation notes for Maker

- Slice both icon sheets once, up front, into `src/assets/brand/icons/` per §1 — every placement
  in §2/§3 depends on those files existing first. Do this as its own commit/step before touching
  any screen, so a slicing mistake is caught before it's threaded through six files.
- Export as compressed PNG (or WebP if the build pipeline already serves WebP elsewhere — check
  before introducing a new format; nothing in the existing brand kit suggests one is set up).
  Target the 2x-retina sizes named in §1a/§1b as the actual shipped file dimensions — do not
  reference the 1536×1024 source sheets from any component `import`.
  a fringing/feathering pass on the `ui-*` slices per §0 before they're used anywhere; skipping it
  will show visible hard-edged squares against `--surface`/`--bg`.
- `root-line-divider.png` is out of scope for this round (no divider placements are specced above)
  — the fringing note in §0 is a flag for whoever picks it up next, not a task here.
- `forest-circle.png` already has clean alpha and needs no rework — verified directly by inspecting
  the source file.
- Keep every new `<img>` `alt=""` (decorative) except where an icon is the *only* content conveying
  meaning with no adjacent text — none of the placements in this spec meet that bar (every icon in
  §2/§3 sits next to a title/body that already carries the meaning), so `alt=""` applies uniformly.
- Do not touch `S.mergeEmptyState`-adjacent code outside what §3 asks — the CohortsScreen copy bug
  noted in §0 is real but not this spec's to fix.
