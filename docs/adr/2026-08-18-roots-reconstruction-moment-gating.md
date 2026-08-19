---
title: "ADR: Roots Reconstruction Moment — Integration Seam and Gates"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-18
decided: 2026-08-18
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-17-onescreen-reconciliation-projection.md]
depends_on_external: []
related_discovery: [docs/work/specs/2026-08-17-roots-visual-expression-brief.md, docs/work/specs/2026-08-18-roots-reconstruction-moment.html, docs/work/specs/2026-08-18-roots-prototype.html]
program: ingestion-reconciliation-one-screen
phase: R9-prime
---

# ADR: Roots Reconstruction Moment — Integration Seam and Gates

## Context

The prototype at `docs/work/specs/2026-08-18-roots-reconstruction-moment.html` validated a
one-time Canvas 2D "structure settling" sequence as a replacement for the bare loading text
`ReconciliationScreen.jsx:349-356` shows while `runDryRun` is in flight. The Designer's verdict
(owner-approved) is: ship it, but *only* gated — real-latency-bound, above a fact-count floor,
and only on a camp's first import. This ADR fixes where the moment renders, what data it reads,
and how each gate is implemented, so Maker does not have to make further judgment calls.

This is a UI-touching design: DESIGN_STANDARD §5 (motion/feedback) and §8 (transitions) apply,
addressed in "Reduced motion" below.

## The core tension — data arrives exactly when the moment should end

`runDryRun` (`ReconciliationScreen.jsx:225-273`) does two async things in sequence:
`localClient.ingestReconcile(inputs)` (the real dry-run transaction), then, only after that
resolves, `buildReconciliationReport(...)` — which is the *only* place per-domain
understood/needs-attention counts exist. The moment cannot know which roots are "settled" vs
"needs attention" until the instant it's supposed to end.

**Resolution: two-phase animation, not two data sources.**

- **Phase 1 — indeterminate growth** (0ms → reconcile resolution): the root system grows/branches
  using a generic, domain-shaped topology (the four fixed domains — Structure, Scheduling, Time,
  Facility — from `DOMAIN_OF`/`DOMAINS` in `ReconciliationScreen.jsx:24-34`, reused verbatim, not
  reinvented). No domain is marked understood or needs-attention yet; all roots grow in the same
  "in progress" visual state. This is honest: the app genuinely doesn't know yet.
- **Phase 2 — settle** (triggered the instant `buildReconciliationReport` returns): each domain's
  roots snap/settle into their real state, read from `report.buckets` and a per-domain rollup of
  `report.decisions` (the same `domainOf()`/`domainCounts` computation `ReconciliationScreen.jsx`
  already does at lines 375-380 — reuse it, don't recompute it inside the moment). This settle
  beat is capped at a short fixed duration (an owner-tunable constant, see below) — it is the
  *only* part of the sequence allowed to run after the real work finishes, and it is a settle
  animation, not a wait: if `prefersReducedMotion()` is true it collapses to instant.
- **No padding.** Phase 1 has no minimum duration and no target duration — it runs exactly as
  long as `ingestReconcile` + `buildReconciliationReport` take. If that's 200ms, Phase 1 is
  200ms of growth then an instant settle. If it's 3s, Phase 1 keeps growing for 3s. There is no
  timer racing the network/compute; the moment is driven by promise resolution, full stop.

This makes GATE 1 (real-latency-bound) structural rather than a rule Maker has to remember: the
component's only inputs are "still reconciling" (boolean) and "report" (data-or-null); it has no
internal clock beyond the capped settle beat.

## Render seam

Add `src/components/reconciliation/ReconstructionMoment.jsx`, mounted from
`ReconciliationScreen.jsx` in place of the current loading branch:

```
if (loading && !report) {
  if (shouldShowReconstructionMoment({ factCount, isFirstImport, prefersReducedMotion: prefersReducedMotion() })) {
    return <ReconstructionMoment domainCounts={settledDomainCounts} onSettled={...} />
  }
  return /* existing plain-text branch, unchanged */
}
```

- `factCount` and `isFirstImport` are computed once, **before** this screen mounts, in
  `ImportScreen.jsx` (see Gate 2 and Gate 3 below), and passed down through `baseInputs` or a
  sibling prop — not fetched again inside `ReconciliationScreen` or the moment itself. The
  gating predicate must run before the moment ever paints; recomputing it after mount would let
  a flash of the wrong branch through.
- `ReconstructionMoment` receives:
  - `phase`: `'growing'` while `loading` is true and `report` is null (Phase 1), `'settling'` on
    the render where `report` first becomes non-null (Phase 2).
  - `domainCounts`: `null` during `'growing'`; the real `{Structure, Scheduling, Time, Facility}`
    understood/needs-attention rollup (derived exactly as `ReconciliationScreen.jsx:375-380`
    already does, factored into a small shared helper both call) once `phase === 'settling'`.
  - `onSettled`: called when the capped settle beat completes (or immediately, if reduced motion)
    — `ReconciliationScreen` uses this only to know it's safe to render the normal report body;
    it does not gate `loading`/`report` state, which `runDryRun` already owns.
- The moment renders nothing else — no buttons, no navigation, no dismiss control (see
  Non-goals). It occupies the same layout slot the plain-text branch does today.

## Gates

### Gate 1 — real-latency-bound
Already structural per "The core tension" above: Phase 1 has no duration of its own, it is
literally "however long the `await` takes." Nothing to configure; nothing for Maker to get wrong
except accidentally adding a `setTimeout` floor — call this out explicitly in the Maker brief as
a thing NOT to add.

### Gate 2 — fact-count floor
- **Signal:** raw parsed row/fact count from the source file, known at parse time —
  `workbookToSource(wb, {...})` in `ImportScreen.jsx` (~line 310) already produces this before
  `ReconciliationScreen` ever mounts. Use the source's row count (sum of parsed rows across
  sheets/pages the workbook produced), not `result.planItems.length` from `ingestReconcile` —
  planItems is a *post-reconciliation* artifact (only known after the exact moment the gate needs
  to have already decided), and using it would force the skip decision to happen after the moment
  had already started painting.
- **Where computed:** `ImportScreen.jsx`, immediately after `workbookToSource` returns, before
  `setLedger(...)` (~line 519). Store as `factCount` alongside `ledger.context`/`fileName`.
- **Predicate:** `factCount >= ROOTS_MIN_FACT_COUNT`. Below the floor, `runDryRun` still executes
  identically — only the render branch differs, falling straight to the existing plain-text
  loading copy.
- **Constant:** `ROOTS_MIN_FACT_COUNT`, owner-tunable, defined once in
  `ReconstructionMoment.jsx` (or a small `reconstructionMoment.constants.js` beside it) and
  imported by the gate predicate — not duplicated. Starting value left to Designer/Maker
  judgment from prototype state E (new/empty camp) vs state B (several genuine decisions); the
  brief's own state E finding ("thin air") is the concrete evidence for setting it above zero.

### Gate 3 — first-import-only
- **Signal:** whether this camp already has any reconstructed domain data, i.e. whether this is
  the camp's first import. No `import_ledger`/`ingest_run` table exists in the schema today
  (confirmed: no such table in `electron/db/`), so there is no dedicated "has this camp been
  reconstructed" flag to reuse as-is. What *does* already exist and is reused instead: the same
  seven-collection readiness read `fetchReadiness()` performs
  (`ReconciliationScreen.jsx:191-203` — cohorts, tiers, groups, days, timeBlocks, activities,
  anchors, all via the existing `localClient.list(...)` IPC surface). If every one of those
  collections is empty, no import has ever landed structural data for this camp — this **is**
  "first import" for the purpose of this feature, with no new schema and no new table.
- **Where computed:** `ImportScreen.jsx`, once, at the same point `factCount` is computed
  (~line 519), by calling the same collection reads `fetchReadiness()` uses (factor that read
  into a shared helper importable from both `ImportScreen.jsx` and `ReconciliationScreen.jsx`
  rather than duplicating the six `localClient.list(...)` calls). This is a read the app already
  performs on every reconciliation cycle; computing it once more at parse time is not a new I/O
  pattern.
- **Predicate:** `isFirstImport = allCollectionsEmpty(readinessCollections)`.
- **Fallback when false:** identical to Gate 2's fallback — plain-text loading branch, `runDryRun`
  unaffected.
- **Note:** this signal is coarser than "has an import ever completed" (a director who manually
  entered a few cohorts by hand before ever importing a file would count as NOT first-import, and
  correctly so — the camp isn't "thin air" anymore, the moment has nothing to earn there either).
  That is the correct behavior for this feature, not a gap: the fact-count floor and the
  first-import gate are answering the same underlying question ("is there enough already-real
  structure for reconstruction to be a meaningful thing to watch") from two different signals,
  and either one alone is sufficient to skip.

### Reduced motion
`prefersReducedMotion()` (`src/styles/shared.js`, already imported in
`ReconciliationScreen.jsx:3`) is read once, before the moment mounts, and passed into the same
gate predicate — reduced motion is a fourth reason to skip straight to the existing plain-text
branch, not a separate code path inside `ReconstructionMoment`. This satisfies "reduced motion is
never *no* feedback": the fallback is the existing plain-text loading line, which is itself
real feedback (it already exists, is not being removed, and is not a blank screen).

## Test seams

Add a pure, colocated predicate — no DOM, no Canvas, no IPC:

```js
// src/components/reconciliation/reconstructionMoment.gate.js
export function shouldShowReconstructionMoment({ factCount, isFirstImport, prefersReducedMotion }) {
  if (prefersReducedMotion) return false
  if (!isFirstImport) return false
  if (factCount < ROOTS_MIN_FACT_COUNT) return false
  return true
}
```

Unit-test this function directly: all four skip reasons individually, the show case, and the
boundary at exactly `ROOTS_MIN_FACT_COUNT`. This is the only part of the feature Verifier/Tester
needs deterministic coverage on — the prototype HTML already validates the Canvas draw routine
visually; `ReconstructionMoment.jsx`'s render logic should be a thin consumer of this predicate
plus the phase/domainCounts props, not re-implement any of the gating itself.

Also test: `onSettled` fires exactly once per mount, and fires promptly (no artificial delay
beyond the capped settle beat) once `phase` transitions to `'settling'` — this is the executable
form of Gate 1.

## Files/modules affected

- New: `src/components/reconciliation/ReconstructionMoment.jsx` (Canvas draw routine, ported from
  the validated prototype), `src/components/reconciliation/reconstructionMoment.gate.js` (pure
  predicate), a small constants file or exported constant for `ROOTS_MIN_FACT_COUNT`.
- Changed: `src/screens/ImportScreen.jsx` — compute `factCount` and `isFirstImport` once at parse
  time (~line 519), pass both down to `ReconciliationScreen`. `src/screens/ReconciliationScreen.jsx`
  — replace the loading branch (lines 349-356) with the gated render; factor the domain-rollup
  logic (lines 375-380) into a shared helper callable from both the screen and the moment.
- No schema change. No IPC contract change (Gate 3 reuses `localClient.list(...)` calls already
  exposed).

## Reused vs. new

Reused: the four-domain vocabulary (`DOMAIN_OF`/`DOMAINS`), the domain-rollup computation, the
`fetchReadiness()` collection reads, `prefersReducedMotion()`, the existing plain-text loading
branch (kept as the universal fallback, not deleted). New: the Canvas component itself (visual
layer only, prototype-validated), the pure gate predicate, the two owner-tunable constants
(`ROOTS_MIN_FACT_COUNT`, settle-beat cap). Nothing here needed a new table, a new IPC method, or a
new contract — hence no ADR-worthy schema/protocol decision beyond this integration-seam record
itself, which exists because the *gating discipline* (three real-user-facing tradeoffs: latency
honesty, floor value, first-import scope) is the kind of not-obviously-reversible product decision
the constitution's ADR bar names, even though the code footprint is small.

## ADR required: yes
This document. The decision recorded: the moment is driven by promise resolution, not a timer
(Gate 1); the fact-count signal is pre-reconcile parse-time row count, not post-reconcile
planItems (Gate 2's data-source choice); "first import" is derived from existing
readiness-collection emptiness rather than a new ledger table (Gate 3's reuse-over-new choice).
Each is a tradeoff a later contributor could plausibly get wrong without this record.

## Open questions for Governor
1. `ROOTS_MIN_FACT_COUNT` exact value — needs a product judgment call informed by the prototype's
   state-B vs state-E runs (Designer/owner should pick during Maker's implementation, not before;
   left as an owner-tunable constant deliberately, not blocking this ADR).
2. Settle-beat cap duration (Phase 2's maximum, e.g. ~300-500ms in the prototype) — confirm the
   exact value against the shipped prototype's own timing rather than this ADR inventing a new
   number; Maker should port the prototype's measured settle duration, not re-derive one.
3. Whether `isFirstImport`'s coarser-than-ledger definition (readiness-collections-empty) is
   acceptable long-term, or whether a future explicit "camp reconstructed" flag becomes worth
   adding once a real camp has gone through this — no action needed now, flagged for the
   pre-production bias-bold note (revisit when first real camp onboards).
