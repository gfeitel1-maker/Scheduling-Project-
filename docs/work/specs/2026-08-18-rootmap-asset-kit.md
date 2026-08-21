---
title: "Root map — Blender asset-kit spec and procedural composition contract"
document_type: spec
status: superseded
created: 2026-08-18
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-08-18-roots-reconstruction-moment-gating.md]
related_specs: [docs/work/specs/2026-08-17-roots-visual-expression-brief.md]
related_tickets: []
archive_when: "the composeRootMap contract is implemented + unit-tested against real buildReconciliationReport output, and the asset kit is rendered and shipping in the packaged app, or the hybrid approach is dropped in favor of a pure-SVG direction"
---

# Root map — Blender asset-kit spec and procedural composition contract

## Summary

This spec defines a **kit of parametric, data-independent Blender-rendered parts** — trunk,
root segments, forks, tips, filament clusters, canopy puffs — plus the **pure-function
composition contract** app code uses to arrange those parts into a specific camp's root map
from `buildReconciliationReport`'s output (`src/ingest/reconciliationReport.js`). Blender never
sees camp data. It renders reusable geometry once, offline, to a manifest + sprite/texture set
checked into the repo. Code reads the manifest and decides placement at runtime from the real
domain/decision counts, the same way `domainRollup.js`'s `computeDomainCounts` already reduces
reconciliation decisions to a per-domain understood/needs-attention state for the reconstruction
moment (`docs/adr/2026-08-18-roots-reconstruction-moment-gating.md`).

This spec is the asset-kit half. It does not decide *where* the root map renders in the app
(reconstruction moment replacement vs. a persistent ReconciliationScreen surface vs. something
else) — that placement decision belongs to the ADR the Governor is assembling around this spec.
Everything here is written to be placement-agnostic: a static image built from placed parts,
handed to whatever surface wants it.

## Context — what already exists, what this must not repeat

Two things already happened and both matter as boundary conditions:

1. **The Canvas-2D botanical-growth reconstruction moment was built and then explicitly
   reverted** (`ReconstructionMoment.jsx`'s own comment: "read as a foreign object against the
   app's own written motion contract"). It was replaced by a plain settling list + a small
   static `RootGlyph`. This spec's output must not reintroduce that failure mode — a busy,
   invented-motion illustration competing with the app's actual UI. The static-first constraint
   in §5 below is a direct consequence of that lesson, not a preference.
2. **A pure-SVG prototype (`docs/work/specs/2026-08-18-roots-prototype.html`) already validated
   the *information design*** — proportion of quiet-to-lit roots as a pre-attentive completeness
   signal, the needs-attention root as the only saturated line in a muted field — but **lagged**
   under an `feDisplacement` filter applied across many paths. The owner's hybrid decision keeps
   that validated information design and that palette family, and fixes the performance problem
   by moving the organic beauty into a small number of pre-rendered raster/texture assets instead
   of many live-filtered SVG paths. This spec is the performance fix, not a redesign of what the
   visual communicates.

Both existing prototypes already prove the shape works. This spec turns "prove it" into
"build it repeatably for any camp's data."

## 1. Parts list

Ten candidates were evaluated against the naturalist mockup (`2026-08-18-roots-dirA-naturalist.html`)
and the prototype's growth logic (`2026-08-18-roots-prototype.html`, `drawRoot`). Final kit:

| Part | Render as | Purpose | Variants | Size steps | Why |
|---|---|---|---|---|---|
| **Trunk base** | Blender (3D → baked PNG) | Single fixed anchor point where all domain roots originate; the one non-repeated element | 2 (thin-camp / rich-camp silhouette) | 1 size (fixed at composition origin) | Only ever drawn once per illustration — not worth parameterizing beyond a silhouette swap for empty vs. populated camps |
| **Root main-segment** | Blender (3D, tube w/ taper modifier → baked PNG per variant) | The per-domain limb; one instantiated per domain, length/width driven by data | 6 curvature variants (gentle S-curve to sharper elbow, ±hand-picked) × 2 taper profiles | 3 length steps (short/medium/long, matching decision-count buckets) | This is the part that must read as organic per-domain, not templated; curvature variety is what the mockup's "naturalistic" quality comes from. Taperable so width can encode weight/importance without a second geometry |
| **Root fork (2-way)** | Blender | Where a domain's root splits toward two children (e.g. Structure → cohorts, groups) | 3 angle-spread variants | 1 size (anchors scale via segment following it) | Every domain has 1-4 children in `DOMAIN_OF`; forks are the branching grammar, kept generic rather than per-child-count special cases |
| **Root fork (3-way)** | Blender | Domains with 3+ children in one hop (avoids chaining two 2-way forks, which reads mechanical) | 2 angle-spread variants | 1 size | Structure has 3 entities (cohorts, tiers, groups); a dedicated 3-way fork keeps that domain's silhouette organic instead of visibly recursive |
| **Root taper-tip** | Blender | Terminal cap on every leaf branch (a root that just stops mid-air reads as a bug, not a design) | 4 variants | 1 size | Cheap, high value for polish; every open end needs one |
| **Fine filament cluster** | **Baked texture, not per-instance geometry** (see §4) | The dense fuzzy-root background texture that gives the "living root system" density in the mockup | 3 density bands (sparse/medium/dense, chosen by total-fact-count) as 3 separate baked PNGs | fixed per band | This is exactly the element that caused the SVG lag (many thin paths). Baking it as a texture, not scattering individual filament objects, is the load-bearing performance decision in this whole spec — see §4 |
| **Foliage puff / canopy cluster** | **SVG/CSS, not Blender** | The engraving-style tree crown above the surface line | 4 puff variants, composed as a canopy group | 3 canopy-size steps (matches overall camp "richness") | The canopy is decorative framing, not a data-bearing element (no domain maps to canopy structure) — it never needs the organic tube-and-taper geometry Blender is earning its keep on. CSS/SVG keeps it cheap and lets it recolor/retheme without a re-render |
| **Branch segment (above ground)** | SVG/CSS | Trunk-to-canopy connective branching, visible engraving-style lines | 3 variants | 2 length steps | Same reasoning as canopy: no data maps here, pure framing, cheapest medium wins |
| **Soil/ground strip** | SVG/CSS (a single flat rect + gradient) | The surface line separating canopy from roots | 1 | fixed | Trivial geometry; a 3D render would be waste |
| **Ink stroke grain (texture)** | Blender-rendered noise pass, baked once | Applied as a multiply-blend overlay across the whole composed image to unify the engraving look | 1 (tileable) | fixed, tiled to canvas size | One shared overlay, not per-part, so it never multiplies file count |
| **Paper texture (background)** | Pre-existing/stock, not Blender | Warm cream page ground (`#F4F1EA`) | 1–2 | fixed | Not worth a render pass; a flat color + very light procedural noise (CSS `background` with a subtle SVG noise filter, applied ONCE to the whole canvas, not per element) reproduces this cheaply. If the noise filter is measurably heavy, ship it as a static baked PNG instead — decide during Phase 3 build, not here |

**Split rule applied throughout:** anything a domain/child/state maps onto (trunk, root
segments, forks, tips, filament density) is a true 3D Blender render, because that's where the
organic irregularity that makes the metaphor readable actually needs to live. Anything that is
pure framing with no data dependency (canopy, above-ground branches, ground line, paper) is
SVG/CSS, because 3D buys nothing there and costs build/render time.

### Anchor points (per part, normalized to the part's own bounding box, `[0,1]×[0,1]`)

- **Trunk base:** one `originAnchor` (where domain roots attach, typically bottom-center) +
  N `attachAnchors` around it (angle in radians from vertical + radial offset), enough slots for
  up to 6 domains (current model has 4: Structure, Scheduling, Time, Facility — 6 gives headroom
  without a schema change if a domain is added).
- **Root main-segment:** `startAnchor` (x,y,width,tangent-angle) + `endAnchor` (x,y,width,tangent-angle).
  Width at each end is baked into the render (a segment is pre-tapered, not scaled non-uniformly
  at runtime — non-uniform scale on a tapered tube reads as stretched, not tapered).
- **Root fork (2-way/3-way):** one `inAnchor` (where the incoming segment attaches) + 2 or 3
  `outAnchors`, each with angle-from-parent + width.
- **Root taper-tip:** one `inAnchor` only (attaches to any segment's or fork's out-anchor,
  matching width).
- **Filament cluster texture:** no anchors — it is placed as a full-bleed background layer
  clipped to the root-system bounding region, not attached to individual segments.
- **Canopy puff / branch segment / ground strip:** SVG viewBox coordinates suffice; no
  cross-medium anchor system needed since these compose in the same DOM/SVG layer as the
  interactive nodes (see §3, §4).

### Orientation rules

- Root segments/forks/tips are rendered **top-down in Blender's local space** (trunk-relative
  "down" = local +Y) and rotated at composition time to match the placement angle computed by
  `composeRootMap` (§3) — never re-rendered per angle. One render per curvature/taper variant,
  arbitrary rotation applied as a 2D image transform when compositing.
- No part is ever mirrored/flipped for a "canonical" domain identity — angle and instance
  selection alone produce enough variety (6 curvature variants × 3 lengths × several fork
  angle options is already >30 combinations per domain root, well above what 4 domains need to
  avoid visible repetition; see §6 risk on filament variant count for the tighter case).

## 2. Output format & conventions

- **Format:** transparent PNG for every Blender-rendered part (trunk, segments, forks, tips,
  filament-density bands, ink-grain overlay). PNG over SVG for the Blender outputs because these
  are raster renders (lighting/shading baked in) — vectorizing a Blender render is unnecessary
  work and papers over the reason 3D was chosen for these parts (organic irregularity that's
  cheap to author as geometry, expensive to hand-draw as vector).
- **Resolution:** each part rendered at **2x the largest size it will ever display at in the
  composed illustration**, so it stays crisp on retina without shipping true print-resolution
  files. Concretely: root segments at their "long" size step display at roughly 220px on screen
  in the mockup's canvas → render at 440px along the long axis, transparent padding trimmed to a
  tight bounding box (no fixed-canvas waste per file).
- **Padding:** none baked into the PNG itself beyond alpha edge anti-aliasing (2px minimum
  transparent margin to avoid hard-edge clipping on rotation); anchor coordinates are relative to
  the trimmed bounding box, not a padded canvas, so the manifest's normalized anchors stay
  meaningful regardless of trim.
- **Sprite sheet vs. individual files:** **individual files**, not a sprite sheet. Reasoning:
  part count is small (≈25–30 total PNGs across all variants — see §1 variant counts), a sprite
  sheet's main win (fewer HTTP requests) doesn't apply to a bundled Electron app reading from
  local disk, and individual files keep the manifest's `src` field a plain relative path instead
  of sprite-sheet UV coordinates, which is one less thing Maker has to get right.
- **Manifest JSON** — one `manifest.json` alongside the assets, read by app code at runtime (or
  bundled statically at build time if the composition function is pure and manifest-shape is
  frozen — Maker's call in Phase 3, not gated here). Shape:

```json
{
  "version": 1,
  "parts": [
    {
      "id": "root-segment-curve-b-taper-2-long",
      "kind": "root-segment",
      "src": "root-segment-curve-b-taper-2-long.png",
      "intrinsicSize": { "width": 96, "height": 440 },
      "anchors": {
        "start": { "x": 0.5, "y": 1.0, "width": 0.18, "tangentDeg": 0 },
        "end": { "x": 0.42, "y": 0.0, "width": 0.06, "tangentDeg": -12 }
      },
      "variantGroup": "root-segment",
      "lengthStep": "long",
      "curvatureVariant": "b",
      "taperProfile": 2
    }
  ]
}
```

  - `id`: stable, human-legible, encodes variant identity (never a bare index — index-based ids
    break silently if a variant is added/removed).
  - `kind`: one of `trunk`, `root-segment`, `fork-2`, `fork-3`, `taper-tip`, `filament-density`,
    `ink-grain`. Matches the parts table above 1:1.
  - `anchors`: normalized `[0,1]` within `intrinsicSize`, per the anchor spec in §1.
  - Selection-relevant fields (`lengthStep`, `curvatureVariant`, etc.) are flat, not nested, so
    `composeRootMap` can filter with plain predicate functions, not a variant-taxonomy parser.

- **Naming scheme:** `<kind>-<distinguishing-variant-tokens>-<size-step-if-any>.png`, all
  lowercase, hyphen-separated, matching the manifest `id` exactly (filename IS the id + `.png`) —
  one source of truth, no separate lookup table to keep in sync.
- **Palette baked into renders:** Shoresh warm root browns, per the owner's mockup, NOT the
  app's navy: primary root brown `#6B5237`, deep-shadow root brown `#5C4632`, paper ground
  `#F4F1EA`. These are baked into the Blender material/render — the PNGs come out pre-colored,
  not tinted at runtime. State color (understood vs. needs-attention) is the one exception: **it
  is never baked**. A root segment PNG is always neutral brown; the needs-attention highlight is
  drawn by code as a thin colored overlay/stroke keyed to the app's existing `--danger` /
  `--secondary` tokens (same tokens `ReconstructionMoment.jsx`'s `DomainRow` already uses), so
  state color stays themeable and matches the rest of the app instead of drifting into a second
  hardcoded palette. This mirrors the "interactive layer separate from beauty layer" constraint
  in §3.
- **Where assets live / how they ship:** `src/assets/rootmap/` (parts PNGs + `manifest.json`),
  imported the same way other static assets already are. **Do not repeat the packaged-`src/`-
  bundling gotcha** (`legacy` note: packaged app crashed at launch because `electron/ops/ingest.js`
  imports `src/ingest/*` but `build.files` didn't ship `src/`, fixed by adding `src/**/*` to
  `package.json`'s `build.files`) — confirm at Phase 3 build time that `src/**/*` (already fixed
  broadly) covers `src/assets/rootmap/**` too; if assets ever move outside `src/`, `build.files`
  needs its own explicit entry. This is a build-config check, not a design decision, but it is
  exactly the kind of thing that silently breaks only the packaged build and not `npm run
  electron:dev`, so it belongs in Maker's brief as a required manual check, not an assumption.

## 3. Data → geometry composition contract

### The seam

```js
// src/ingest/rootMapComposition.js  (proposed location — mirrors reconciliationReport.js's
// sibling placement in src/ingest/, since input is that module's output)

/**
 * Pure function. No IPC, no DOM, no Blender, no randomness beyond the seeded PRNG.
 * @param {ReconciliationReport} model - output of buildReconciliationReport()
 * @param {{ width: number, height: number, seed: number }} options
 * @returns {{ placements: Placement[], canopySize: 'sparse'|'medium'|'rich' }}
 */
export function composeRootMap(model, { width, height, seed }) { ... }

// Placement shape (one per rendered instance, decorative or interactive):
// {
//   partId: string,       // references manifest part id
//   x: number, y: number, // px, in the (width,height) canvas
//   scale: number,
//   rotationDeg: number,
//   domain: string | null,     // e.g. 'Structure'; null for decorative-only placements
//   interactive: boolean,      // true only for the trunk-to-domain root-tip nodes a director can click
//   state: 'understood' | 'attention' | null,  // null for decorative parts
// }
```

- **Reuses `domainRollup.js`'s `DOMAINS` and `computeDomainCounts`** — no second domain
  vocabulary. `composeRootMap` calls `computeDomainCounts(model.decisions, isResolved)` (or
  receives the already-computed counts, Maker's call) exactly as the reconstruction moment does,
  so the root map and the reconstruction moment (if both ship) can never disagree about which
  domains are settled.
- **Trunk position:** fixed at `(width * 0.5, height * 0.62)` (surface line at `height * 0.55`,
  matching the mockup's canopy-above/roots-below split) — a constant, not data-derived.
- **Domain → main root mapping:** one root-segment chain per entry in `DOMAINS` (currently 4:
  Structure, Scheduling, Time, Facility). Angle spread is **evenly distributed** across a fixed
  downward arc (e.g. −70° to +70° from straight down, 4 domains → roughly −52°, −17°, +17°, +52°,
  order fixed by `DOMAINS` array order so a given domain always renders at the same angle across
  runs — stability matters more than "natural" irregular spacing here, since a director may
  return to the same camp's illustration across sessions and a domain jumping position would
  read as a bug). `variantGroup: 'root-segment'` variant is chosen via the seeded PRNG (`seed`
  input, same DJB2 + Mulberry32 pattern `buildSchedule.js` already uses — reuse, not reinvent)
  keyed on `domain name + seed`, so the SAME camp+seed always picks the same curvature/taper
  combination (deterministic, stable across re-renders of the same report).
- **Length/width step from data:** `lengthStep` = `short` if that domain's decision count is 0,
  `medium` if 1–3, `long` if 4+ (thresholds are a Phase-3 tuning knob, not fixed by this spec —
  flag as open question in §6 whether these buckets match the reconstruction moment's existing
  bucketing, if any, for visual consistency).
- **Children → sub-branches:** each domain's entities (from `DOMAIN_OF`'s reverse mapping —
  e.g. Structure → cohorts, tiers, groups) map to fork children. 2 children → `fork-2`, 3+
  children → `fork-3` (chained if a domain ever has 4+, which none currently do — document as a
  fallback, not a designed-for case). Each child branch's own length step follows the same
  0/1–3/4+ per-entity decision-count bucketing as its parent, recursively, one level deep only
  (no further sub-forking below entities — matches the flat entity list in `DOMAIN_OF`).
- **Filament cluster placement (decorative density):** the ONE non-data-parameterized decorative
  element. `composeRootMap` picks a single density band (`sparse`/`medium`/`dense`) from
  **total fact/decision count** (a coarse richness signal, not per-domain), placed once as a
  full-bleed background layer under the root segments, not scattered per-segment. Seeded only
  in the sense that the density band choice is deterministic for a given report; no per-instance
  seeding needed since it's one texture, not N placements.
- **Canopy composition:** likewise decorative-only, sized by the same total-richness signal
  (`canopySize` in the return value), composed from the SVG canopy puffs — this part of
  `composeRootMap`'s output feeds the SVG/CSS layer (§4), not the Blender-PNG placement list.

### Interactive vs. decorative

`placements[].interactive` is `true` only for the **domain root-tip nodes** (where a director
would click to jump to that domain's decisions — mirroring what the reconstruction moment's
`DomainRow` already does as a list). Everything else (segments, forks, tips that aren't a
domain's terminal node, filament texture, canopy, branches, ground) is `interactive: false`.
This is the hard boundary the task requires: **the beauty layer (raster PNGs + SVG framing) and
the interactive layer (hit-testable nodes) are composed independently.** Concretely: the beauty
layer renders as `<img>`/background-image elements positioned by `placements`; the interactive
layer renders as a thin absolutely-positioned SVG/DOM overlay with hit targets at the same
`(x,y)` coordinates `composeRootMap` already computed for `interactive: true` placements —
reusing the coordinates, never re-deriving them, so the two layers cannot drift apart. Either
layer can be reworked (swap the beauty layer for a different render style; restyle the click
targets) without touching the other, satisfying the constraint stated in the task.

## 4. Performance & scale budget

The prior SVG prototype's lag came from an `feDisplacement` filter evaluated across many live
paths. This kit avoids that class of problem structurally, not by tuning the same approach:

- **Max composed-canvas DOM/img nodes:** target **≤40 image elements** per illustration
  (trunk: 1, root segments: ~4 domains × up to 2 hops ≈ 8–12, forks: ~4–8, tips: ~8–12, filament
  texture: 1 single background image, ink-grain overlay: 1). This is an order of magnitude below
  the SVG prototype's per-path count because the filament density — the part that scales with
  "many small elements" — is ONE baked texture, not N scattered filament objects.
  **This is the single load-bearing decision for performance:** density is baked at render time
  into 3 fixed PNG variants (sparse/medium/dense), never generated at runtime as individual
  filament instances. Composition-time cost for that layer is one `<img>` placement, full stop,
  regardless of how visually dense the texture itself is.
- **No runtime filters.** No `feDisplacement`, no runtime blur/distort on the composed image.
  Any organic irregularity (the thing `feDisplacement` was reaching for) is already baked into
  the Blender renders' geometry — that's the entire point of moving beauty into pre-rendered
  parts. The ink-grain overlay is a single static multiply-blend image, not a filter graph.
- **Interactive overlay stays light:** the hit-testable layer (§3) is plain SVG circles/regions
  at domain-tip coordinates — no more than `DOMAINS.length` (currently 4, headroom to 6 per §1)
  interactive elements, well within normal DOM cost.
- **Composition cost is one-time per report, not per-frame:** `composeRootMap` runs once when
  the reconciliation report changes (same trigger as `buildReconciliationReport` itself), not on
  every render — Maker should memoize on report identity/hash, mirroring how `ReconciliationScreen`
  already treats `buildReconciliationReport`'s output as derived-once state.

## 5. Reduced-motion / static-first

The composition is a **static illustration**, full stop — no per-part animation, no growth
sequence, no per-frame Blender output. This directly avoids repeating the reverted botanical
Canvas sequence's mistake (see Context). The ENTIRE motion budget for this feature, wherever it
lands, is: **one reveal fade-in of the fully-composed static image**, using the app's existing
motion primitives (`importCardIn` / `--ease-out` / `--motion-settle`, the same tokens
`ReconstructionMoment.jsx` already uses) — not a new easing curve or duration invented for this
feature.

- **DESIGN_STANDARD §5 (motion/feedback):** satisfied by the single fade — the composed image
  IS the feedback (director sees settled vs. attention roots the instant it's visible), no
  additional per-element feedback choreography needed or wanted.
- **DESIGN_STANDARD §8 (transitions) + reduced motion:** the app's existing global rule (already
  in `src/index.css`, per `ReconstructionMoment.jsx`'s own comment) strips any inline
  `animation: importCardIn ...` style under reduced-motion preference — this feature inherits
  that for free by reusing the same primitive rather than defining a bespoke one. Reduced motion
  means "image appears without the fade," never "image doesn't appear" — satisfied automatically
  since the strip only removes the animation property, not the element.
- Because there are no animation frames, **the parts kit needs no motion variants of any part** —
  every render is a single static frame. This keeps the total asset count to the table in §1,
  with no ×N multiplier for frame count anywhere in the budget.

## 6. Risks / open questions for Governor/owner

1. **Filament variant count before it reads repetitive.** §1 specifies 3 fixed density bands as
   single baked textures — deliberately NOT many small tileable filament sprites, to protect the
   performance budget in §4. Risk: a single baked texture per density band may read as visibly
   "the same texture" if a director compares two camps side by side (unlikely usage pattern, but
   possible). Mitigation if it proves visible: 2–3 texture variants PER density band (still O(6-9)
   total files, still one placement each) rather than reintroducing per-instance scattering.
   Needs a look at real rendered output before locking at 3 vs. 6-9.
2. **Canopy medium: Blender vs. SVG is decided here as SVG (§1), but this is a reversal-risk
   call.** If the canopy's engraving look can't be convincingly reached in flat SVG/CSS (the
   mockup's canopy has visible hand-drawn irregularity that CSS gradients/shapes may not match),
   the fallback is a small number of Blender-rendered canopy-puff PNGs (same treatment as root
   segments: 3-4 variants, composed the same way). This spec recommends trying SVG first because
   it's cheaper to build and iterate, and the canopy is explicitly non-data-bearing so getting it
   "good enough" is a legitimate bar — but Governor should confirm this tradeoff is acceptable
   rather than assume the SVG attempt will succeed.
3. **Asset total size budget for the packaged app / retina (1x vs 2x).** §2 commits to
   rendering each part at 2x display size (no separate 1x/2x file pair) — simpler pipeline, one
   file per variant, since Electron apps aren't bandwidth-constrained the way a web page is.
   Estimated total: ~25-30 PNGs × roughly 20-60KB each at trimmed 2x resolution ≈ under 2MB total
   for the whole kit — small relative to the app, but this is an estimate, not a measured number;
   Governor should treat the actual figure as a Phase-3 verification item (measure after first
   real Blender export), not assume this spec's estimate holds.
4. **Placement decision is out of scope here and load-bearing for the rest of the ADR.** This
   spec is placement-agnostic by design (per Summary), but the composition contract in §3
   (trunk position, canopy-above/roots-below split at `height * 0.55`) assumes a wide-aspect
   illustration space, which fits a full ReconciliationScreen panel far more naturally than the
   reconstruction moment's existing compact canvas. Governor needs to settle where this renders
   before Maker can pick concrete `width`/`height` — this spec's numbers are placeholders
   consistent with the existing prototypes, not a commitment.
