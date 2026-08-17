---
title: "Ingestion Reconciliation — R1′ gate outcome (spec + ADR + Red Hat)"
document_type: discovery
status: complete
created: 2026-08-17
date: 2026-08-17
phase: R1-gate
initiative: ingestion-reconciliation-one-screen
---

# R1′ gate outcome

## Artifacts produced
- Design spec: `docs/work/specs/2026-08-17-reconciliation-onescreen-design.md` + prototype
  `2026-08-17-reconciliation-onescreen-mockup.html` (Camp Kinneret, 482 rows → 6 decisions).
- ADR: `docs/adr/2026-08-17-onescreen-reconciliation-projection.md`.

## Adversarial review (Red Hat) — grace-window undo (Seam 4)
Resilience **2/5**. Three HIGH gaps, all isolated to Seam 4 (undo); Seams 1–3 clean:
1. HIGH — Replace-mode undo → empty schedule (`replaceScope` tombstones not invertible by the
   two-shape mechanism, not wrappable as the ADR claimed; no inverse shape for a deletion).
2. HIGH — creation-row "touched since" gate only checks import-written fields → a human filling a
   blank the import left empty (e.g. location_id) is invisible → whole-row delete + silent loss.
3. HIGH — no cross-entity referential check → undo can orphan a FK (delete "Lake" while keeping an
   edited "Kayaking").
4. MEDIUM — device-local `seq` vs `COALESCE(host_seq, seq)` landmine; needs an explicit invariant.
5. Edge cases — double-undo receipt wording; where `invertibleOps` lives (wants a 4th invariant);
   second-import-during-grace-window (recommend one live window at a time).

## Owner decision (2026-08-17): DECOUPLE
- **Seams 1–3 + 5 ACCEPTED** — the one-screen core (`reportToLanes`, `salienceOf` +
  `buildBlastRadiusIndex`, staged-tray-as-dry-run, deletions of `ReconciliationQueue`/held-takeover/
  post-commit banner/`ReconciliationSummary` standalone). Sound; staged tray is the v1 safety net.
- **Seam 4 (undo) SPLIT OUT** into its own later slice. Requires an Architect revision (Red Hat
  fixes 1–4 above + the two structural additions) AND a second Red Hat pass BEFORE any undo code.
  R2′ ships the receipt panel WITHOUT the undo button/timer.
- Governor resolved ADR open-question #3: expose `decision.blastRadius` on the report output
  (the "why" disclosure will want it). #1 (undo IPC naming) and #2 (grace duration) are
  implementation/undo-slice details, not blockers.

## Next
R2′ implementation of the accepted core, test-first, on this worktree. PLATFORM_STATE Locations/
Facility refresh ships in the R2′ PR (not a separate ticket). Undo slice scheduled after R2′.
