---
title: "Ingestion Reconciliation — R0 current-state audit"
document_type: discovery
status: complete
created: 2026-08-17
date: 2026-08-17
phase: R0
initiative: ingestion-reconciliation-one-screen
audited_against: origin/main @ b693e98
---

# R0 — Current-state audit (read-only)

Audit for the "Final Ingestion Reconciliation / One-Screen Experience" project.
Two read-only architect audits run against current `main` (`b693e98`), reconciling
the shipped code against the founding brief, the semantics ADR, and the
`docs/work/onboarding-reconciliation/` doc set. No code changed.

## Headline

**This is a presentation/composition problem, not a plumbing problem.** The entire
reconciliation logic layer — parse → plan → dry-run → summary buckets → decisions →
resolution write path — already exists and is wired end-to-end through real IPC.
Facility/Location (M1–M6) is shipped and *already* integrated into ingestion. The
one-screen experience is largely a render-tree rewrite of `ImportScreen.jsx` with
**no new backend/IPC/schema implied.**

## §19 fifteen questions

- **Q1 (inventory):** Parsing, plan construction, aliases (host-local S1b),
  identity tiers, evidence/provenance, hand-edit protection, changed-vs-uncertain,
  fixed-event reconciliation, dry-run, decision generation, held/partial resolution
  — all exist and wired.
- **Q2 wired:** All reconciliation UI renders off real IPC (`ingestReconcile`,
  `ingestCommit`, `confirmAlias`, `list`, `getCamp`) and the pure
  `buildReconciliationReport`.
- **Q3 mockup-only:** None. `mockShoresh` is the no-Electron dev shim mirroring the
  real surface, not a UI fixture. `ReconciliationQueue.jsx` is built-but-sidelined
  (self-documented as superseded by the Ledger).
- **Q4 stale plans:** "location exclusion not reachable from import" is stale (M4/M5
  shipped). `PLATFORM_STATE.md` (2026-08-09) predates Facility/Location entirely.
  Import Ledger Convergence confirmed superseded.
- **Q5 summary inputs:** `buildReconciliationReport(input)`
  (`src/ingest/reconciliationReport.js:304`), pure fn consuming the dry-run outcome.
  Output `{buckets, decisions, meta}`. All four categories (UNDERSTOOD / NEEDS
  ATTENTION / CHANGED / NOT IN THIS SOURCE) are real computed keys.
- **Q6 dry-run parity:** SAME code path. `commitIngest`→`commitPlan` identical for
  both; dry-run differs by one terminal rollback throw (`ingest.js:1466-1471`).
- **Q7 decision representation:** Decisions are a computed projection, never
  persisted. Persistence = `source_aliases` + op-log `source` + `import_evidence`.
- **Q8 resolution write path:** `commitInputsWithResolutions` → `applyResolutions`
  → real commit (`dryRun:false`) → `appendOp`; aliases via `confirmAlias`.
- **Q9 held/protected:** `isProtected = latest.source !== 'import'`
  (`ingest.js:1119`); protected fields reject into conflicts/HELD or force-classify
  as `changed`.
- **Q10 changed vs unknown:** Distinct by construction — four independent counters
  in one classification pass "so they cannot drift apart"; `mergeDecisions` prevents
  a `confirm_change` being downgraded to uncertain.
- **Q11 facility seam:** Already wired. `locations` ∈ `INGESTIBLE_ENTITIES` +
  `ALWAYS_SCANNED_ENTITIES` (excluded from Replace wipe); `resolveOrCreateLocationId`
  during activity commit; ordering guarantees location live before activity resolves;
  5 ADR invariants test-pinned. Mapping: Facility truth = `locations` row;
  Program use = `activities.location_id` + `week_location_exclusions`; Source
  evidence = `import_evidence`.
- **Q12 minimal projection:** `report.buckets`, `report.decisions`, readiness rows,
  ledger rows (New/Updated/Unchanged/Clear/Conflict + field diffs), queue decisions.
  Shape already compact.
- **Q13 deletable:** `ReconciliationQueue.jsx` (439 lines), the two-step held-conflict
  gate, the ~40-line post-commit banner, cross-region CTA wiring.
- **Q14 legacy-priority:** Already corrected. No auto-apply of manufactured
  priorities (ADR `2026-08-10-legacy-import-priority-backfill`); now one consolidated
  `review_legacy_priority` flag with `proposedValue: null`. No wizard risk.
- **Q15 smallest path:** Reuse all backend as-is; fold candidate-ticking + held
  resolution + ledger + commit into one continuous view; retire `ReconciliationQueue`.

## Stale assumptions found

1. **OBSERVED/INFERRED/CONFIRMED/UNKNOWN vocabulary does not exist in code.** Real
   vocabulary = `CONFIDENCE.HIGH/MEDIUM/LOW` + identity tiers + `human`/`import`
   provenance. UI must translate at the presentation layer, not assume 1:1.
2. **`PLATFORM_STATE.md` predates Facility/Location** — refresh needed (folded into
   this plan, not a standalone ticket).
3. **`notInSource` only covers `readiness.state === 'optional'`** — deliberate v1
   narrowing; broader scope is a small logic-layer change if the design needs it.
4. **`locations` is not an evidenced `entity_type`** (only activities/anchors are).
   Capacity provenance trail is a real small gap if the design wants "why capacity 3?"

## Current IA (what a director traverses today)

`ImportScreen.jsx` (~1998 lines, ~25 useState) is nominally one screen but gates
through ~6 sequential states: upload → per-entity ticking → held-conflict banner +
`HeldResolution` takeover → `ReconciliationSummary` (4 buckets) → `ReconciliationQueue`
(per-decision Q&A, sidelined) → `ReconciliationLedger` (the real work + Commit) →
post-commit banner. Bloat is in the number of gated sub-views, not the projection.

## Visual language (for design consistency)

Tokens `src/index.css:4-29` (`--bg #F4F3EF`, `--primary #173B63`, `--secondary
#2F6B58`, `--accent #B8833A`, etc.; `--warning`/`--purple` deprecated). Inline-style
`S` convention (`src/styles/shared.js`) + `useEnterTransition` variants. Scoped-CSS
exception is `scheduleGrid.css`; note `locationMap.css` as a second scoped sheet
outside the documented boundary (doc drift, separate concern). `DESIGN_STANDARD.md`
current and cited. DEV badge at `Sidebar.jsx:241`.

## Revised slice sequence (evidence-driven)

R1/R2 collapse because the view-model already exists.

- **R1′** — Design + ADR: one-continuous-surface IA, progressive disclosure, and the
  vocabulary-translation map. Live ImportScreen audit by design agents. *(Includes
  the PLATFORM_STATE Locations refresh as a build-in step.)*
- **R2′** — Compose the single surface; retire `ReconciliationQueue`, collapse the
  held-conflict gate.
- **R3′** — Drill-down/filtering (state ⇄ domain projections over the same report).
- **R4′** — Wire decision resolution inline.
- **R5′** — CHANGED-state comprehensibility (provenance-legible, not Accept/Reject).
- **R6′** — Facility honesty pass (absence-as-absence; optional evidence gap #4).
- **R7′** — Legacy/edge (likely trivial given Q14).
- **R8′** — Mandatory compression pass (§22).
- **R9′** — Roots visual language, only if it earns its complexity.

## Gate note

Per §19, no implementation begins until the R1′ design/ADR clears the review loop.
