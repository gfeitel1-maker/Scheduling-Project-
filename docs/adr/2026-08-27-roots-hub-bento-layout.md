---
title: "Roots hub — Bento layout for the census/domain map (augment, not replace)"
document_type: adr
status: accepted
authority: normative
implementation_state: planned
date: 2026-08-27
approved: 2026-08-27 (owner ruled: augment above the list; stay inside locked tokens; no explainers)
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-26-roots-subscreens-redundancy-program.md
refines: [docs/adr/2026-08-22-roots-as-hub-setup-ia.md]
---

# Roots hub — Bento layout for the census/domain map

## Status

Accepted. **Refines** `docs/adr/2026-08-22-roots-as-hub-setup-ia.md` (does not supersede it). That ADR's clause 1 already commits to refining the Roots dashboard **in place** around "the existing census"; this ADR records the specific layout refinement. Its clause 2 (per-entity screens kept as a collapsible sidebar list) is **unchanged** — this ADR does not touch the sidebar.

## Context

The Roots hub (`ReconciliationScreen` inspect mode → `RootMap`) renders a census filter row (Understood / Needs attention / Changed / Not in source) above a **single vertical stack** of domain cards (Structure, Scheduling, Time, Facility), each holding its entity chips. On a normal-width window the vertical stack leaves the right half of the screen empty, and the domain that needs the director's attention has no more visual weight than a fully-rooted one — the hub describes state but does not point at the next move.

The owner asked to make the hub feel considered ("turn it into a Bento"), while ruling three constraints: **augment** the existing map (never replace it or the collapsible list), stay strictly inside the locked app tokens (no new materials — this is Operate-mode UI), and **no explainers** (guidance is carried by affordance/visual weight, never by instructional text).

## Decision

Lay the domain cards out as a **Bento grid** instead of a single vertical column, as a refinement of `RootMap`'s presentational layer only.

1. **Bento grid, not a stack.** The `domainStack` (today `flex-direction: column`) becomes a responsive CSS grid: domain cards occupy a considered modular layout that uses the horizontal space, collapsing to one column at narrow widths. Card *content* (DomainHead + chip row) is unchanged.
2. **Weight follows attention (guidance by affordance).** A domain in a `not_set_up` / `attention` state is given more visual prominence in the grid (e.g. a larger cell and/or the existing accent border already in `STATE_TOKEN`) so the "what next" reads from weight, not words. A fully-rooted camp's grid is calm and even. No checklist, no captions, no instructional copy is added — this is the design-level answer to the "hub shows counts, not next steps" critique.
3. **Census filter row stays.** The four count tiles remain as-is above the grid; their filter/select behavior is unchanged.
4. **Tokens only.** Uses the existing palette, radius (8px), motion tokens, and shadow idiom already in `RootMap`/`SetupScreenShell`. No new colors, no new materials, no glass/neo/etc.
5. **No second stylesheet.** Per CLAUDE.md the single scoped-CSS exception is bounded to `src/components/schedule/`. Bento cell geometry and per-card hover/press states stay inline / data-attribute driven, exactly as `RootMap` does today. The grid must not introduce a new `.css` file.

## Non-goals

- Not a replacement of the census, the chips, the provenance model, or the sidebar list.
- No change to `RootMap`'s business inputs (`model`, `selection`, decisions) — presentational refactor only.
- No new explanatory text anywhere on the hub.

## Consequences

- `RootMap`'s `domainStack` styling and the domain-card sizing become grid-driven; a small amount of per-domain sizing logic (which card is emphasized) is derived from the domain `state` already present on the model.
- `RootMap.test.jsx` gains assertions for the grid/emphasis behavior; existing chip/tile/selection tests must stay green (presentation-only change).
- Reversible: the layout is contained to `RootMap`'s styles; reverting to the vertical stack is a local change.
- Retires the RA-10 wide-panel overlay (docs/adr/2026-08-21-roots-tree-as-primary.md §c): that overlay assumed the lower half of the canvas was a dead zone at wide widths, but the Bento grid now fills that space, so `RootMapPanel` always flows in normal document flow below the map, at every width.
