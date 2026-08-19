---
title: "Reconciliation root-map screen — production port (static illustration + data-bound SVG)"
document_type: adr
status: accepted
authority: normative
implementation_state: not_started
date: 2026-08-18
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
amends: docs/adr/2026-08-18-reconciliation-rootmap-screen.md
related_specs:
  - docs/work/specs/2026-08-18-rootmap-interaction-model.md
  - docs/work/specs/2026-08-18-rootmap-asset-kit.md
  - docs/work/specs/2026-08-18-rootmap-composited.html
archive_when: the root-map screen ships and this is folded into PLATFORM_STATE
---

# Reconciliation root-map screen — production port

## Decision

Port the owner-approved functional prototype (`scratchpad/blender/build_composition4.py` →
`docs/work/specs/2026-08-18-rootmap-composited.html`) into the real app as the primary presentation
of `ReconciliationScreen`. Five domain nodes (Structure, Scheduling, Time, Resources, Context) with
child nodes sit on a single static root illustration; clicking a node populates the existing
attention-panel/decision-card machinery in place. No navigation, no new screen route.

**This amends `2026-08-18-reconciliation-rootmap-screen.md`'s Architecture section.** That ADR
specified a hybrid render: a Blender parametric parts-kit composited by a pure
`composeRootMap(model, {width,height,seed})` function, with `filament clusters baked as texture
bands`. The owner-approved prototype that actually shipped uses **one flattened, pre-cut static PNG**
(`scratchpad/roots-art/root_illustration_cut.png`, background already keyed transparent) with no
parts-kit compositing. The parts-kit/Blender-manifest architecture is **retired, not built** — it was
a plan for producing the beauty layer, superseded by simply generating one finished image. Everything
else in that ADR (skeleton = code-drawn interactive nodes, beauty = static/decorative, four-state
token vocabulary, motion budget) still holds and is not re-litigated here.

## Candidate approaches considered

Closed case — the visual design and asset are already resolved and owner-approved (five prior visual
attempts were tried and rejected before this one; see the amended ADR's "Why" section). The only
remaining decisions are the port mechanics: where the pure data-mapping function lives, how it
reconciles with `ReconciliationScreen`'s existing filter/lane state, and how the 5-domain vocabulary
gap is closed. These are structural but not choices between genuinely different UI directions, so
`adhd` divergence was not re-run; the divergence already happened in the prototyping phase this ADR
inherits.

## Approach

### 1. Component structure

`RootMap` **replaces** `ReconciliationScreen`'s current top scaffolding — the domain filter-chip row
and the two-column hold/standard card list (`src/screens/ReconciliationScreen.jsx` lines ~459–511) —
with the illustration + node SVG + right-side attention panel. It does **not** become a separate
screen/route; `ReconciliationScreen` keeps owning all state (`report`, `answers`, `dismissedGaps`,
`expandedEvidence`, the tray/commit bar) exactly as today. Only the *rendering* of "which decisions am
I looking at right now" changes.

New files:
- `src/components/reconciliation/RootMap.jsx` — presentational. Props: `domains` (node model, see
  below), `selection`, `onSelectTile`, `onSelectNode`, `onClearSelection`. Renders the `<img>`
  backdrop, the SVG node layer (real `<button>`/focusable elements per the interaction spec — SVG
  `<a>`/`<circle>` wrapped in `<foreignObject><button>` is the simplest way to get real button
  semantics at the coordinates the prototype's `<g class="node">` occupies), and the four summary
  tiles. Owns zero business logic — it is a controlled component driven entirely by props, matching
  the prototype's `render()` but with React state instead of module-level `sel`/`filter` globals.
- `src/components/reconciliation/RootMapPanel.jsx` — thin adapter that takes the current `selection`
  plus the screen's existing `lanes`/`answers`/`dismissedGaps` and renders using the **existing**
  `DecisionCard`/`RequiredGapCard`/`RequiredGapSummaryCard` components already defined in
  `ReconciliationScreen.jsx` (lines ~562+) — extract those three components out of
  `ReconciliationScreen.jsx` into this file (or a shared `reconciliationCards.jsx`) so both the old
  and new render paths, and any future consumer, call the same card renderer. **Do not reimplement
  card rendering inside the panel** — the panel's only job is computing which decisions are in scope
  for the current selection and handing them to the unchanged card components.
- `src/ingest/rootMapModel.js` — pure module, see §2.
- `src/components/reconciliation/rootMapLayout.js` — pure constant, see §2 coordinate handling.

### 2. Data binding — the pure module

```
buildRootMapModel(report, { answers, dismissedGaps }) -> {
  domains: [{
    key, label, state /* 'understood'|'attention'|'changed'|'absent' */, x, y,
    children: [{ key, name, count, state, x, y, decisionIds: string[] }]
  }]
}
```

Lives in `src/ingest/rootMapModel.js`, pure (no IO/DOM/random), unit-testable against a real
`buildReconciliationReport` output. It **reuses**, not reimplements:
- `DOMAINS`, `domainOf`, `computeDomainCounts` from `src/components/reconciliation/domainRollup.js`
  for domain membership and the understood-vs-attention binary that domain already computes.
- `reportToLanes(report)` for the actual decision list (`hold`/`standard`) — the same list the
  existing screen renders, so the root map and the card list can never show different items.
- `isDecisionResolvedFor(decision, answers, dismissedGaps)` from `reconciliationTriage.js` for
  resolved/unresolved status.

**Node-state fidelity gap (important, not a v1 blocker but must be documented, not silently
fudged):** `buildReconciliationReport` does not attach a per-decision `outcome` — `classifyItem`'s
`outcome` (`understood`/`needsAttention`/`changed`) is folded into the aggregate `buckets` counter and
then discarded; only `needsAttention` and `changed` items ever produce a `decision` object.
Consequently:
- A domain/child node with ≥1 unresolved decision → `state: 'attention'`, unless every decision under
  it has `confidence === 'changed'`/is a `confirm_change` from a fixed-event move, in which case
  → `state: 'changed'` (mixed unresolved sets bias toward `attention`, since that is the
  action-required state and must not be masked by a `changed` label).
- A domain/child with decisions that are all resolved, or with zero decisions at all → `state:
  'understood'`. This is deliberately the **same binary** `computeDomainCounts` already uses
  (`count > 0` → attention else understood) — the model does not invent new per-child granularity the
  underlying report cannot honestly support.
- `state: 'absent'` ("not in source") is only assigned where the model has **positive** evidence of
  absence, not merely zero decisions (zero decisions defaults to `understood`, per above — a healthy
  domain with nothing to flag must not read as "nothing was imported"). Today that positive evidence
  exists in exactly one place: the `Context` domain (§3) and required-readiness rows whose `state ===
  'optional'` (counted in `buckets.notInSource` but currently un-attributed to a specific entity).
  **v1 scope**: only `Context` renders `absent`; other domains/children never do, even when their real
  entity family is empty, because the report has no per-entity absence signal to attribute it to
  without new plumbing. This is a smaller state space than the prototype (which hand-assigned
  `absent` to specific children like "Availability") — flagged explicitly in §7 as a known reduction,
  not an oversight, and the fix (attributing `buckets.notInSource` back to specific readiness
  rows/entities) is a follow-up, not part of this port.
- `count` on a child node is `decisionIds.length` (unresolved + resolved decisions currently
  attributed to it), matching the prototype's numeral display.

Child-to-decision attribution: `domainOf(decision)` already resolves a decision to one of the four
existing domain keys via `decision.entity` (or `decision.screen` for `required_gap`). There is **no
existing per-child (sub-domain) mapping** — `domainOf` stops at the domain, not e.g. "Units" vs.
"Groups" within Structure. `rootMapModel.js` adds a second, small lookup, `CHILD_OF`, keyed the same
way as `DOMAIN_OF` (by `decision.entity`, or `decision.screen` for `required_gap`), living in
`domainRollup.js` alongside `DOMAIN_OF` (same module, same reuse discipline — one entity→taxonomy
table, not two files drifting). Example: `cohorts → 'Units'`, `groups → 'Groups'`, `activities →
'Activities'`, `locations → 'Locations'`. A decision whose entity has no `CHILD_OF` entry falls back
to a domain-level `'General'` pseudo-child bucket (still counted, still clickable, never silently
dropped) rather than being excluded — matching the "surface every write failure"/"never silently
drop" discipline already in force elsewhere in this codebase.

### 3. The fifth domain — Context

`domainRollup.js`'s `DOMAINS` becomes `['Structure', 'Scheduling', 'Time', 'Facility', 'Context']`
(five entries). `DOMAIN_OF` and `REQUIRED_GAP_DOMAIN` gain **no new keys** for `Context` — no
ingested entity maps to it today, by design, so `computeDomainCounts` and the new `rootMapModel`
correctly return `0` decisions for it with zero code branching (an unmapped entity already can't
match `domainOf(d) === 'Context'`). This is the mechanism that makes `Context` organically render
`state: 'absent'` — it is not a special-cased boolean, it falls out of the existing domain-membership
logic having nothing to attribute.

**Keep the internal key `'Facility'`, not `'Resources'`.** The task brief's "Resources ≈ Facility"
is a *label* correspondence, not a rename. `DOMAIN_OF`, filter-chip code, and existing tests
(`slotCellConstants`-adjacent domain tests, if any reference `'Facility'` by string) all key on
`'Facility'` today; renaming the canonical key to `'Resources'` is a larger, riskier find-and-replace
for zero behavioral gain. Add a **presentation-only** label map,
`DOMAIN_LABELS = { Structure: 'Structure', Scheduling: 'Scheduling', Time: 'Time', Facility:
'Resources', Context: 'Context' }`, in `domainRollup.js`, used only by `RootMap`'s tile/node captions.
Every other consumer of `DOMAINS`/`DOMAIN_OF` (existing chip filter, any tests) is unaffected — this
is additive.

Widening `DOMAINS` from four to five is a **shared-vocabulary change** — `computeDomainCounts` and
the existing filter-chip row (`ReconciliationScreen.jsx` line ~459 `DOMAINS.map(...)`) will render a
fifth always-zero "Context" chip once this lands, even before `RootMap` replaces that row. That's
harmless (an always-zero filter chip is not a defect) but should be called out to Maker so it isn't
mistaken for a bug mid-implementation, and ideally the `RootMap` swap (§5) lands in the same
change/commit as the `DOMAINS` widening so the old chip row never actually ships showing it.

### 4. The asset

`scratchpad/roots-art/root_illustration_cut.png` moves to `src/assets/reconciliation/root-map.png`
(scratchpad is not shipped; `src/` is). Imported the standard Vite way:
`import rootMapArt from '../../assets/reconciliation/root-map.png'` → `<img src={rootMapArt} />`.
There is no prior precedent for a raster asset import under `src/` in this codebase (grep found none)
— this is a new but unremarkable Vite pattern, not a new build-system dependency.

**Packaged-build bundling gotcha, checked and closed for this asset**: `package.json`'s
`build.files` already includes `"src/**/*"` (see the prior incident,
`docs/adr/...packaged-src-bundling` / reference memory `packaged_src_bundling`, which was about
`electron/ops/ingest.js` importing from `src/` without `src/**/*` being shipped). Because Vite's
production build inlines/hashes the imported PNG into `dist/assets/` at build time and
`build.files` already includes `"dist/**/*"`, the packaged app gets the asset through the normal
`npm run build` → `electron-builder` pipeline with **no config change needed**. This is worth stating
explicitly in the ADR precisely because the prior incident makes it the first thing a reviewer will
worry about — verify it anyway with a `npm run electron:build` smoke check per the Verifier gate
before calling this shipped, since the prior incident's root cause was exactly "looked fine in dev,
broke packaged."

### 5. Interaction wiring

Directly implements `docs/work/specs/2026-08-18-rootmap-interaction-model.md`, §1–§6, verbatim —
that spec is binding, not a suggestion this ADR softens. Concretely:

- **Selection state** in `ReconciliationScreen` becomes one union, replacing the current
  `activeFilters: Set<domain>` (multi-select, additive chips) entirely:
  `selection: { type: 'none' } | { type: 'tile', state } | { type: 'node', domainKey, childKey? }`.
  This is a **behavior change** from today's chip row (multi-select across domains) to the spec's
  single-select tile/node model — intentional, since the spec's interaction model (§1, "Click summary
  tiles" / "Click root nodes") is single-selection by construction ("Clicking the same tile again
  clears the filter (toggle)"; node click "replaces, not appends"). Flag this behavior change to the
  owner in review since it is a UX narrowing from the current screen, not purely additive — see Open
  Questions.
- Tile click → `selection = {type:'tile', state}` (or `'none'` if re-clicking the active tile) → dims
  non-matching nodes via `opacity` only (per spec's forbidden-properties list) → panel shows all
  decisions in that state across domains.
- Node click (domain trunk or child) → `selection = {type:'node', domainKey, childKey}` → panel
  replaces with that node's `decisionIds` resolved to real decisions via `lanes.hold`/`lanes.standard`
  lookup by id → node gets the selected-ring visual; **no dimming** of other nodes (spec: node
  selection never dims, only tile selection dims).
- "Show all" → `selection = {type:'none'}`, panel reverts to the existing default (needs-attention
  queue), matching current `ReconciliationScreen` behavior when no chip is active.
- Hover → local component state in `RootMap.jsx`, never touches `ReconciliationScreen`'s selection —
  purely a CSS ring/wash + 300ms-delayed tooltip, exactly per spec §1/§4. No prop round-trip needed.
- Keyboard/ARIA/hit-targets/reduced-motion: implemented exactly per spec §1 (tab order), §5
  (`aria-label`, `aria-pressed`, 44×44 hit circles, focus ring reuse), §4's reduced-motion table.
  `RootMap.jsx` must use `prefersReducedMotion()` (already imported elsewhere via `../styles/shared`)
  rather than inventing a second reduced-motion check.
- Resolving an item inside the panel already updates `answers`/`dismissedGaps` in
  `ReconciliationScreen` (existing `stage`/dismiss handlers, unchanged) — because `rootMapModel` is
  recomputed from those same pieces of state on every render, node recoloring and tile-count updates
  happen "for free" the next render, no new event wiring required (matches spec §3's "live, in-place"
  requirement without new plumbing).

### 6. Relationship to the current ReconciliationScreen — the integration risk

**RootMap replaces the screen's top visual scaffolding; it does not replace the screen, its state, or
its commit tray.** Concretely, in `ReconciliationScreen.jsx`:
- **Removed**: the domain filter-chip row (~L459–469) and the two-column
  `visibleHold`/`visibleStandard` card list (~L471–511) as *directly rendered JSX* — their logic
  moves into `RootMap`/`RootMapPanel` via `rootMapModel`, `selection`, and the extracted card
  components.
- **Unchanged**: the header/progress bar above it, the understood/not-in-source disclosure rows, and
  the tray/commit bar below it (~L516+) — none of that is part of the roots metaphor per the
  interaction spec ("canopy … reached only via the screen's own separate navigation"; the tray is the
  commit action, not an explainer).
- `activeFilters` (a `Set`) is deleted; `selection` (the union above) replaces it. Every place that
  reads `activeFilters.has(domain)` today must be re-derived from `selection`.

**The single biggest integration risk**: the existing screen already has a working, shipped
attention-surfacing model (chips are ADDITIVE multi-select across domains; nodes/tiles per the new
spec are REPLACING single-select across a different axis — state, not domain, for tiles; a specific
node, not a domain set, for node clicks). These are three distinct selection semantics being
collapsed into one `selection` union and rewired through `visibleHold`/`visibleStandard`-equivalent
predicates. Getting this wrong reads as a working screen with subtly incorrect filtering (e.g. a
lingering multi-domain filter bug, or a tile click that doesn't dim per spec, or a node click that
accidentally also dims like a tile does) rather than an obvious crash — this is exactly the kind of
seam that needs a test-first characterization pass (§7) before the visual swap, not just eyeballing
against the prototype.

### 7. Test seams

- `src/ingest/rootMapModel.test.js`: pure, unit-tested against real `buildReconciliationReport`
  fixtures already used by `reconciliationReport.test.js`/`reportToLanes.test.js` if they exist (reuse
  fixtures, don't invent new ones). Assert: five domains always present; `Context` always `absent`
  with zero children carrying decisions; a domain with only resolved decisions → `understood`; a
  domain with an unresolved `confirm_change`-only set → `changed`; a mixed unresolved set → `attention`
  (never masked by `changed`); `CHILD_OF` fallback to `'General'` for an unmapped entity never throws
  and never drops a decision (grep the child-count sum against `report.decisions.length` to prove
  nothing is silently lost).
- `src/components/reconciliation/rootMapLayout.test.js`: coordinates are config, not logic — assert
  shape only (every domain in `DOMAINS` has an entry; every entry's `x`/`y` are within `[0,1]`; the
  auto-layout fallback for an unlisted child produces a deterministic, non-overlapping-enough position
  given a fixed input order) — do not assert exact pixel placement, that is Designer/Tester's visual
  judgment call, not a unit-test concern.
- Selection-state reducer logic in `ReconciliationScreen.jsx` (tile toggle, node select, show-all) is
  small enough to characterize with existing RTL screen tests rather than a separate pure module —
  no new pure module proposed for it, per karpathy (don't extract a seam that isn't reused elsewhere).

### 8. Coordinate config

`rootMapLayout.js` exports `NODE_LAYOUT: Record<domainKey, { x, y, children: Record<childKey, {x,y}>
}>`, copied from the prototype's hand-placed `DOMAINS[].x/y`/`kids[].x/y` values verbatim as the
starting point (owner has already visually approved that placement in the prototype). A child key
present in `CHILD_OF`'s value set but absent from `NODE_LAYOUT`'s children (e.g. a newly added entity
mapping) falls back to an evenly-spaced position along a short arc below its parent domain node,
computed deterministically from the child's index in a fixed sort of `CHILD_OF`'s keys — no PRNG
needed (unlike the schedule engine's seeded layout, there's no "many equally-valid placements" problem
here, just "don't crash and don't overlap the parent exactly").

## Files/modules affected

New:
- `src/assets/reconciliation/root-map.png` (moved from scratchpad)
- `src/ingest/rootMapModel.js` (pure) + `rootMapModel.test.js`
- `src/components/reconciliation/rootMapLayout.js` (pure config) + `.test.js`
- `src/components/reconciliation/RootMap.jsx`
- `src/components/reconciliation/RootMapPanel.jsx`
- `src/components/reconciliation/reconciliationCards.jsx` (extracted `DecisionCard`,
  `RequiredGapCard`, `RequiredGapSummaryCard` out of `ReconciliationScreen.jsx`)

Changed:
- `src/components/reconciliation/domainRollup.js` — `DOMAINS` gains `'Context'`; new `CHILD_OF` map;
  new `DOMAIN_LABELS` presentation map.
- `src/screens/ReconciliationScreen.jsx` — removes chip row + two-column card list JSX; removes
  `activeFilters` state; adds `selection` state; renders `RootMap` + `RootMapPanel`; imports the
  extracted card components instead of defining them inline.

Unchanged (reused as-is): `reconciliationReport.js`, `reportToLanes.js`, `reconciliationTriage.js`,
`reconciliationResolutions.js`, the tray/commit bar, `computeDomainCounts`, `domainOf`.

## Reused vs. new

Reused: the entire decision/triage/resolution pipeline, `reportToLanes`, `domainOf`/
`computeDomainCounts`, the three existing card components (relocated, not rewritten), the
`prefersReducedMotion`/motion-token pattern already established in this screen, `build.files`'s
existing `src/**/*` bundling coverage.

New: `rootMapModel.js` (the report→node-model projection — genuinely new, nothing in the codebase
today attributes decisions to a sub-domain child), `rootMapLayout.js` (coordinate config, new because
the metaphor is new), `RootMap`/`RootMapPanel` (new presentational components), `CHILD_OF`/
`DOMAIN_LABELS` (small additive extensions to the existing domain-vocabulary module, not a parallel
vocabulary).

## ADR required: yes

Filed at `docs/adr/2026-08-18-rootmap-screen-port.md`. Decision: (1) retires the prior ADR's
Blender-parts-kit compositing architecture in favor of one static illustration, since that is what
was actually prototyped and approved; (2) widens the shared `DOMAINS` vocabulary from four to five,
a contract every consumer of `domainRollup.js` depends on; (3) replaces `ReconciliationScreen`'s
`activeFilters` multi-select model with a single-selection union, a behavior change to a shipped
screen. All three meet the constitution's ADR bar (new persistent-ish shared vocabulary other code
depends on; a UX/contract change to existing behavior that isn't obviously reversible without a
second migration of caller code).

## Open questions for Governor

1. **The chip-to-tile behavior change (§5) narrows multi-domain filtering to single-state filtering.**
   This is dictated by the already-accepted interaction spec, not a new proposal — but it is a real
   behavior regression risk for anyone who uses today's multi-domain chip filter. Confirm the owner
   has accepted this narrowing (the interaction spec was written and reviewed against the metaphor,
   but may not have been checked against the *current* screen's chip usage patterns specifically).
2. **`CHILD_OF`'s exact mapping** (which entity → which named child, e.g. does `anchor_activities` sit
   under "Activities" or its own "Fixed Events" child, matching the prototype's `kids` naming) needs a
   pass against the prototype's literal `DOMAINS[].kids[].n` strings before Maker starts — this ADR
   specifies the *mechanism* (a lookup table, additive to `domainRollup.js`) but the exact key-by-key
   mapping is copy/data work, not architecture, and should be finalized by whoever also owns §6's copy
   review.
3. **Extracting the three card components** (§1, `reconciliationCards.jsx`) touches
   `ReconciliationScreen.jsx` more than a pure additive change would — confirm this refactor-alongside
   is acceptable scope for this ticket rather than a separate prerequisite slice, since it's small
   (move, not rewrite) but is still a file split Governor may want sequenced as its own reviewed step.
