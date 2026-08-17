---
title: Ingestion/reconciliation architecture audit 2026-08-17
document_type: architecture-report
authority: descriptive
status: active
date: 2026-08-17
---

Full report: `docs/work/architecture-reports/2026-08-17-ingestion-reconciliation-audit.html`. Read-only pass over the ingestion/reconciliation subsystem at HEAD `d412fdb`. Verdict: structurally healthy — the pure decision/projection spine (`buildPlan`, `buildReconciliationReport`, `reportToLanes`, renderer triage models) is a benchmark alongside the schedule engine; debt is concentrated in one large write function and one god component.

- **C1 (high leverage, no overlap):** Extract the inline fixed-event ingest — anchor recognition, the read-only move-drift cardinality pre-pass, scope-drift, and the write loop (`electron/ops/ingest.js:1247–1461`) — out of the ~650-line `commitPlan` into a pure `anchorReconcile` module, so its subtlest logic becomes directly testable.
- **C2 (high leverage, MAY OVERLAP active initiative):** Extract an import-session model out of `src/screens/ImportScreen.jsx` (1,263 lines) — its parse-stage orchestration and ~26 state atoms never got the model extraction its reconciliation-stage sibling (`reconciliationTriage.js` et al.) did; reconcile scope with the in-flight one-screen redesign first.
- **C3 (medium leverage, no overlap):** Make `commitPlan`'s implicit decide-phase (classify each plan item into create/update/conflict, no writes) a structural pure seam so the Policy-A protection gate and base-generation staleness clock in `decideFieldItem` can be unit-tested without a DB transaction.
- **C4 (medium leverage, no overlap):** Single-source the recognition/cohort-scoping rule duplicated between `buildExistingSnapshot` and `seedRecognitionMaps` (`electron/ops/ingest.js:650`), where a hand-maintained "cannot disagree" comment currently stands in for a shared function.
- **Not debt:** the dry-run-as-preview seam (`ingestReconcile` reusing the real `commitPlan` transaction) and the renderer-side pure `buildReconciliationReport` are correct, protect-them positives — no SQL or IPC leaks into the renderer.
