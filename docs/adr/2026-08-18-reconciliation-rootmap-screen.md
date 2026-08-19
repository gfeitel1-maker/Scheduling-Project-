---
title: "Reconciliation root-map screen — hybrid Blender-parts + procedural composition"
document_type: adr
status: superseded
authority: normative
implementation_state: not_started
date: 2026-08-18
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes_partial: docs/adr/2026-08-18-roots-reconstruction-moment-gating.md
related_specs:
  - docs/work/specs/2026-08-18-rootmap-interaction-model.md
  - docs/work/specs/2026-08-18-rootmap-asset-kit.md
archive_when: superseded by a later reconciliation-visual ADR, or the root-map screen ships and this is folded into PLATFORM_STATE
---

# Reconciliation root-map screen

> **SUPERSEDED (2026-08-18)** by [`docs/adr/2026-08-18-rootmap-screen-port.md`](2026-08-18-rootmap-screen-port.md).
> The Blender-parts-kit hybrid described below was explored and abandoned after repeated visual misses;
> the shipped approach ("Approach A") uses a single AI-generated root illustration (background keyed
> transparent) as the backdrop with data-bound interactive SVG nodes on the roots. This document is
> retained for the decision history only.

## Decision

The reconciliation experience becomes a **persistent screen organized around a root-and-tree
illustration**, not the transient gated "reconstruction moment." A tree whose **roots (below the
ground line) explain what the import took in** — five domains → children, each carrying an ingested
state — and whose **canopy (above) represents the schedules/activities/maps that grow from those
foundations**. Around it: a header, four summary tiles, and a right-side "Needs your attention" panel.

The illustration is built **hybrid**:
- **Interactive/data layer = procedural SVG/DOM**, drawn by code from the real reconciliation model
  (`buildReconciliationReport` → `domainRollup`), so it is always true to the actual camp and fully
  interactive/accessible.
- **Beauty layer = a kit of Blender-rendered parametric parts** (data-independent), composited under
  the skeleton by a pure composition function. Blender supplies engraving-grade filaments and texture;
  code decides length, count, and placement. They stay aligned because the parts are reusable, not a
  fixed picture.

This **partially supersedes** `2026-08-18-roots-reconstruction-moment-gating.md`: the gated one-shot
"moment" and its `ReconstructionMoment.jsx` are retired as the primary treatment. The gating predicate
work (`shouldShowReconstructionMoment`, `firstImportSignal`) and the copy generator are salvageable if
we later want a first-import flourish, but they are not the direction.

## Why (context)

Five prior visual attempts were rejected: an animated botanical canvas and three art-direction variants
(all broke Shoresh's own `index.css` motion contract), then a too-minimal quiet fade (lost the roots).
The turning insight, from an `impeccable` product-register critique, was that motion must belong to the
product — a **static illustration revealed calmly beats choreography**. The owner then supplied a mockup
and corrected the metaphor: roots = *what was ingested* (an explainer, not a nav pane); tree = *the
schedules that grow*. The owner chose the hybrid render path and proposed the Blender-parts-kit
approach directly. This ADR converges that into a buildable plan before any render or code is spent.

## Architecture

### Two layers, independently reworkable
- **Skeleton (code):** interactive nodes (domain tips + child nodes) as real `<button>` elements with
  44×44px hit areas, state dots on Shoresh tokens, keyboard/focus/ARIA. Never navigates away.
- **Beauty (assets):** static Blender parts + baked textures composited beneath. No per-frame
  animation — one calm `importCardIn` fade-in for the whole thing.

### The parts kit (from the asset spec)
Blender renders: trunk, taperable root main-segment, 2-way & 3-way forks, taper-tip, and fine
**filament clusters baked as ~3 density-band textures** (the single decision that avoids the earlier
`feDisplacement` lag). Canopy foliage, branch, ground strip, and ink/paper grain are cheaper as
**SVG/CSS**. A manifest JSON (part id, normalized anchors, variants, intrinsic size) is what the code
reads. Root browns (#6B5237 / #5C4632) on cream are baked into the organic renders; **state dots stay
app tokens, drawn by code, never baked in.**

### The composition seam (pure, testable)
```
composeRootMap(model, { width, height, seed }) -> { placements: Placement[], canopySize }
```
Lives in `src/ingest/rootMapComposition.js`, reuses `domainRollup`'s `DOMAINS`/`computeDomainCounts`
(same vocabulary the reconciliation report already uses, so they can't disagree) and the schedule
engine's seeded-PRNG pattern for deterministic variant selection. `interactive: true` only on data
nodes; everything else is decorative. Unit-tested at the data→geometry boundary.

### Interaction model (from the interaction spec)
- **Click = populate the attention panel in place** (never navigate). Root click shows that piece's
  full picture; tile click filters the roots (opacity only) + lists that state. A "Show all" resets.
- **Hover = preview only** (ring + wash + path highlight, 300ms tooltip) — no hover-scale, per the
  "press only" contract.
- **Four states on existing tokens:** understood = pine `--secondary`, needs-attention = brass
  `--accent`, changed = navy `--primary`, not-in-source = **hollow ring** (the color-independent
  distinguisher). Brick/`--danger` deliberately unused — attention is a *question*, not an error.
- **Canopy is neutral/passive** (not a second source of truth for schedule health).
- Motion pinned to `index.css`; reduced-motion keeps everything legible instantly; paper-halo captions
  fix the earlier legibility defect; desktop-primary with a defined narrowing floor at 768px.

## Performance budget
≤40 image elements per illustration, zero runtime SVG filters, filament density as baked textures not
scattered instances. Interactive dots/hit-areas are light SVG/DOM on top.

## Decisions needed from the owner (recommendations given)

| # | Question | Recommendation |
|---|---|---|
| A | **This becomes a persistent reconciliation screen, superseding the gated "moment."** | **Yes** — the mockup is a full screen; the moment direction is retired. (The one real framing call.) |
| B | Clicking a domain: expand children inline, or panel-only? | **Panel-only** — keeps it an explainer, no layout mutation, not a tree control. |
| C | Show Context domain when its data is fully absent? | **Yes** — always five domains; "nothing about camp culture was in this file yet" invites adding it. |
| D | Canopy carries state? | **No** — neutral; schedule health has its own vocabulary elsewhere. |
| E | Filament variant count (repetition risk) | **Defer to Phase 2** — decide on real renders; start at 3 bands, add variants if it reads repetitive. |
| F | Canopy medium: SVG or Blender? | **Start SVG**; accept reversal risk if the engraving look doesn't land flat. |

## Phasing
1. **This ADR approved** → 2. **Blender renders the parts kit** (iterate on a few parts first) →
3. **Procedural assembly + screen integration** (test-first at `composeRootMap`) → 4. **Review loop**
(impeccable/designer → verifier → owner).

## Risks
- Baked filament textures may read repetitive on close inspection (mitigation: 6–9 variants).
- Canopy-as-SVG may not match the engraving beauty of the Blender roots (reversal risk).
- Packaged Electron build must bundle the new asset dir (known `build.files` src-bundling gotcha).
- Scope: this is a screen redesign, larger than the "moment." Accepted per owner direction; pre-production.
