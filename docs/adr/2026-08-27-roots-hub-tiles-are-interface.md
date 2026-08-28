---
title: "Roots hub — census tiles are the interface (Bento demoted to the Understood tile's view)"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-27
approved: 2026-08-27 (owner-approved concept from iterated prototype; Governor accepted the design + the default-active-tile affordance)
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: []
refines: [docs/adr/2026-08-27-roots-hub-bento-layout.md, docs/adr/2026-08-22-roots-as-hub-setup-ia.md, docs/adr/2026-08-18-rootmap-screen-port.md, docs/adr/2026-08-19-roots-census-and-persistent-inspector.md]
---

# Roots hub — census tiles are the interface

## Status

Proposed. **Refines** `docs/adr/2026-08-27-roots-hub-bento-layout.md`: that ADR's clauses 1, 2, 4, 5 (grid mechanics, weight-follows-attention sizing, tokens-only, no second stylesheet) are **reused as-is** for the Understood tile's drill-down view. Its clause 3 ("census filter row stays… their filter/select behavior is unchanged" implying the grid is always visible beneath the tiles) is **retracted**: the domain/chip grid is no longer always-on. Also refines `docs/adr/2026-08-18-rootmap-screen-port.md`'s selection model only in how the default is *displayed*, not in its state shape.

## Context

The Bento ADR made the always-on domain grid feel considered, but kept it as the permanent centerpiece: every domain card and every chip is visible on every visit, all the time, regardless of what the director actually needs to look at. That is one architectural decision the current, further-iterated prototype now reverses: the owner-approved concept is a hub whose primary surface is the four census tiles (Understood / Needs attention / Changed / Not in source) plus one focused panel driven by tile selection — the grid becomes, at most, content *inside* the Understood tile's panel view, not a permanent backdrop.

This is filed as an ADR (not folded into a plain spec) because it reverses a dated, filed decision (`2026-08-27-roots-hub-bento-layout.md`) about what the hub's default visual state is, and that default is not obviously reversible in practice — a future change that "just adds a fifth tile" or "brings the grid back" needs to know this was deliberate, not a partial implementation.

Investigating the current code (`src/ingest/rootMapModel.js`, `src/components/reconciliation/RootMapPanel.jsx`) surfaced a real, previously latent bug this restructure is also the natural place to fix: `RootMapPanel`'s tile routing (`decisionsForTileState`, `RootMapPanel.jsx:47-55`) scopes every tile to `child.decisionIds` — the set of decision objects attached to a child. A row that imported cleanly and was never attached to any decision (`rootMapModel.js:104-116`, `attributedDecisionFor` returns nothing, `decisionId: null`) still carries `state: 'understood'` on its **roster row** (`rootMapModel.js:106`), but contributes nothing to `child.decisionIds`. Selecting the Understood tile today therefore silently omits the majority of what "Understood" is supposed to mean. 'Changed' and 'Needs attention' don't have this problem — every row in those states is decision-attributed by construction (`stateOf`, `rootMapModel.js:26-34`), so `decisionIds` is a correct index for those two tiles. 'Not in source' (`absent`) is never assigned at child/row granularity in the current code (`stateOf` never returns `'absent'`; the comment at `rootMapModel.js:19-25` confirms it is domain-only and effectively unused at row level today) — so that tile's existing `decisionIds` routing is not wrong, just moot until a domain-level absent case is wired up (out of scope here).

## Decision

1. **Census tiles are the permanent top-level surface.** The four `CensusTile` buttons render unconditionally at the top of the hub, as they do today (`RootMap.jsx:259-272`). This does not change.
2. **The domain/chip grid (`RootMap`'s `domainStack`, `RootMap.jsx:274-333`) is demoted from always-on to Understood-only.** It renders only when the current selection resolves into the Understood tile's context: `selection.type === 'tile' && selection.state === 'understood'`, or `selection.type === 'node'` (a chip/domain click, which only ever originates from inside that context now). For the other three tile selections, and for the default `{type:'none'}` state, the grid does not render at all. All of Bento's presentational mechanics (weight-follows-attention sizing, dimming, the takes-root micro-animation, tokens-only styling) are reused verbatim inside this gated render — nothing about `RootMap.jsx`'s internals below the gate changes.
3. **Node-level selection (an individual domain or chip click) is preserved, not dropped.** It remains reachable exactly as before, but only after the director has entered the Understood tile's grid — there is no longer a standing grid to click into from a cold hub.
4. **The Understood tile's panel content stops depending on `decisionIds` and reads `model.domains[].children[].roster` directly**, filtered to rows with `state === 'understood'`, grouped by domain (`DOMAIN_LABELS`) and rendered through the existing `RosterList` component the node-selection path already uses (`RootMapPanel.jsx:198-209`). This is the fix for the latent gap in the Context section above. 'Changed' and 'Needs attention' keep their existing `decisionIds`-based routing unchanged — it is already correct for those two states.
5. **Default hub state stays `{type:'none'}`** (`ReconciliationScreen.jsx:99`) — no change to the selection state machine. The Needs-attention framing is achieved by treating the `attention` `CensusTile` as visually active whenever `selection.type === 'none'`, a presentational-only addition, because `{type:'none'}`'s existing unresolved-only filtering (`RootMapPanel.jsx:140-142`, the H1 fix) and "resolved · Show all" footer are strictly better than the tile-scoped query and must not be replaced by it.
6. **Empty buckets render one honest line, never an empty card shell**, per tile: reuse the existing line for Needs-attention (`RootMapPanel.jsx:220`, "Nothing needs you right now. Shoresh understood everything it found."); add one comparably short line each for Understood, Changed, and Not-in-source (see companion spec for exact copy). This is state, not instruction, and stays inside the existing `styles.empty` treatment.
8. **The Roots banner is trimmed to two honest actions.** The prior "Facility map" banner button is removed: it pointed at the spatial-layer surface (Locations Map / Day Map / Canvas) that was deleted from the app in PR #201, so the button was a dead affordance leading nowhere. The Import action stays on the banner permanently as "Re-import last year" (for a non-brand-new camp) rather than receding to Settings as an earlier slice ("Slice C") had it: re-importing a prior season is a recurring, top-of-mind director action on the hub, not a buried setting, so a standing banner affordance is the honest placement. This is a two-button banner change (`rootsBanner.jsx`), not new explanatory copy — see Non-goals.
9. **Applies to both `mode="import"` and `mode="inspect"`.** `RootMap`/`RootMapPanel` are the same shared components in both modes today, and the `decisionIds` gap affects both equally (a cleanly-matched row with no decision is just as invisible during an import dry run as it is in the persistent inspector). The import-only tray, progress header, and apply flow (`ReconciliationScreen.jsx:479-489`, `540-566`) are untouched.

## Non-goals

- No change to `buildReconciliationReport`, `buildRootMapModel`'s data shape, the op-log, or any IPC/wire contract. This is a rendering/selection-consumption change only, inside the existing pure-projection boundary (`docs/adr/2026-08-17-onescreen-reconciliation-projection.md`).
- No new `selection` variant. `{type:'none'|'tile'|'node'}` is unchanged.
- No explanatory or instructional copy added anywhere on the hub. (The banner-button trim in Decision §8 is a change to *action* buttons, not explanatory copy — the banner carries no instructional text.)
- Does not touch the `'absent'` row-level gap noted in Context — that is a separate, pre-existing scoping question (domain-level `absent` is effectively dormant today) and is out of scope for this restructure.

## Consequences

- `RootMap.jsx` gains a `showDomainStack` gating condition; its internal grid/chip/animation code is otherwise unchanged.
- `RootMapPanel.jsx` gains one new branch (Understood-tile roster-by-domain) and a small per-tile empty-copy lookup; `decisionsForTileState` is untouched for the other three states.
- `RootMap.test.jsx` and `RootMapPanel.test.jsx` need new assertions for grid visibility gating and the Understood-tile roster grouping; existing assertions that assumed the grid renders unconditionally must be updated — this is expected fallout, not a defect.
- Reversible: reverting to always-on is a local change to the new gating condition; nothing downstream depends on the grid being hidden.
- Supersedes `docs/adr/2026-08-27-roots-hub-bento-layout.md`'s clause 3 specifically (grid always visible below the tiles); that ADR's other clauses stand and are reused.
