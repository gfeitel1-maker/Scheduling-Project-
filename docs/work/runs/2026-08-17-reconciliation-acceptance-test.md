---
title: "Ingestion Reconciliation — acceptance test on a real prior-year workbook"
document_type: discovery
status: complete
created: 2026-08-17
date: 2026-08-17
phase: acceptance
initiative: ingestion-reconciliation-one-screen
---

# Acceptance test — real prior-year workbook

Harness: `scratchpad/reconcile-acceptance.mjs` (headless, drives the real pipeline:
workbook → workbookToPages → extract/preview/inferFixedEvents/inferActivityRules →
buildCommitInputs → commitIngest(dryRun) → getReadiness + buildBlastRadiusIndex →
buildReconciliationReport → reportToLanes). Source: `scratchpad/prior-year.xlsx` — a real
14-sheet camp workbook (one page per group; Yeladim/Tzofim/Chalutzim/Alufim/Giborim/CITs).

## Core metric — VALIDATED
| State | facts parsed | director judgments (hold+standard) |
|---|---|---|
| Empty-camp onboarding | 118 entity facts (930 w/ cells) | **0** |
| Tick everything | 118 | **0** |
| Clean re-import | 118 | **0** |
| Changed (moved an anchor) | 118 | **1** (genuine CHANGED) |

Compression is decisive: 118 facts → 0 forced reconciliation decisions; the screen is a
receipt for a clean import; CHANGED surfaces distinctly when real. No crash, no wrong count,
no dishonesty on real data. `readinessGreen=false` in every state — correctly, because the
required Units area is `missing` (this layout has no unit column → 0 tiers), not because of
decisions.

## Findings (the R8′ agenda)

**F1 (significant — product/design).** For a clean import the director's real involvement is
the UPSTREAM preview/ticking step (still the old ~1263-line ImportScreen: seen-once activities
start unticked). Those low-confidence exclusions happen there and NEVER surface in the
reconciliation workspace. So onboarding is two stages (pick-to-import → reconcile) with the
reconciliation screen a receipt — in tension with the brief's "one workspace, not step 1 of 7."
Options: (A) fold the ticking into the reconciliation workspace (fuller vision, large); (B)
surface the set-aside low-confidence items inside the workspace ("we set N aside — review?") so
nothing is silently dropped and the real decision appears where the director looks (balanced);
(C) accept two-stage, just fix F2/F3. Governor recommendation: B, with A as the future fuller
option. Decision belongs to owner at the design-review gate.

**F2 (fix).** The moved-anchor `confirm_change` card is thin — `field=null`,
`proposedValue=null` (the fixed-event moved path carries only a reason string) — so it can't
show "from → to," only prose. CHANGED on the raw-schedule path is also narrow: reachable
essentially only via the moved-anchor signal (field-value CHANGED comes via the S4b enrichment
workbook, not the schedule re-import).

**F3 (fix — honesty).** A genuine required gap (Units missing) makes the screen read "0 things
to review" AND "not ready to build" at once, reconciled only by the easily-missed readiness
strip. A required gap should surface as an attention item, not hide behind a flag.

**R6′ note.** This workbook references NO locations (no location column) — the pipeline honestly
mints/proposes nothing (no fabrication). R6′ (facility evidence honesty) cannot be exercised by
this file; it needs a location-bearing source, or R6′ stays design-only until one exists.

**R7′ note.** No legacy-priority cards surfaced for this file; legacy-priority is already the
consolidated `review_legacy_priority` flag. R7′ is likely near-empty.

## STATE A re-import "crash" — investigated and resolved (2026-08-17, during the one-workspace merge gate)

During the one-workspace merge's consolidated gate, Verifier reproduced a crash on the harness's
STATE A (clean re-import): `SqliteError: UNIQUE constraint failed: groups.camp_id, groups.name` at
`electron/ops/projections.js:598`, preceded by 120+ `applyProjection: rejected camp_id write`
messages. Red Hat ran the same harness twice and got a clean pass — a genuine conflict that had to
be settled, not hand-waved.

**Root cause (harness bug, NOT an app regression):** `scratchpad/reconcile-acceptance.mjs`'s
`seedCamp(dir, name)` opened `shoresh.sqlite` inside the SAME shared tmp dir for every camp (E and
E2), so two camps' data landed in one device db. The single-camp-per-device-db invariant then made
`applyProjection`'s guard reject every write belonging to whichever camp was not the `SELECT ...
LIMIT 1` camp (the 120+ "rejected camp_id write"), and the re-import then collided on
`UNIQUE(camp_id, name)`. Fixed by giving each `seedCamp` call its own `mkdtempSync` subdirectory;
STATE A/C then run clean, exit 0. The intermittency (Verifier crash vs Red Hat clean) is consistent
with order-dependent shared-db contention.

**Corroborated on the REAL app path (the load-bearing evidence):** integration scenario 21 section
(e) ("importing the same file twice adds nothing") was rewritten off the deleted `buildPreview` and
re-imports the full proposal a second time against the same db/camp, asserting zero duplicate
creates (only the deliberately-rejected group grows by 1), with no UNIQUE-constraint throw. It
passes (`npm run test:integration` 25/25). **Re-import recognize-existing works correctly in the
app; the crash was confined to the acceptance harness.** This is the deterministic proof; the
harness-root-cause above is the corroborating explanation.

## Reshaped remaining work
R3′/R4′/R5′ effectively shipped in R2′b. Remaining = an R8′ "workspace honesty + compression"
pass driven by F1/F2/F3 (design-first), R6′ gated on location-bearing test data, R7′ likely
trivial. Undo and R9′ Roots remain their own gated slices.
