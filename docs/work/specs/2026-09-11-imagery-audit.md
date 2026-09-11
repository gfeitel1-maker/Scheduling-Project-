---
title: Imagery Audit — Brand Art and Raster Assets
document_type: spec
status: active
authority: subordinate-to-constitution
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
owner: Governor (session app-icon-audit-a9a598)
created: 2026-09-11
archive_when: the raster-vs-vector empty-state decision is taken and the orphan deletion is resolved
review_trigger: any new image added under src/assets/, or a change to build.files
---

# Imagery audit — every PNG, JPG and SVG in the app

Status: RESOLVED — owner decided 2026-09-11; all four findings actioned
Date: 2026-09-11
Companion to: docs/work/specs/2026-09-11-icon-vocabulary.md (glyph-level)

That audit covered glyphs. This one covers pictures: the brand art, the
raster icons, and the asset tree behind them.

## What renders, and where

Twelve `<img>` call sites, all of them brand art. No screen has a decorative
header image; imagery appears only as an empty-state mark, an auth-screen
hero, or a celebration.

| Image | Where it renders | Display size |
|-------|-----------------|--------------|
| `tree-full-wide-login.png` | LoginScreen hero panel | up to 420px wide |
| `forest-circle.png` | CampBootstrapScreen badge | 64x64 |
| `forest-circle.png` | PairingPendingScreen badge | 56x56 |
| `forest-circle.png` | RootMap whole-camp empty state | 140x140 |
| `root-pattern-bg.jpg` | ModeSelectScreen background | tiled |
| `root-system-celebration.png` | postImportBanner | banner width |
| `decorative-sprout.png` | SeedScreen mark | — |
| `icons/ui-clock.png` | TimeBlocksScreen empty state | 96x80 |
| `icons/ui-people.png` | TiersScreen empty state | 96x80 |
| `icons/ui-people.png` | CohortsScreen empty state | 96x80 |
| `icons/ui-clipboard.png` | ActivitiesScreen empty state | 96x80 |
| `icons/ui-trash.png` | TrashScreen empty state | 96x80 |

## Finding 1 — empty states are split between raster and vector

This is the imagery-level version of the inconsistency the glyph audit just
closed, and it is the one a director can actually see.

Five screens draw their empty state with a **raster PNG brand icon** at 96x80:
Time Blocks, Age Divisions, Cohorts, Activities, Trash. Two draw theirs with a
**vector SVG outline icon** at 24px: Roots ("nothing needs you") and anything
using CalmEmptyState (a calendar). Conflicts used a third thing until today.

So "this screen has nothing in it yet" is a 96x80 full-colour illustration on
five screens and a 24px monochrome line drawing on two. They do not read as
the same product moment.

Worth noting the PNGs are *well made* — 192x160 sources for a 96x80 slot is an
exact 2x for retina, which is correct and deliberate. This is not a quality
problem. It is a question of which of two good treatments the app commits to.

## Finding 2 — the orphaned asset set names the same icons twice

`src/assets/brand/icons/` holds 29 PNGs. Five are imported. The other 24 are
unreferenced — and their names map almost one-to-one onto the SVG icons the
glyph audit just built:

    ui-calendar.png   ← CalendarIcon          ui-magnifier.png  ← (search)
    ui-check.png      ← CircleCheckIcon       ui-map-pin.png    ← PinIcon
    ui-info.png       ← InfoIcon              ui-pencil.png     ← PencilIcon
    ui-warning.png    ← WarningTriangleIcon   ui-gear.png       ← (settings)

Two parallel icon systems were designed for this app. One shipped as raster
brand art and was mostly never wired up; the other grew inline, file by file,
and is now consolidated. That is the decision underneath Finding 1: not "fix
the empty states" but "which icon system is the app's".

## Finding 3 — ~26MB of unused assets ship inside the installer

`package.json`'s `build.files` includes `"src/**/*"`. That is deliberate and
load-bearing — it fixes a packaged-app ERR_MODULE_NOT_FOUND (PR #19) — but it
means the ENTIRE asset tree is copied into every build, referenced or not.

    src/assets total                     30M
      tiles/ + tileworld/                12M   orphaned — zero references
      brand/ large orphans               13M   orphaned
      brand/icons/ orphans              1.4M   24 of 29 files
      vite scaffolding (hero/react/vite)  36K  orphaned
      ------------------------------------------
      actually referenced                ~4M

`src/assets/tiles/**` (Kenney tilesets) and `src/assets/tileworld/**` are the
largest single block and have no reference anywhere in `src/` or `electron/`.
They belong to the camp-map exploration, which lives in its own repository;
the spatial layer was removed from this app in PR #201.

`icons-ui.png` (2.6M) and `icons-decorative.png` (2.8M) are contact sheets —
the source grids the individual `icons/*.png` files were cut from. Artwork
sources, not runtime assets.

## Finding 4 — the heaviest shipped image is 4x oversized

`forest-circle.png` is 1200x1098 and 2.2MB. It never renders larger than
140x140 — and renders at 56px and 64px in its other two call sites. Even at 2x
retina for the largest use, 280px would do. A correctly-sized copy is
plausibly 30-60KB, a ~97% reduction on the single heaviest asset the app
actually uses.

`root-pattern.png` (2.2M) is orphaned, but `root-pattern-bg.jpg` (168K) — the
one actually used — suggests the JPEG re-encode already happened once and the
PNG was simply never removed.

## What the owner decided, 2026-09-11

**Finding 1/2 — the empty-state icons go.** Not "pick raster or vector" but
"neither": the owner's judgement was that a decorated empty state is noise. The
96x80 tiles on Time Blocks, Age Divisions, Cohorts, Activities and Trash are
removed; those screens show text alone. `S.emptyStateIcon` went with them, and
so did `CalmEmptyState.jsx` — a component with an SVG calendar and, as it turned
out, zero references anywhere (grep and `graphify affected` agree).

Imagery is KEPT on the seven first-impression surfaces: LoginScreen,
CampBootstrapScreen, PairingPendingScreen, RootMap, ModeSelectScreen, the
post-import celebration, and SeedScreen. That is the onboarding-chrome half of
W12b, which stands; the empty-state half of that spec is now marked superseded
in place so a future reader does not re-add them.

**Findings 3/4 — the weight goes, but the artwork does not get destroyed.**
`src/assets` is 30M → 1.3M. The split that made that safe:

- **Deleted** — `tiles/` + `tileworld/` (12M of Kenney CC0 tilesets belonging to
  the camp-map work, which lives in its own repository), the 28 *derived* icon
  PNGs (regenerable from the contact sheets), and the Vite scaffolding.
- **Moved to `design/brand-source/`** — the eight full-resolution kit images and
  the two contact sheets. These are source artwork, not runtime assets, and
  `design/` is outside `build.files`, so they stop shipping without being lost.
- **Resized** — `forest-circle.png`, 1200x1098/2.2MB against a 140px maximum
  use, is now 280x256/144KB.

The move rather than delete was forced by something the first pass missed:
`scripts/slice-brand-icons.mjs` reads `icons-ui.png` and `icons-decorative.png`
as file paths and cuts them into the individual icons. A string read by a script
is invisible to both an import graph and a component-level grep — deleting those
two "orphans" would have quietly broken the generator. Its `BRAND_DIR` now
points at `design/brand-source/`.

## Standing rule this leaves behind

`build.files` ships `src/**/*` wholesale (a deliberate fix for a packaged-app
module-resolution failure, PR #19). So **anything placed under `src/assets/`
ships, imported or not.** Derivatives go in `src/assets/`, sized at 2x their
largest display use; sources go in `design/brand-source/`. Both READMEs say so.

## What this audit did NOT cover

Emoji. The owner deferred them; they are tracked in the icon-vocabulary spec
as an explicit non-goal. Note only that the Versions dropdown now renders a
full-colour 📋 immediately beside a monochrome line-art chevron, so the
mismatch is more visible after the glyph work, not less.
