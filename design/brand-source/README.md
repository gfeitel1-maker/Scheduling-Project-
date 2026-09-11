# Brand source artwork — not shipped

The full watercolor identity kit and the icon contact sheets.

These live outside `src/` on purpose. `package.json`'s `build.files` ships `src/**/*`
wholesale (a deliberate fix for a packaged-app module-resolution failure, PR #19), so
anything under `src/assets/` rides into every installer whether or not a screen imports
it. Before 2026-09-11 that meant ~26MB of unreferenced artwork and third-party game
tilesets in every build.

Nothing here is imported by the app, and nothing here should be. To use one of these:
export a right-sized, compressed derivative into `src/assets/brand/` — 2x its largest
display size, no more — and import that. See `src/assets/brand/README.md`.

| File | What it is |
|---|---|
| `tree-full.png` | Full tree + root system (compact) |
| `tree-full-wide.png` | Full tree + roots (wide) |
| `tree-canopy.png` | Tree canopy only (no roots) |
| `root-system.png` | Spreading roots only (no tree) |
| `root-line-divider.png` | Horizontal root-and-leaf divider |
| `root-pattern.png` | Seamless root-network texture |
| `icons-ui.png` | 20-icon UI contact sheet |
| `icons-decorative.png` | 9 wreathed illustrative icons |

`scripts/slice-brand-icons.mjs` reads the two contact sheets and writes individual PNGs
into `src/assets/brand/icons/`. It is run by hand, not wired into a build. Note that the
app's icon vocabulary is vector (`src/components/icons/index.jsx`); a watercolor PNG
cannot follow the light/dark theme and turns to mush under ~48px, so slicing a new one is
the exception, not the default.
