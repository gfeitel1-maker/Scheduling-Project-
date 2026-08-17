---
title: "Ingestion Reconciliation — R1 design divergence + convergence"
document_type: discovery
status: complete
created: 2026-08-17
date: 2026-08-17
phase: R1-diverge
initiative: ingestion-reconciliation-one-screen
---

# R1′ — One-screen reconciliation: design divergence

Ran `/adhd` divergence (5 isolated frames × 6 ideas = 30) then converged. Frames:
regulator, logistics, 10-year-old, 3am-on-call, biology.

## Converged architecture (one screen)

> A calm page that names the few. One shrinking triage lane, ordered by what the
> camp needs first, filterable by domain. Understood is digested and silent; the few
> live items carry discrete blast-radius salience. Resolving happens inline into a
> staged tray that IS the existing dry-run; one truthful button flips it to an
> undoable reconciliation-of-record.

Three pillars, all pure projections or the existing transactional path — never a
second source of truth:

1. **Triage-lane-to-zero** — interaction spine. Understood → silent one-line receipt.
   Cards in readiness-demand order. By-domain = filter chip over the same lane, not a
   second inbox. Done = list empty AND readiness green.
2. **Staged tray + reversible receipt** — decide ≠ apply. Tray = dry-run
   (rollback-not-yet-flipped) so buckets/readiness stay truthful for free. Truthful
   final button ("Use this setup" / "Apply confirmed changes and keep the rest for
   review"). Applying writes a plain-language reconciliation-of-record.
3. **Salience-driven compression** (★ non-obvious core) — restrained visual layer over
   a boring list. Salience = discrete 2–3 ranks by blast radius, grayscale-recoverable.
   NOT-IN-SOURCE = honestly-empty dashed gap, never a hot item.

## Three binding invariants (from the deepen phase)

1. The screen is a PURE PROJECTION over `buildReconciliationReport` + the existing
   dry-run/commit path — never a second source of truth. (All three pillars'
   load-bearing risk collapses to this.)
2. Salience is discrete (2–3 ranks), deterministic (`salienceOf(decision)`,
   unit-tested like the engine), and fully grayscale-recoverable.
3. Decide ≠ apply; the final act is truthfully labeled and undoable via COMPENSATING
   INVERSE OPS that skip entities touched since import (not a blind restore) — safe in
   a local-first synced op-log.

## Owner decisions (2026-08-17, LOCKED)

- **Salience layer:** Restrained, list-first. Salience = spacing + one accent + card
  scale + order. Roots metaphor at most a faint margin spine, behind a kill-switch;
  "reads as a plain sorted checklist with visuals off" is an acceptance test.
- **Primary lens:** By-state first (triage lane on load); Structure/Scheduling/Time/
  Facility as filter chips over the same report.
- **Undo scope:** Grace-window whole-import undo via compensating inverse ops +
  plain-language receipt. (NOT a durable synced reconciliation-record entity in v1 —
  that is a possible follow-on.)

## Provocation (carried, not v1 scope)

Re-import from a known source becomes almost-entirely express via a director-set trust
threshold — year-two onboarding is 3 cards, not 60. Reframes the feature from
"import wizard" to the camp's standing "absorb a new source" surface.

## Next (R1′ deliverables, gated before any code)

- Designer: design spec + prototype + animation notes for the one-screen experience
  under the locked decisions.
- Architect: ADR for the projection/adapter seam (`reportToLanes`, `salienceOf`,
  staged-tray-as-dry-run, compensating-inverse undo) + PLATFORM_STATE refresh plan.
- Both reviewed through the quality loop before R2′ implementation begins.
