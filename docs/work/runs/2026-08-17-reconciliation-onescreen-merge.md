---
task: "One-workspace merge (Option A) — fold the upstream ticking step into the reconciliation workspace; low-confidence creates + fixed events become decisions; F2 from→to; F3 required-gap cards; gauntlet compression"
document_type: run
date: 2026-08-17
round: 2
status: pass
task_class: ui-ux-design
verdict: pass
selected_agents: [governor, architect, designer, maker, code-reviewer, verifier, tester, red-hat, grader]
omitted_agents:
  - agent: security
    reason: not-applicable
    note: renderer + report-layer composition over unchanged IPC contracts; the one guard-adjacent change (excluding anchor_activities from the approved whitelist filter) was Red-Hat-verified to admit nothing illegitimate; no auth/PIN/secret/LAN-protocol/packaging change
deterministic_checks:
  - "npm run lint → 0 errors (16 pre-existing unrelated warnings)"
  - "npx vitest run --no-file-parallelism (full suite) → green (0 net regressions vs baseline; the 1 remaining failure is electron/sync/syncServer.test.js, a confirmed-flaky WebSocket-timing test, also failing pre-existing on main)"
  - "npm run test:integration → 25/25 (incl. rewritten scenario 21, the re-import oracle)"
  - "npm run check:governance → clean"
  - "node scratchpad/reconcile-acceptance.mjs → clean through STATE A/C; STATE E onboarding 118 facts → 8 judgments (14.8:1)"
human_gates:
  - "Owner chose Option A (fold ticking into workspace) over Option B (surface set-aside), 2026-08-17"
  - "Owner accepted the F3 READY TO BUILD? label exception, 2026-08-17"
  - "Owner chose fold-the-gauntlet-fix-then-merge, 2026-08-17"
completion_evidence:
  - "docs/work/runs/gate-reports/reconciliation-onescreen-merge-r1.json (Grader PASS_ELIGIBLE, overall 4.5, lowest 4)"
  - "Red Hat re-check Resilience 4.5 (RISK 1 closed with e2e proof + a latent hold-back crash fixed); Code Reviewer 5; Tester 3→4 (HIGH finding was Option-B spec-confusion, not a defect)"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-17-onescreen-reconciliation-merge.md, docs/adr/2026-08-17-onescreen-reconciliation-projection.md]
related_specs: [docs/work/specs/2026-08-17-reconciliation-onescreen-design.md, docs/work/specs/2026-08-17-reconciliation-r8-honesty-compression-design.md]
related_runs: [docs/work/runs/2026-08-17-reconciliation-acceptance-test.md, docs/work/runs/2026-08-17-reconciliation-r2b-onescreen.md]
archive_when: "superseded by a later reconciliation run record, or the one-workspace flow is replaced"
---

# One-workspace merge (Option A)

## What shipped
Folded the upstream `ImportScreen` create/update/fixed-event ticking step into the reconciliation
workspace. `buildPlan` now stamps real confidence on creates (moving `looksLikeAMerge` out of
`preview.js`), so a low-confidence seen-once create becomes a `confirm_value` decision instead of
being silently unticked upstream; the existing `applyResolutions` hold-back gates it, and a new
symmetric fixed-event hold-back gates low-confidence fixed events. The tick UI is deleted; the
director lands in one workspace. Plus F2 (moved-anchor `from→to`), F3 (required setup gaps render
as `READY TO BUILD?` cards, with 2+ collapsed into one summary — the §22 gauntlet compression),
and the A1 day/time-block decision key so same-named anchors don't collapse.

## The metric (acceptance test, real 14-sheet workbook)
Empty-camp onboarding: 118 entity facts → 8 director judgments (3 "include?" + 5 required gaps),
14.8:1. Clean re-import → ~0. The genuine seen-once judgments now surface where the director looks
instead of defaulting away — MORE decisions, but the RIGHT ones, and compressed (gauntlet collapsed).

## Gate story (the loop earned its keep)
4 sub-slices (F3 → F2+A1 → creates/antechamber → fixed-event hold-back), each Maker-green in
isolation, THEN a consolidated whole-slice gate that caught what the subsets couldn't:
- Code Reviewer 5/5 (plan-aligned to the ADR + 5 binding Red Hat amendments; clean deletions; mock parity).
- Red Hat 2/5 → found **RISK 1** (a fully-resolved low-confidence fixed event wrote SILENTLY with no decision — the deleted `autoAccepts` guard) + the RED build.
- Verifier FAIL: 35 net-new test failures (obsolete tests asserting the deleted tick UI), test:integration broken (scenario 21 imported deleted `buildPreview`), stale index.
- Fix round: closed RISK 1 test-first; **found + fixed a latent commit-path crash** (unresolved `anchor_activities` polluted `approved` with a whitelist-rejected key → every fixed-event hold-back would have crashed end-to-end); rewrote the obsolete tests to the new flow (not deleted-to-green); rewrote scenario 21 off `buildPreview`.
- **STATE A re-import "crash" run to ground:** a harness bug (two camps sharing one sqlite dir → single-camp guard rejected writes), NOT an app regression — proven on the real app path by scenario 21 section (e) "import twice adds nothing". Documented in the acceptance-test run record.
- Red Hat re-check 4.5/5 (RISK 1 closed with e2e proof; commit-path fix sound). Tester 3/5 — its HIGH finding was Option-B spec-confusion (the set-aside mechanism that was deliberately not built); real finding was the required-gap gauntlet, now compressed.
- Grader PASS_ELIGIBLE 4.5.

## Deferred / next
R6′ facility honesty (needs a location-bearing source — this workbook has none); R7′ legacy (near-empty);
Undo slice (own gated slice, Red Hat found 3 HIGH gaps at design time); R9′ Roots (prototype-first brief).
