---
title: "Roots home is a distinct screen — census tiles stay import-only, structure and attention are live reads"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-08-28
approved: pending owner approval
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: [docs/work/specs/2026-08-28-lifecycle-ia-program.md]
refines: [docs/adr/2026-08-27-roots-hub-tiles-are-interface.md, docs/adr/2026-08-27-roots-hub-bento-layout.md, docs/adr/2026-08-22-roots-as-hub-setup-ia.md, docs/adr/2026-08-19-roots-census-and-persistent-inspector.md, docs/adr/2026-08-18-rootmap-screen-port.md]
affects: [src/screens/ReconciliationScreen.jsx, src/components/reconciliation/domainRollup.js, src/ingest/rootMapModel.js, src/engine/readiness.js, src/App.jsx]
---

# Roots home is a distinct screen — census tiles stay import-only, structure and attention are live reads

## Status

Proposed. Consumed by Governor to brief Designer (already produced the approved spec/prototype) and Maker.

**Refines `docs/adr/2026-08-27-roots-hub-tiles-are-interface.md`** — see Decision §1 for exactly which clauses stand and which are retracted. **Refines `docs/adr/2026-08-27-roots-hub-bento-layout.md`** — its clauses 1/2/4/5 (grid mechanics, weight-follows-attention, tokens-only, no second stylesheet) are reused, but retargeted: the "bento" they describe moves from being the Understood tile's drill-down grid to being the Roots home's permanent "what has taken root" structure grid. **Does not touch** `docs/adr/2026-08-17-onescreen-reconciliation-projection.md`'s pure-projection invariant for the import flow, or `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`'s two-routes-never-canonical rule (Decision §5 relies on it, doesn't alter it).

## Context

`ReconciliationScreen.jsx` (785 lines) today serves two call sites through one `mode` prop: `mode="import"` (the reconcile-a-file flow — progress tray, apply buttons, census tiles) and `mode="inspect"` (the Roots home a director opens every day). ADR `2026-08-27-roots-hub-tiles-are-interface.md` established that both modes share `RootMap`/`RootMapPanel` and gated the always-on domain grid to the Understood tile's selection — a rendering change inside a component both modes still shared.

The owner has now rejected keeping any census/diff vocabulary (Understood/Changed/Not-in-source, "N understood," any framing that implies "changed from what") on the home a director returns to daily, over four iterations of the attached spec (`WS4-roots-home-spec.md`, prototype `WS4-roots-home.html`). The approved home has no relationship left to the census: a plain `Schedule →` door, a "what has taken root" bento of the camp's **current live structure** (not a diff), a "needs your attention" list that is a **live union** of unresolved reconciliation decisions and (eventually) genuine structure issues, and import/worksheet actions demoted to the bottom. The census tiles, `RootMap`, and `RootMapPanel` are **confirmed to stay exactly where #206 put them: `mode="import"`'s reconcile-a-file flow** — this ADR does not reopen that placement, it removes the *other* caller.

This is the point at which `mode="inspect"` and `mode="import"` stop being two renderings of related content and become two features that happen to share a file for historical reasons. That's the structural question this ADR resolves, plus two data-sourcing questions the spec explicitly flagged as unresolved (`WS4-roots-home-spec.md` "Implementation notes for Maker").

### Candidate approaches considered (divergent pass)

Three questions were run through isolated-frame divergent ideation (`adhd` skill) before converging.

**A. How to split inspect (home) from import (reconcile).** Candidates: (1) keep one component forked by `mode` [status quo — rejected, is the source of the coupling], (2) adapter over a headless import engine hook, (3) route-level composition — two components from the App.jsx `SCREENS` map, no shared screen component, (4) parent-lifted state with dumb mode-specific views, (5) capability-flags object replacing the `mode` string, (6) strangler-fig behind a temporary feature toggle, (7) shared render-prop/slot shell exposing named slots. Rejected as over-engineered for this cutover: (2), (5), (7) — all introduce a new abstraction layer (an engine hook, a flags contract, a slot API) to serve exactly two call sites that, per the approved spec, no longer share any rendered content beyond "a page frame and a loading skeleton." (6) is a real tool for a risky cutover but this is a net-new screen replacing an existing one behind existing navigation — no traffic-splitting need. (4) is close but implies the two views still take a large shared prop bag; given how little is actually shared (see Decision §2), that's solving a coupling problem that mostly doesn't exist after the split.

**B. Attention-list sourcing / the getReadiness-vs-buildRootMapModel divergence.** Candidates: (1) make `getReadiness` a query view over `buildRootMapModel`'s decisions [structural fix, ★ non-obvious-but-viable], (2) resolution-as-event-log, derive attention as all-known-issues-minus-resolved, (3) stub the structure-issues half empty until scoped, (4) compute the union lazily on every render, no caching, (5) one shared discriminated-union "attention item" shape enforced by a type, (6) a golden-fixture test asserting count-parity across both entry points. Converged on (3) + (4) + (5) as the smallest responsible combination — see Decision §3. (1) and (2) are real fixes but touch `getReadiness`'s existing, separately-scoped consumers (sidebar "needed" marks, WS1) — out of this ADR's blast radius; flagged as future work, not deferred silently.

**C. "What has taken root" bento data sourcing.** Candidates (post-inversion of "how would this go stale"): (1) fetch fresh on every mount, no cache layer, (2) own read hook, not reused from `ReconciliationScreen`'s `fetchReadiness`, (3) recompute from raw `localClient.list()` arrays, never from a stored rollup object, (4) refetch on every navigation-into-Roots, not just first mount, (5) subscribe to `onOpApplied` for live invalidation, (6) return frozen/immutable count objects per fetch. Converged on (1)+(2)+(3)+(4); (5) is real but is standing infrastructure work (op-log push subscription) disproportionate to a read-only counts panel — flagged as future hardening, not required for this cutover. (6) is achieved for free by (1)/(3) (nothing is held across renders to mutate).

## Decision

### 1. Rescope `docs/adr/2026-08-27-roots-hub-tiles-are-interface.md`

That ADR's clauses about the census tiles, `RootMap`, and `RootMapPanel` (clauses 1–4, 6, 9) **stand unchanged for `mode="import"`.** They are **retracted for `mode="inspect"`**, because clause 9 ("applies to both `mode="import"` and `mode="inspect"`") is now false: `RootMap`/`RootMapPanel` are removed from the inspect render path entirely (Decision §2). Clauses 5, 7, 8 (default selection state, empty-copy convention, banner button trim) become **import-mode-only** statements as a consequence, not by further edit — they describe behavior of components that no longer render on inspect. No code inside `RootMap.jsx`/`RootMapPanel.jsx` changes because of this ADR; only their caller does.

### 2. Split `ReconciliationScreen` by route, not by prop — Candidate A3

A new screen component, `src/screens/RootsHomeScreen.jsx`, is added and wired as the Roots hub's `SCREENS` entry in `src/App.jsx`, replacing the current `<ReconciliationScreen mode="inspect" .../>` call site. `ReconciliationScreen.jsx` keeps `mode="import"` as the only caller-supplied mode going forward and **all `mode === 'inspect'` branches inside it are deleted** (the `justImported`/`PostImportBanner` continuation, `RootsBanner`'s inspect usage, `inspectReadiness`, `censusReadFailed`, `rootMapModel` when `mode==='inspect'`, etc.) once `RootsHomeScreen` ships and both screens have been verified side by side. This is route-level composition (Candidate A3): the two screens are siblings in `App.jsx`'s screen map, not one component forked internally.

**Why not a shared hook or slot abstraction (A2/A4/A7):** after the split, the only things the two screens still have in common are (a) fetching the camp's live entity collections and (b) the loading-skeleton convention from `src/index.css`. (a) is already a plain async function (`fetchReadiness`/`readinessCollectionsFromCensus` today) — it doesn't need a hook wrapper shared between two screens to stay DRY, it needs to exist once and be imported twice (see §4). (b) is a CSS convention, not a code dependency. Building an adapter/engine-hook or a capability-flags contract to share *that little* is the trap Candidate scoring flagged: it adds an abstraction surface two call sites don't need. If a third "reconciliation-shaped" screen appears later, that is the point to introduce a shared hook — not now (`karpathy-guidelines`).

**Shared vs. forked, concretely:**
- **Forked (each screen owns its own copy):** render tree, all `mode==='import'`-only state (progress tray, `apply`, `stage`, `confirmedCount`/`doneCount`, `RootMap`/`RootMapPanel`/`RootsBanner`/`PostImportBanner`), all `mode==='inspect'`-only state that existed before this ADR (deleted, not moved — the new home doesn't need `justImported`, `censusReadFailed`, `inspectReadiness`, or anything census-shaped).
- **Reused as-is, unmodified:** `localClient`, `describeWriteFailure`, `downloadWorkbook` (bottom-action wiring), `useEnterTransition`/`prefersReducedMotion`, the loading-skeleton CSS convention, `domainRollup.js` (`DOMAIN_OF`/`DOMAINS`/`computeDomainCounts`), `buildRootMapModel`/`rootMapModel.js` (read-only, for the attention half — see §3).
- **New:** `RootsHomeScreen.jsx` itself; a `useCurrentStructureCounts(campId)` hook (§4) for the bento; a `buildAttentionList(...)` pure function (§3) for the attention panel; the bento/attention/Schedule-bar presentational JSX per the spec's visual design (Designer's scope, not this ADR's).

**Migration order for Maker (test-first seam):** build `RootsHomeScreen.jsx` and its two new data functions against unit tests first (they're pure/hook-level, no rendering needed to verify correctness), wire it into `App.jsx` behind the existing navigation (no route-name change — the sidebar's Roots entry already points at this screen slot), verify visually against the prototype, **then** delete the `mode==='inspect'` branches from `ReconciliationScreen.jsx` in a separate, smaller commit. Never delete the old inspect path before the new screen is wired and verified — that's the one-way door in this migration; everything else (adding a new file, adding a new hook) is trivially reversible.

### 3. "Needs your attention" — union, single source per half, second half deferred

`buildAttentionList({ campId, snapshot })` (new, pure function, colocated with `rootMapModel.js` or its own module) returns one normalized array of `{ id, name, why, domainTag, sourceKind }` rows, built as:

- **Reconciliation half (wired in this ADR):** derived directly from `buildRootMapModel`'s existing per-child `state === 'attention'` classification (`rootMapModel.js`'s `stateOf`), the same data `RootMapPanel`'s `decisionsForTileState` already surfaces for the `attention` tile in import mode — read here, not recomputed. This is Candidate B5 (one shared row shape) applied narrowly: normalize `buildRootMapModel`'s decision-shaped rows into the row shape above at the boundary, don't change `rootMapModel.js` itself.
- **Structure-issues half (minimal, wired in this ADR — owner decision 2026-08-28):** a small, pure, extensible set of **live current-state completeness checks** over the camp's own entities, normalized into the same row shape — so a hand-built camp with a real gap is not silent. Starter set (extensible, and the exact list is a Maker/Designer detail): e.g. **a group with no activities eligible/assigned**, and **a required setup area that is empty**. These are pure reads over `localClient.list(...)` results, computed live on mount (no cache), with NO dependency on the schedule engine. **Explicitly NOT in scope:** the full `buildSchedule.js` `findings`/flags integration — the engine's findings are per-schedule/per-route, and "which route's findings count as a structure issue" is a genuine product question (two-routes-never-canonical) that is deferred to its own later slice. This half starts small and honest; it does not attempt engine-grade analysis.
- **The `getReadiness`-vs-`buildRootMapModel` divergence is *sidestepped for this list*, not fixed.** The attention list reads `buildRootMapModel` exclusively and never calls `getReadiness`. `getReadiness` keeps its existing, separately-scoped consumers (e.g. sidebar "needed" marks per WS1) untouched — this ADR does not audit or change those. Because the verdict-banner number that used to expose the disagreement is gone from the home (per spec), there is no longer a visible two-numbers symptom on this screen; the underlying divergence between the two functions still exists in the codebase and is **explicitly deferred**, not resolved, as its own future cleanup (flagged in Open Questions) — conflating "no longer visibly wrong on this screen" with "fixed" would be a false close.
- Computed lazily on every mount/navigation-in (Candidate B4/C1), never cached across screens or stored in a rollup object — the failure mode being designed against is a stale count surviving a director's edit made elsewhere and then navigating back.

### 4. "What has taken root" — live structure read, not a rollup reuse

A new `useCurrentStructureCounts(campId)` hook fetches each entity collection directly via `localClient.list(...)` (the same calls `fetchReadiness()` in `ReconciliationScreen.jsx` already makes) and returns per-domain counts/names, grouped through the existing `DOMAIN_OF`/`DOMAINS`/`computeDomainCounts` taxonomy in `domainRollup.js` — reused as-is, it is exactly "camp's live entities per domain" already. It does **not** import or call `ReconciliationScreen.jsx`'s `fetchReadiness`/`readinessCollectionsFromCensus` functions directly (Candidate C2: own read hook, not reused across the split) — those functions carry inspect/import-mode assumptions (e.g. `readinessCollectionsFromCensus` translates from the census snapshot shape) that don't apply once there's no census on this screen; `useCurrentStructureCounts` calls `localClient.list()` per entity type itself, mirroring the pattern rather than importing the function. It refetches on every mount of `RootsHomeScreen` (i.e. every navigation into Roots, not just first app load) and holds no cross-render cache (Candidate C1/C4) — the bento showing a live camp fact one edit stale is the exact failure this hook must not have.

### 5. `Schedule →` navigation target

The bar's action calls `onNavigate('plants')` (or whatever `App.jsx`'s current Plants-entry screen key is at implementation time — grep before wiring, do not assume the key). Per `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`, this **must not** pick Manual vs. Generated on the director's behalf — it lands on Plants' own entry surface, whatever that resolves to (today: the schedule screen's own default/last-used route selection, unchanged by this ADR). This ADR adds no new routing logic; it wires one `onNavigate` call to an existing destination.

## Files/modules affected

- **New:** `src/screens/RootsHomeScreen.jsx`, a structure-counts hook (name per §4), an attention-list builder (name per §3, colocated near `rootMapModel.js`).
- **Changed:** `src/App.jsx` (`SCREENS` map entry for Roots now points at `RootsHomeScreen`), `src/screens/ReconciliationScreen.jsx` (inspect-mode branches removed once the new screen is verified — separate commit per §2).
- **Untouched:** `RootMap.jsx`, `RootMapPanel.jsx`, `RootsBanner.jsx`, `postImportBanner.jsx`, `rootMapModel.js`'s exported functions (read, not modified), `domainRollup.js`, `readiness.js`, `buildSchedule.js`.

## Reused vs. new

**Reused:** `domainRollup.js` (`DOMAIN_OF`, `DOMAINS`, `computeDomainCounts`), `buildRootMapModel`'s attention classification (read-only), `localClient.list()` IPC surface, `useEnterTransition`/`prefersReducedMotion`/loading-skeleton conventions, `downloadWorkbook`/`describeWriteFailure` for the bottom actions, existing `onNavigate` routing convention.

**New and why nothing existing covers it:** `RootsHomeScreen.jsx` (no existing screen renders structure-not-diff), `useCurrentStructureCounts` (existing `fetchReadiness` is entangled with census/mode assumptions this screen doesn't have), the attention-list normalizer (no existing function unions decision-rows with a second, currently-empty source into one row shape).

## ADR required: yes

This is exactly the case the constitution's bar names: it changes an existing contract other code calls (`ReconciliationScreen`'s `mode` prop contract loses a caller and a branch), and it makes a non-trivially-reversible structural choice (route-level split vs. shared-component fork) that the next screen sharing reconciliation-shaped data will need to know was deliberate. Filed at `docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md` once approved.

## Open questions for Governor

**All resolved during owner review (2026-08-28):**

1. ~~Structure-issues half of the attention list.~~ **Decided: wire a MINIMAL live structure-check now** (see Decision §3) — a small, extensible set of pure current-state completeness checks (e.g. a group with no activities, an empty required area), so a hand-built camp with a real gap isn't silent. The full `buildSchedule` findings integration stays deferred (its own later slice, gated on the two-routes "which route's findings count" product question).
2. ~~`getReadiness`/`buildRootMapModel` divergence.~~ **Decided: accept as deferred, tracked debt.** It no longer surfaces visibly on the home (the verdict number is gone); the underlying two-function divergence is NOT closed by this ADR and is carried as its own future cleanup — not a false close.
3. ~~Timing of the `ReconciliationScreen` inspect-branch deletion.~~ **Decided: the two-commit migration is accepted** (new screen wired + verified, then a separate deletion commit) so Roots navigation is never left broken with no rollback. Both commits may live in one PR.

**Still open:** none.
