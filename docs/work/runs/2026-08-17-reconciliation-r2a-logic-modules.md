---
title: "Ingestion Reconciliation — R2′a run record (pure projection modules)"
document_type: discovery
status: complete
created: 2026-08-17
date: 2026-08-17
phase: R2a
initiative: ingestion-reconciliation-one-screen
---

# R2′a — pure projection modules (logic layer, no UI)

## Shipped (worktree, not committed)
- `src/ingest/blastRadius.js` + test — `buildBlastRadiusIndex(planItems)` (pure; counts
  activities→locations, activities→groups; documented undercount for anchor/week-location refs).
- `src/ingest/salience.js` + test — `salienceOf(decision, blastRadiusIndex) → {rank, reason}`
  (pure, deterministic, discrete ranks; resolve_conflict → rank 0 'held-conflict').
- `src/ingest/reportToLanes.js` + test — `reportToLanes(report) → {express, standard, hold, spine,
  readinessGreen}` (pure; lane order = report walk order; exhaustiveness throw on unknown kind;
  honest `readinessGreen` = lanes empty AND every required readiness area ready).
- `src/ingest/reconciliationReport.js` (modified) — additive `blastRadiusIndex` input +
  `decision.blastRadius` field + additive `report.readiness` output. Byte-identical when inputs
  omitted (proven by whole-object test).

## Gate (independently re-run by Code Reviewer)
- `npx vitest run --no-file-parallelism` on the four files → **107 passed**.
- `npm run lint` → **0 errors** (16 pre-existing unrelated warnings).

## Review
Code Reviewer verdict **Ready**. Purity confirmed by grep; "salience never reorders truth"
invariant holds structurally (reportToLanes never imports salienceOf); exhaustiveness throw
present + tested; additive byte-identity a real regression guard. Two Maker divergences judged
legitimate v1 interims; the one must-fix-before-UI item (dishonest readinessGreen) was closed in
the closeout pass. Two LOW/MEDIUM doc-guard nits added as comments.

## Accepted v1 limitation
Blast-radius undercount (anchor_activities / week_location_exclusions not counted — would need a DB
read the seam forbids). Recorded in the ADR's "Known v1 limitation" section; NOT a separate ticket.
salienceOf degrades to confidence-tier ranking, no crash/mis-rank.

## Next
R2′b — `<ReconciliationScreen>` composing the one continuous surface per the design spec (header
spine, understood receipt, filter chips, two-rank triage lane, not-in-source gap, staged tray with
the two truthful buttons, receipt panel WITHOUT the undo button) + staged-tray-as-dry-run wiring
(last-issued-wins guard) + deletions (ReconciliationQueue/held-takeover/post-commit banner/
ReconciliationSummary standalone, after confirming commitInputsWithResolutions covers their shapes)
+ PLATFORM_STATE Locations/Facility refresh. Then full quality loop (Verifier/Tester/Grader) before
merge. Undo slice remains gated after R2′.
