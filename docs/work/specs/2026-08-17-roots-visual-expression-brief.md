---
title: "Roots visual expression — R9′ acceptance brief (owner clarification)"
document_type: spec
status: draft
created: 2026-08-17
archive_when: "the R9′ roots-expression phase completes, or the metaphor is dropped per §12"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
initiative: ingestion-reconciliation-one-screen
phase: R9
applies_when: "the one-screen reconciliation reaches the visual-expression / compression phase (R9′) — NOT before"
source: owner clarification 2026-08-17 ("Clarification: Roots visualization and implementation")
---

# Roots visual expression — R9′ acceptance brief

Owner clarification (2026-08-17). **Changes the VISUAL acceptance criteria for R9′ only —
nothing in the reconciliation architecture, view model, engine, schema, or completed slices.**
Do NOT act on this before R9′; do NOT restart, rebranch, or reopen decisions for it. The truthful
reconciliation state must exist first; the visualization is designed against REAL Shoresh
reconciliation data, not invented demo data — which is exactly why it comes last.

## What Roots means
Below the surface = the reconstructed underlying camp model (the roots): Structure, Scheduling
Model, Time, Facility/Resources, and other genuinely necessary domains. Above the surface = what
grows from them (schedules, programming, map, one-day schedules, electives, exports). Ingestion IS
the root-building/reconstruction experience.

## Binding constraints
1. **Not decorative branding.** Roots must correspond to ACTUAL reconciliation state — not cards
   floating on a root picture. Major roots ≈ camp-model domains, ontology drawn from the CURRENT
   domain/reconciliation model (e.g. Structure→groups/units/days; Scheduling Model→activities/
   fixed events/priorities; Time→time blocks/operating structure; Facility/Resources→locations/
   facility relationships/staffing where present). Do NOT invent categories for symmetry.
2. **Roots communicate state:** UNDERSTOOD = settled/quiet; NEEDS ATTENTION = draws the eye;
   CHANGED = understood-but-differs-from-authoritative; NOT-IN-SOURCE/OPTIONAL = faint/dormant/
   incomplete but NOT broken/errored. Determine exact treatments via prototype/design review, not
   by blind implementation.
3. **Geometry is NOT per-fact.** 374 understood facts ≠ 374 generated roots. Domains are bounded
   and stable → an intentionally ART-DIRECTED root topology whose STATE (not geometry) is driven
   by reconciliation data. More control than an auto tree-layout.
4. **NOT SVG as the foundation.** Prior SVG root attempts looked artificial/cheap/diagrammatic.
   Do NOT ship curved SVG connectors, node graphs, boxes-with-Bézier, skill-tree UI, org charts,
   or conventional tree components and call it Roots. (NOTE: the current R2′b screen's faint
   14%-tint CSS "gutter spine" is a MINIMAL PLACEHOLDER nod, kill-switched — it is NOT the Roots
   expression this brief governs; the real thing is built here at R9′.)
5. **Implementation candidates, prototype before choosing:** Canvas 2D (first procedural approach
   to try — organic tapered branches, irregular branching, subtle noise, state-driven emphasis,
   restrained animation); HYBRID art-directed imagery + Canvas + ordinary HTML for labels/controls/
   accessibility with reconciliation data driving state + mapped interaction regions (likely
   STRONGEST — separates visual quality from semantics/accessibility); pre-rendered art + dynamic
   overlay. WebGL ONLY if Canvas/hybrid genuinely can't — no Three.js/game engine/major graphics
   dep unless it earns its place.
6. **Visual character:** "editorial botanical illustration + restrained information visualization."
   NOT generic SaaS / video-game skill tree / cartoon / children's camp clip art / technical graph
   viz / flowchart / DB diagram / photorealistic tree / AI-generated decorative background. No
   leaves/dirt/worms/cartoon plants/bright botanical/excessive brown/growth gimmicks — FORM and
   BRANCHING behavior communicate roots. Shoresh design tokens (src/index.css) stay dominant; do
   NOT inherit Campify or blue/cyan SaaS styling. Inspect current tokens + recent UI-audit work
   first.
7. **Reconstruction-as-visual (optional to prototype):** the parse/reconcile moment could show the
   root system emerging (structure appears, understood domains settle, unresolved stay distinct,
   transitions into the workspace) instead of "Parsing… 63%." Subtle, reduced-motion-respecting,
   removed if gimmicky.
8. **Roots are NOT the only interaction.** No usability/accessibility trap — a director must never
   have to click a thin root to operate Shoresh. Conventional controls (labels, counts, decision
   controls, keyboard, a11y semantics, drill-down) remain fully available. (Another reason hybrid
   Canvas+HTML beats one graphics surface.)
9. **Preserve the one-screen model.** Roots is a PROJECTION/navigation over the same reconciliation
   data — not a new IA, not wizard pages. "Scheduling Model → Fixed Events" and "Needs Attention —
   4" are two projections into ONE underlying model; no duplicate state or parallel workflow.
10. **Layering (no business logic in the viz):** SOURCE → INGESTION/RECONCILIATION → RECONCILIATION
    VIEW MODEL → {Roots overview | Decision UI | Audit/detail UI}. Roots CONSUMES state, never
    determines truth — so it can change substantially in design iteration without touching
    reconciliation semantics.

## Prototype gate (R9′ — do NOT integrate into production ImportScreen first)
Prototype against ≥6 representative reconciliation states, using REAL reconciliation data:
A. Mostly understood (much reconstructed, few decisions). B. Several genuine decisions. C. Changed
existing state (source conflicts with authoritative). D. Optional info absent (e.g. staffing/
facility not in this source). E. New/empty camp (little authoritative state). F. Facility-rich camp
(locations exist, schedule evidence maps onto them).
Answer: (1) reads immediately as a root system? (2) still looks like Shoresh? (3) can the director
tell where attention is required? (4) communicates that most reconstruction succeeded? (5) metaphor
helps comprehension? (6) materially better than prior SVG experiments? (7) confusing when states
coexist? (8) gracefully represents optional/missing? (9) drill-down natural? (10) would a SIMPLER
interface be better? Use the design-audit/designer agents + repo design principles.

## The bar (§12/§15)
Ship Roots ONLY if it becomes a genuine representation of HOW COMPLETELY Shoresh understands the
camp's structure. If the prototype is decorative / confusing / visually cheap / overly literal /
hard to operate / substantially worse than a conventional compressed reconciliation UI — STOP and
report; the product idea outranks the metaphor. Target experience: "I can see the underlying
structure Shoresh reconstructed from my camp. Almost all of it is settled. I can immediately see
the few roots where it needs my knowledge. I drill in, resolve them, and watch the camp model
become complete."
