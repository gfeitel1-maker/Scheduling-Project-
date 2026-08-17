---
title: "ADR: One-Screen Reconciliation — Projection/Adapter Seam"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-08-17
decided: 2026-08-17
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md, docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md, docs/adr/2026-08-15-camp-locations-entity.md]
depends_on_external: []
related_discovery: [docs/work/runs/2026-08-17-reconciliation-r0-audit.md, docs/work/runs/2026-08-17-reconciliation-r1-design-divergence.md]
program: ingestion-reconciliation-one-screen
---

# ADR: One-Screen Reconciliation — Projection/Adapter Seam

**Status: ACCEPTED for Seams 1–3 + 5 (Governor/owner, 2026-08-17). Seam 4 (grace-window undo)
is SPLIT OUT into its own later slice and is NOT approved for build.**

> **Gate outcome 2026-08-17 (Red Hat, Resilience 2/5 — all findings isolated to Seam 4).**
> Red Hat found three HIGH structural gaps in the compensating-inverse undo: (1) Replace-mode
> undo yields an *empty schedule* (`replaceScope` tombstones aren't invertible by the two-shape
> mechanism and aren't wrappable as claimed); (2) the creation-row "touched since" gate only
> checks import-written fields, so a human filling a blank the import left empty is invisible →
> whole-row deletion + silent data loss; (3) no cross-entity referential check → undo can orphan
> a FK (delete "Lake" while keeping an edited "Kayaking"). Plus MEDIUM seq-vs-COALESCE landmine
> and edge cases (double-undo wording, where `invertibleOps` lives, second-import-during-window).
> **Owner decision: DECOUPLE.** Seams 1–3 + 5 are sound and constitute the one-screen experience;
> the staged tray (decide≠apply) is the v1 safety net. Undo becomes its own slice requiring an
> Architect revision (scope to add-mode only per Red Hat's fix (a); full-projection-field gate for
> Risk 2; single-hop referential skip-propagation for Risk 3; device-local-seq invariant for
> Risk 4; a 4th invariant naming where the backing state lives + one-live-window constraint) AND a
> second Red Hat pass BEFORE any undo code is written. Seam 4 below is retained as the starting
> point for that revision, not as an approved build target.

## Context

R0 (`docs/work/runs/2026-08-17-reconciliation-r0-audit.md`) found the reconciliation logic
layer already shipped and wired end-to-end: `buildReconciliationReport` (pure, `src/ingest/
reconciliationReport.js`), a transactional dry-run sharing the exact commit code path
(`commitIngest` → `commitPlan`, `electron/ops/ingest.js`), held/changed semantics, and
`locations` already an `INGESTIBLE_ENTITY`. The one-screen initiative is a presentation/
composition problem: `ImportScreen.jsx` (~1998 lines) gates a director through ~6 sequential
states (upload → per-entity ticking → held-conflict banner/`HeldResolution` takeover →
`ReconciliationSummary` (4 buckets) → `ReconciliationQueue` (sidelined, self-documented as
superseded) → `ReconciliationLedger` (the real work + Commit) → post-commit banner) when the
underlying data model already supports one continuous, filterable surface.

R1 (`docs/work/runs/2026-08-17-reconciliation-r1-design-divergence.md`) ran `/adhd` divergence
(5 frames × 6 ideas) on the *product* shape and converged on: a shrinking triage lane ordered
by readiness-demand, understood-and-silent by default, filterable by domain (state-first per
the owner's locked decision), with discrete salience compression and a staged tray that *is*
the dry-run. Three owner decisions are LOCKED: restrained list-first salience (spacing/accent/
scale/order, no ornamental layer, kill-switch, grayscale-recoverable), by-state-first lens with
domain as filter chips, and grace-window whole-import undo via compensating inverse ops (not a
durable synced reconciliation-record entity in v1).

This ADR specifies the technical seam that makes that product shape possible without creating
a second source of truth: the pure adapters between `buildReconciliationReport`'s existing
output and the UI, the reuse of the existing dry-run as the staged tray, and the compensating-
inverse-op mechanism for undo. It also names the two places where the report's current output
is too thin for the design and specifies the smallest additive fix.

## Candidate approaches considered

Divergence on the *product* shape already happened in R1 (`/adhd`, 5 frames, converged and
owner-locked). What remains architecturally open is the *seam* — how the UI reads the report
and how undo is implemented — which is where I ran divergence for this ADR:

1. **Adapter-in-renderer vs. adapter-in-report.** Put `reportToLanes`/`salienceOf` as pure
   functions in `src/ingest/` next to `buildReconciliationReport` (chosen) vs. inline logic
   inside `ImportScreen.jsx`/a new screen component. Rejected the latter: it is exactly the
   "second source of truth" risk the invariant exists to prevent — a screen-local reducer
   accretes special cases over time in a way a co-located pure function with its own
   characterization tests does not. Precedent: `reconciliationResolutions.js` already lives
   outside the screen for the same reason.
2. **Staged tray: real dry-run reuse vs. a new client-side draft model.** Thread staged/held
   decisions through the existing `dryRun: true` path on every keystroke of triage (chosen) vs.
   build a lightweight in-renderer draft that mimics `buckets`/`readiness` shape without calling
   the DB. Rejected the draft: it is a second, hand-maintained copy of classification logic that
   *would* drift from `commitPlan`'s real staleness/conflict/protection rules — the exact
   failure mode Phase C's ADR was written to prevent ("buckets and decisions cannot drift apart
   by construction"). Reusing the transactional dry-run costs one extra IPC round-trip per
   triage action; that is the acceptable tradeoff for truthfulness.
3. **Undo: compensating inverse ops vs. snapshot/restore vs. durable reconciliation-record
   entity.** Snapshot-and-restore (dump affected rows before commit, blind-write them back on
   undo) was rejected outright: in a local-first synced op-log, a blind restore can silently
   clobber a concurrent edit from another device that arrived after import — the exact
   correctness bug a Red Hat pass would flag first. A durable, synced `reconciliation_runs`
   entity (owner-decision-locked out of v1) was rejected for *this* ADR only because the owner
   scoped grace-window undo, not a permanent audit record — it remains a named, cheap follow-on
   (see Consequences). Compensating inverse ops gated by op-seq comparison (chosen) is the
   smallest mechanism that is still correct under concurrent writes: it *asks the op-log itself*
   whether a field has been touched since import, rather than asserting a wall-clock snapshot is
   still valid.

## Decision

The one-screen surface is built as **four pure/typed seams over the existing pipeline**,
plus **two small additive fields on the existing report/commit outputs** — no new tables, no
new IPC methods, no parallel classification logic.

```
buildReconciliationReport(input)        [existing, unchanged]
        │  { buckets, decisions[], meta }
        ▼
reportToLanes(report) -> lanes          [NEW, pure adapter — seam 1]
        │  { express, standard, hold, spine }
        ▼
salienceOf(decision, blastRadiusIndex)  [NEW, pure fn — seam 2]
        │  { rank, reason }             (called per-decision by the lane renderer)
        ▼
[UI renders lanes; each triage action stages into] 
        ▼
commitIngest(db, {..., mode: 'stage'|'commit', dryRun})   [existing signature, THREADED — seam 3]
        │  re-runs the SAME dry-run on every staging change; buckets/readiness stay live+truthful
        ▼
commitIngest(db, {..., dryRun: false, captureInverse: true})  [existing call, ONE new flag — seam 4]
        │  outcome.invertibleOps[] captured
        ▼
[grace-window undo, in-memory, session-scoped]
```

### Seam 1 — `reportToLanes(report) -> { express, standard, hold, spine }`

**File:** `src/ingest/reportToLanes.js` (new, pure, no IO — same discipline as
`reconciliationReport.js`).

**Signature:**
```js
// Pure. No IO, no DB, no clock/random. Deterministic given the same report.
export function reportToLanes(report) {
  // returns { express: Decision[], standard: Decision[], hold: Decision[], spine: SpineRow[] }
}
```

**Mapping rule (by confidence + status, no new parsing):**
- `hold` — every `decision.kind === 'resolve_conflict'` (report's CONFLICT bucket), plus any
  `confirm_change`/`confirm_value` with `confidence === 'conflict'`. These are the only
  decisions that can HOLD the whole commit per the existing `commitPlan` semantics — they must
  render first, unconditionally, never buried under salience ordering.
- `standard` — `confidence === 'low'` or `'medium'` decisions (`confirm_value`), and every
  `confirm_change` (a director-confirmed field being overwritten is never "express" regardless
  of tier — Phase C's rule 4 already treats this as always-a-decision).
- `express` — `confidence === 'high'` decisions that still produced a decision row (there are
  none today per `classifyItem`'s HIGH-collapses-to-`understood` rule — `express` is therefore
  currently always empty and exists as a forward seam, not dead code: it is where the R1
  "provocation" — a director-set trust threshold making re-import mostly express — attaches
  later without touching this adapter's shape). `review_legacy_priority` (batch, `confidence:
  'low'`) sorts into `standard`.
- `spine` — one row per bucket key in `report.buckets` order (`understood`, `needsAttention`,
  `notInSource`, `changed`) plus a `readinessGreen: boolean` computed from the same readiness
  rows the report already threads through `buildReconciliationReport`'s `readiness` input — this
  is the "done = list empty AND readiness green" signal from R1. `understood`/`notInSource` never
  produce lane rows (silent-by-design, matching Phase C rule 6); they still appear in `spine` as
  counts for the one-line receipt.
- **Ordering within a lane** follows `report.decisions` array order, which is itself walk-order
  over `planItems`/readiness rows in the report — no re-sorting by anything the adapter invents;
  cross-cutting salience (seam 2) is a rendering hint, not a reordering of source-of-truth order,
  so the list-first "reads as a plain sorted checklist with visuals off" acceptance test from the
  owner's locked salience decision holds by construction.

**No new state, no new parsing.** Every field `reportToLanes` reads already exists on
`decision`/`report.buckets`/`report.meta`. This is a total, exhaustive `switch`/lookup over the
existing `kind`/`confidence` vocabulary — it cannot silently drop a decision kind because an
exhaustiveness check (throw on unrecognized `kind`) is part of the seam, same discipline
`classifyItem`'s fallback branch already uses ("never manufacture surprise decisions" /
"never silently drop").

**Characterization-tested:** golden-report → golden-lanes fixtures, one per `kind`/`confidence`
combination that exists today, plus one adversarial fixture asserting the throw on an
unrecognized `kind` (protects against a future Phase-C addition landing without updating this
adapter).

### Seam 2 — `salienceOf(decision, blastRadiusIndex) -> { rank: 0|1|2, reason }`

**File:** `src/ingest/salience.js` (new, pure, unit-tested — same discipline as
`buildSchedule`'s seeded-PRNG determinism requirement: same inputs, same rank, always).

**Signature:**
```js
// Pure, deterministic. rank 0 = highest salience (render largest/first-in-visual-weight
// within its lane), 2 = lowest. blastRadiusIndex is a plain object/Map built ONCE per
// report by buildBlastRadiusIndex (see gap below) and passed in — salienceOf itself does
// no counting, no graph walk, so it stays O(1) per call and trivially unit-testable in
// isolation from report-shape concerns.
export function salienceOf(decision, blastRadiusIndex) {
  // returns { rank, reason } — reason is a short machine string ('high-blast-radius' |
  // 'confirmed-change' | 'routine'), NOT the director-facing copy; the UI owns copy.
}
```

**Inputs to the 2–3 discrete ranks** (owner-locked: discrete, grayscale-recoverable, no
continuous score):
1. `decision.kind === 'confirm_change'` (a director's confirmed value is being overwritten) is
   always rank 0 — this is the one case where under-salience is a real trust cost, matching
   Phase C's "CHANGED always dominates" merge rule already encoding this as the highest-stakes
   kind.
2. Otherwise, `blastRadiusIndex` (downstream reference count — see gap below) × confidence tier
   collapse into rank 1 (referenced by ≥1 other entity AND confidence is `low`/`medium`) or
   rank 2 (no downstream references, or confidence would have made it `express` were it not for
   a merge). `resolve_conflict` decisions are exempt from this ranking — they already render in
   the `hold` lane unconditionally per seam 1 and do not need salience to be found.

**Gap identified — blast radius is NOT currently derivable from the report as-is.**
`report.decisions` carries `entity`/`entityId` but no downstream-reference count. The smallest
additive fix, logic-layer, test-first:

```js
// src/ingest/blastRadius.js (new). Pure, given planItems the report already receives.
// Counts, per (entity, entityId), how many OTHER plan items reference it — e.g. an
// activities row referenced by N anchor_activities/week_location_exclusions items, or a
// locations row referenced by N activities' resolveOrCreateLocationId. Built once per
// report call, O(planItems), no new DB read (planItems already carries entity_id
// references — resolveOrCreateLocationId's linkage is visible on the activities items
// buildPlan already emits).
export function buildBlastRadiusIndex(planItems) { /* -> Map<"entity:entityId", count> */ }
```
This is a pure function over data the dry-run already returns (`outcome.planItems`, threaded
into `buildReconciliationReport`'s `evidenceSupport`-style optional input) — **not** a UI
workaround, **not** a new DB query. `buildReconciliationReport` gains one more optional input
(`blastRadiusIndex`, defaulting to an empty Map, same additive-degradation contract
`fieldProvenance`/`evidenceSupport` already use) so the count can ride along on `decision`
objects as `decision.blastRadius: number` if the design wants it visible in the "why" disclosure
— Maker's call whether to expose it as a report field or keep it adapter-side; either is a small
addition, not a new source of truth, since it derives from `planItems` alone.

### Seam 3 — staged tray as the dry-run (no new plumbing)

**Confirmed against the real signature** (`electron/ops/ingest.js:489`):
```js
commitIngest(db, { approved, links, clears, humanEditedFields, camp_id, cohort_id,
  author_user_id, device_id, fixedEvents, activityRules, mode, resolutions,
  base_generation, dryRun })
```
`dryRun: true` already runs the full `commitPlan` transaction to completion and rolls back
(`ingest.js:1470`), returning the SAME `{ buckets, decisions, planItems, fieldProvenance,
legacyPriorityActivities }`-shaped inputs `buildReconciliationReport` consumes. **This is
already the dry-run/staged-tray mechanism the design needs — no new IPC method, no new mode
param on `commitIngest` itself.**

What threads the tray through it:
- Every triage action (tick an item into "approved," resolve a held conflict, edit a proposed
  value, un-tick) updates the SAME renderer-side `approved`/`resolutions`/`humanEditedFields`
  state `ImportScreen.jsx` already owns (lines ~147, ~168, ~197 today), then re-issues
  `commitIngest(..., dryRun: true)` with the updated payload. The IPC round-trip cost is
  identical to what `stageReconciliationSummary` (`ImportScreen.jsx:690`) already pays today —
  this is not a new call pattern, just a more frequent one (per triage action instead of once
  per gate transition).
- The response's `buckets`/`decisions` feed straight back into `reportToLanes` — buckets and the
  lane list are re-derived from a REAL re-run of the actual commit logic on every staging change,
  so a staged decision that would newly HOLD the commit (e.g. staging a value that collides with
  a concurrent import) surfaces truthfully in the next render, not from client-side guessing.
- **Debounce, not architecture:** to avoid re-running the dry-run on every keystroke of an
  edited value, the renderer debounces the re-issue (e.g. on blur / a few hundred ms of
  idle) — this is a UI performance concern for Maker, not a seam change; the tray's *truth* comes
  from re-running the real transaction, not from how eagerly it is re-run.
- The "Use this setup" / "Apply confirmed changes and keep the rest for review" final button is
  the FIRST `dryRun: false` call in the session — everything before it, however many staging
  iterations, never writes.

**No new plumbing required.** `mode`/`resolutions`/`approved` are all existing `commitIngest`
parameters already threaded from `ImportScreen.jsx`. The "staged-tray-as-dry-run" claim in R1 is
architecturally free given the current signature.

### Seam 4 — grace-window undo via compensating inverse ops

**This is the load-bearing risk — flag for Red Hat review explicitly (see Risks below).**

**Mechanism, not a blind restore:**

1. **Capture at commit time (one new flag, additive).** `commitPlan` gains an opt-in
   `captureInverse: boolean` param (default `false`, so every existing non-reconciliation caller
   of `commitPlan`/`commitIngest` — including the two other reconciliation-adjacent test suites —
   is byte-identical unless it opts in). When `true`, `commitPlan` wraps its internal `appendOp`
   calls (six call sites today, `ingest.js:84,125,876-877,975,1010,1449`) with a local
   `trackedAppendOp` closure that, for every op it actually writes in the real (non-dry-run,
   non-held) transaction, records `{ entity, entity_id, field, opId, seq, priorValue }` — where
   `priorValue` is the value read via the SAME `latestOp`-style lookup `commitPlan`'s existing
   protection/staleness gates already perform before each write (no new query, reusing what
   `isProtected`'s neighborhood already computes). This list becomes `outcome.invertibleOps[]`,
   returned alongside the existing `created`/`updated`/`fixedEvents` counts — additive to the
   outcome shape, nothing removed.
2. **Two inverse shapes, by whether the op created a new row or changed an existing one:**
   - A field op whose `entity_id` is the FIRST time that id appears in this commit's captured
     list (i.e. `priorValue` is "did not exist") is a **creation** — its inverse is a single
     `DELETE_FIELD` tombstone op on that `entity_id`, but ONLY if every other field this commit
     wrote for that same `entity_id` is still untouched (next point).
   - A field op with a real `priorValue` is an **update** — its inverse is a new `appendOp`
     restoring `priorValue`, `source: 'import'` (it is reverting to the pre-import state, which
     was itself import- or human-sourced; the restore op's own `source` mirrors whatever the
     `priorValue`'s original op carried, captured alongside it — not hardcoded to `'import'`).
3. **"Touched since" detection — the actual undo-time gate.** For every captured
   `{entity, entity_id, field, seq}`, undo re-queries the CURRENT latest op for that exact
   `(entity, entity_id, field)` triple (the same `latestOp` lookup, called fresh). If the current
   latest op's `seq` still equals the captured `seq`, nothing has written that field since this
   import — safe to invert. If it differs, some op (local or replicated from a peer) landed after
   import — **skip that field**, note it in the plain-language receipt ("kept: {name}'s {field},
   changed since import"). For a **creation** row, undo checks EVERY field captured for that
   `entity_id`: if any one field was touched since, the whole row is left alone (never a partial
   delete of a row someone has since edited) and reported as "kept: {name}, edited since import."
   This is a direct read of the op-log's own `seq` ordering — no wall-clock snapshot, no
   assumption that "nothing else happened" — so a concurrent write from a paired device between
   import and undo is provably never clobbered.
4. **Where the captured list lives during the grace window.** Per the owner's LOCKED decision
   (grace-window undo, NOT a durable synced entity in v1), `outcome.invertibleOps[]` is held in
   renderer memory only (a `useState`/ref in the screen or a small hook), scoped to the current
   session, expiring on navigation away from the screen or after a fixed grace window (Designer's
   call on the exact duration/UI, not this ADR's). If the app closes or the renderer reloads
   before undo is used, the window is simply gone — consistent with "grace-window," not "durable
   audit trail." No new table, no new IPC method for storage; undo itself is a NEW, narrow IPC
   method (`ingestUndo(invertibleOps)` or folded into an existing ops channel — Maker's naming
   call) that re-runs the seq-check-and-invert loop server-side inside one transaction, so the
   undo write is itself atomic and appears as ordinary ops in the log (an undo IS an import,
   auditable the same way, just without its own persisted "this was an undo" marker in v1).
5. **The plain-language receipt** (R1 pillar 2, "truthful final button") is built from
   `invertibleOps` plus the skip list at undo time — a plain summary of what was reverted and
   what was intentionally left alone because it changed since — computed in the renderer from
   data already returned, not a new persisted artifact.

**Explicitly NOT v1:** a durable `reconciliation_runs`/`reconciliation_record` synced entity
that survives app restarts and gives a permanent "what did that import do" audit trail. The
owner locked this out of v1; `invertibleOps` capture at commit time is designed so that adding
such a table later is additive (the shape to persist already exists as `outcome.invertibleOps`)
— not a reason to build it now.

### Seam 5 — what `ImportScreen.jsx` code is deleted vs. retained

**Deleted:**
- `ReconciliationQueue.jsx` (439 lines) — self-documented as superseded by the Ledger per R0;
  its per-decision Q&A flow is subsumed by seam 1's lane rendering + inline resolution (R2′/R4′
  scope, not this ADR, but the deletion is a direct consequence of `reportToLanes` existing).
- The two-step held-conflict banner → `HeldResolution` takeover gate (`ImportScreen.jsx:997`) —
  collapses into the `hold` lane from seam 1; `resolve_conflict` decisions render inline in the
  same continuous surface instead of a separate modal takeover.
- The ~40-line post-commit banner and cross-region CTA wiring, replaced by the plain-language
  receipt from seam 4.
- `ReconciliationSummary.jsx`'s 4-bucket standalone view — its counts become the `spine` rows
  from seam 1, not a separate gated screen.

**Retained, unchanged:**
- The upload/parse/preview flow (lines ~131–690) — out of scope for this ADR; R0 does not flag
  it as bloat.
- `ReconciliationLedger.jsx` — R0 calls it "the real work"; its per-field diff rendering is very
  likely reusable as the `standard`/`changed`-lane card body rather than deleted outright, but
  that composition call belongs to Designer's spec, not this ADR.
- Every IPC call site (`ingestReconcile`, `ingestCommit`, `confirmAlias`, `list`, `getCamp`) —
  unchanged; this ADR adds zero new IPC surface except the narrow undo method in seam 4.
- Audit/fallback paths per the R0 handoff's §7/§23 constraints — must stay reachable; Designer's
  spec is the place that confirms exact reachability, this ADR only guarantees the underlying
  data (`buckets`, `decisions`, `readiness`) they depend on is untouched.

## PLATFORM_STATE.md refresh (build-in step, not a separate ticket)

R0 confirms `PLATFORM_STATE.md` (dated 2026-08-09) predates Facility/Location entirely — zero
mentions of `locations`, `resolveOrCreateLocationId`, or the M1–M6 program. Per this repo's
"docs = current state" discipline, the refresh ships as part of the R2′ implementation PR that
lands `reportToLanes`/`salienceOf` (not a standalone follow-up ticket, and not deferred past this
initiative): add a Locations/Facility section describing the `locations` table, its role as the
engine's capacity source, `week_location_exclusions`, and its ingestion integration
(`resolveOrCreateLocationId`, `locations` in `INGESTIBLE_ENTITIES`/`ALWAYS_SCANNED_ENTITIES`).
The `update-state` skill should run against this ADR's Consequences once R2′ merges.

## Invariants (structural enforcement, not intention)

1. **The UI is a pure projection.** `reportToLanes` and `salienceOf` are pure functions with no
   DB handle, no IPC call, no React state closed over — enforced the same way
   `buildReconciliationReport`'s module doc comment enforces it today (a lint/convention, backed
   by characterization tests that would fail on any hidden side effect surfacing as a snapshot
   mismatch). Any staging state the UI holds (`approved`, `resolutions`, `humanEditedFields`) is
   the SAME payload shape `commitIngest` already accepts — never a locally-invented shadow model
   with its own truthiness. The dry-run re-run (seam 3) is what keeps this invariant load-bearing
   rather than aspirational: the UI cannot render a lane state the real commit path disagrees
   with, because the real commit path is what produced it.
2. **Salience never reorders truth.** `salienceOf` returns a rendering hint (`rank`) consumed
   only by CSS/layout weight; lane membership and in-lane order come from `reportToLanes`
   alone, which orders by the report's own walk order. This is what makes "reads as a plain
   sorted checklist with visuals off" a testable acceptance criterion rather than a design
   aspiration — turning off the salience CSS layer literally cannot change which decision
   appears where.
3. **Undo never blind-restores.** Every inverse write is gated by a fresh op-seq comparison at
   undo time, per field, per entity. No inverse op is ever written from a stale in-memory
   snapshot.

## Consequences

- `src/ingest/reportToLanes.js`, `src/ingest/salience.js`, `src/ingest/blastRadius.js` — new,
  pure, unit/characterization-tested modules alongside `reconciliationReport.js`.
- `buildReconciliationReport` gains one new optional input (`blastRadiusIndex`), additive,
  degrades safely when omitted (same contract as `fieldProvenance`/`evidenceSupport`).
- `commitPlan`/`commitIngest` gain one new optional flag (`captureInverse`), additive, default
  `false`, zero behavior change for every existing caller that doesn't pass it.
- One new narrow IPC method for undo (naming/exact shape is Maker's call within this ADR's
  mechanism).
- `ReconciliationQueue.jsx` and the held-conflict modal gate are deleted; `ReconciliationSummary`
  collapses into the spine.
- `PLATFORM_STATE.md` gains a Locations/Facility section as part of the same implementation PR.
- Follow-on (explicitly NOT this ADR's scope): a durable synced `reconciliation_runs` entity for
  permanent audit trail, and wiring `decision.blastRadius` into a "why" evidence disclosure UI
  string (the count exists after this ADR; the copy/disclosure design is Designer's).

## Known v1 limitation (accepted at R2′a, 2026-08-17 — recorded here, not a separate ticket)

`buildBlastRadiusIndex` counts only the FK-shaped references that are actually visible on
`planItems` without a DB read: `activities.location → locations` and
`activities.eligible_groups → groups`. `anchor_activities` and `week_location_exclusions`
references (named as blast-radius examples in Seam 2's prose) are NOT `INGESTIBLE_ENTITIES`, never
appear in `planItems`, and counting them would require the DB read this seam forbids — so blast
radius is an UNDERCOUNT. `salienceOf` degrades gracefully: when blast radius is ~0 for everything,
ranking falls back to confidence-tier only (the pre-ADR behavior) — no crash, no mis-rank, just a
weaker "readiness-demand" signal than the "40 scheduled slots" example implied. Honestly documented
in `blastRadius.js`. Closing this later means materializing those references into DB-agnostic
plan-item-shaped data — tracked as a future refinement, not a blocker for the one-screen experience.

`readinessGreen` was hardened at R2′a: `buildReconciliationReport` now additively exposes
`report.readiness` (raw rows from `getReadiness()`, shape `{key,label,screen,kind,state,message?}`),
and `reportToLanes` computes `readinessGreen = lanes empty AND every kind:'required' row is
state:'ready'` — two independent signals, so a "done" state can never claim buildability a required
gap contradicts.

## Risks — flag for Red Hat

1. **Compensating-inverse undo (seam 4) is the one genuinely new correctness surface this ADR
   introduces.** Specifically worth adversarial review: (a) the "touched since" seq comparison
   assumes `latestOp` for a given `(entity, entity_id, field)` is a total order by `seq` alone —
   confirm this holds under the sync path's op application order, not just the local-write path;
   (b) the creation-inverse's "any field touched → skip whole row" rule needs to be checked
   against `DELETE_FIELD`'s existing projection semantics (`operations.js:6-20`) — does deleting
   a row that another device is mid-edit-of via a still-in-flight op produce a sensible outcome,
   or a new conflict-shaped surprise the existing `conflicts` table doesn't expect from an undo
   caller; (c) the grace-window's in-memory-only storage means a renderer reload during the
   window silently forfeits undo — confirm the UX communicates this honestly rather than implying
   durability it doesn't have.
2. **`captureInverse`'s `trackedAppendOp` wrapper touches six call sites inside `commitPlan`** —
   a mechanical but real risk of missing one (e.g. the `replaceScope` teardown path noted in the
   module doc as "the only other appendOp caller reachable from here") and silently under-
   capturing invertible ops for replace-mode commits. Maker should characterization-test that
   `invertibleOps.length` matches the real op count for both `add` and `replace` mode commits.
3. **Debounced dry-run re-issue (seam 3) is a performance/UX concern, not correctness** — but a
   too-eager debounce that lets a stale dry-run response render after a newer one was issued
   (an out-of-order IPC response) would show a truthful-looking but stale lane state. Maker needs
   a request-generation guard (last-issued-wins), not just a debounce.

## Test strategy

- `reportToLanes`: golden-report → golden-lanes characterization fixtures, one per
  `kind`/`confidence` combination in current use, plus the unrecognized-`kind` throw case.
- `salienceOf`: pure unit tests over synthetic `(decision, blastRadiusIndex)` inputs — table-
  driven, asserting discrete rank boundaries, no report-shape dependency.
- `buildBlastRadiusIndex`: unit tests over synthetic `planItems` arrays, including the
  `locations` cross-reference case (M4/M5's `resolveOrCreateLocationId` linkage).
- Seam 3 (staged tray): behavior-level test reusing the existing dry-run test harness —
  assert that two consecutive `dryRun: true` calls with different `approved` payloads never
  write, and that the SAME transaction path (not a client mock) produced both responses.
- Seam 4 (undo): the load-bearing test class per the R0 handoff's behavior-level testing
  discipline (§23) — a concurrent-write scenario test: commit an import, have a SECOND
  simulated device write a field the import also touched (bump its `seq` past the captured
  one), then run undo and assert (a) the concurrently-touched field is NOT reverted, (b) every
  other field IS reverted, (c) the skip is reported. This is the test that proves invariant 3,
  not just documents it.
- Golden-ops parity: extend the existing golden-ops characterization test (referenced in
  `commitIngest`'s doc comment) to cover `captureInverse: true` producing byte-identical writes
  to `captureInverse: false` — the flag must never change what gets written, only what gets
  additionally returned.

## Open questions for Governor

1. **Undo IPC method naming/placement** — new dedicated channel vs. folding into an existing
   `write`/`ingestCommit`-adjacent surface. Technical either way; naming convention is a Governor/
   Maker-brief call, not an architecture decision.
2. **Grace-window duration and exact expiry trigger** (fixed timer vs. navigation-away vs. both)
   is a product/UX decision for Designer's spec, not this ADR — the mechanism in seam 4 works
   under any duration since the safety property comes from the seq check, not from window length.
3. **Whether `decision.blastRadius` is exposed as a `buildReconciliationReport` output field or
   kept adapter-side inside `salienceOf`'s caller** — both are small and correct; Governor should
   pick based on whether the "why" evidence disclosure (R0 gap #4 territory) wants it visible
   outside the lanes adapter. Recommend: expose it on the report (one more optional field,
   same additive pattern as `evidence`) since the "why" disclosure is named in this initiative's
   scope and a second consumer wanting blast radius later shouldn't have to re-derive it.
