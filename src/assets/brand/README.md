# Shoresh brand assets ("From Roots to Rhythm")

Owner-provided watercolor identity assets (2026-08-21). See
`docs/work/specs/camp-setup-ingestion-program.md` (W12) for placement philosophy.

## Where the files are, and why it is split

**This directory ships.** `package.json`'s `build.files` includes `src/**/*` — a
deliberate fix for a packaged-app module-resolution failure (PR #19) — so every byte
under `src/assets/` is copied into every installer whether or not a screen imports it.

So the kit is split in two:

- **`src/assets/brand/` (here)** — only the derivatives actually rendered by a screen,
  each sized for its largest real use. Adding a file here adds it to the installer.
- **`design/brand-source/`** — the full watercolor kit and the icon contact sheets.
  Source artwork, not runtime assets. Not shipped, not imported, never deleted.

## What ships today

| File | Rendered by | Largest display size |
|---|---|---|
| `tree-full-wide-login.png` | `LoginScreen` hero | 420px wide |
| `forest-circle.png` | `CampBootstrapScreen` (64px), `PairingPendingScreen` (56px), `RootMap` empty state (140px) | 140px |
| `root-pattern-bg.jpg` | `ModeSelectScreen` background | tiled |
| `root-system-celebration.png` | `postImportBanner` | banner width |
| `icons/decorative-sprout.png` | `SeedScreen` mark | — |

`forest-circle.png` was 1200x1098 and 2.2MB against a 140px maximum; it is 280x256 and
144KB now. That is the rule below, applied — and the mistake it exists to prevent.

## The rule for adding one

**Export a right-sized derivative; never reference a source file directly.** Size it at
2x its largest display size for retina and no more. The sources in `design/brand-source/`
are intentionally high-resolution so derivatives stay crisp — that resolution is for the
export step, not for the installer.

## Icons: raster here is the exception, not the pattern

The app's icon vocabulary is **vector**, in `src/components/icons/index.jsx` — hand-authored
outline SVG that inherits `currentColor` and follows the light/dark theme. Reach for that
first. See `docs/work/specs/2026-09-11-icon-vocabulary.md`.

`icons-ui.png` and `icons-decorative.png` in `design/brand-source/` are contact sheets that
`scripts/slice-brand-icons.mjs` cuts into individual PNGs. Five of those were once used as
96x80 empty-state illustrations; four were removed in the 2026-09-11 imagery pass when the
owner judged decorated empty states to be noise. Only `decorative-sprout.png` remains, on
SeedScreen. Re-run the slicer if a surface genuinely needs a painterly icon — but a
watercolor PNG cannot follow the theme and turns to mush under ~48px, which is why it is
the exception.

## Format: raster, not SVG

These are **painterly watercolor** images, kept as PNG on purpose. Vector tracing
posterizes painterly art, loses the texture, and produces bloated output that renders
worse than the raster. A scalable version of any of these would be a *redraw*, not a
conversion. This is why the vector icon set above is a separate, flat-art vocabulary
rather than a traced version of this kit.
