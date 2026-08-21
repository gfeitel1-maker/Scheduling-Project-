# Shoresh brand assets ("From Roots to Rhythm")

Owner-provided watercolor identity assets (2026-08-21), source-of-truth for **W12
(brand application)**. See `docs/work/specs/camp-setup-ingestion-program.md` (W12) and
the brand reference for placement philosophy.

## Format decision: raster, not SVG
These are **painterly watercolor** images. They are kept as **PNG on purpose** — vector
tracing (PNG→SVG) posterizes painterly art, loses the watercolor texture, and produces
bloated output that renders worse than the raster. SVG is for flat/line art only; a
scalable-vector version of any of these would be a *redraw*, not a conversion.

## The kit
| File | What it is | Intended use (larger sizes only) |
|---|---|---|
| `tree-full.png` | Full tree + root system (compact) | logo/hero on splash, login, completion |
| `tree-full-wide.png` | Full tree + roots (wide) | wide hero / banner |
| `tree-canopy.png` | Tree canopy only (no roots) | pairing with a separate root element |
| `root-system.png` | Spreading roots only (no tree) | "foundation" motif under content |
| `forest-circle.png` | Tree + lake + sunrise in a gold ring | badge / circular brand mark, onboarding |
| `root-line-divider.png` | Horizontal root-and-leaf divider | section dividers, print/export headers |
| `root-pattern.png` | Seamless root-network texture | faint background / watermark |
| `icons-ui.png` | 20-icon UI set (home, calendar, people, clipboard, map-pin, doc, bell, magnifier, gear, chart, sync, upload, download, link, clock, warning, info, check, pencil, trash) | large icons: empty states, cards, section headers — NOT tiny 16–24px nav glyphs (watercolor detail turns to mush small) |
| `icons-decorative.png` | 9 wreathed illustrative icons (magnifier, checklist scroll, tree-book, hourglass, shovel, sprout, quill scroll, bundled scrolls, tree-teardrop) | decorative accents at larger sizes |

## Integration notes (W12)
- **Placement:** artwork on Persuade/first-impression/print/chrome surfaces; Operate
  working screens (Roots/Schedule/Setup) stay clean. Palette + type stay FROZEN — no reskin.
- **Icon grids** (`icons-ui.png`, `icons-decorative.png`) are composite sheets — slice the
  individual icons at integration and export each at its needed size.
- **Optimize per surface at integration:** export a right-sized, compressed derivative for
  each specific use (a favicon is ~64px, an empty-state illustration ~400px). These source
  files are intentionally higher-res so derivatives stay crisp; do not reference the raw
  files directly in shipped UI where a smaller derivative will do.
