---
task: "R7 — legacy-priority: verify handling in the one-workspace flow; render the batch decision meaningfully"
document_type: run
date: 2026-08-17
round: 1
status: pass
task_class: ui-ux-design
verdict: pass
selected_agents: [governor, maker]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no design/schema change; verified-existing handling + a one-card rendering fix
  - agent: designer
    reason: not-applicable
    note: renders data the decision already carries, in the existing card idiom
  - agent: verifier
    reason: not-applicable
    note: Governor ran the focused gate inline (rendering-only, one card)
  - agent: code-reviewer
    reason: not-applicable
    note: one-card rendering change, no logic/commit-path touch
  - agent: tester
    reason: not-applicable
    note: behavior-level component tests cover it; a running-app pass folds into the next UI milestone
  - agent: security
    reason: not-applicable
    note: no auth/secret/IPC/write-path change
  - agent: red-hat
    reason: not-applicable
    note: no stored-data/op-log/sync/migration change; resolution stays acknowledge-only (never writes)
  - agent: grader
    reason: not-applicable
    note: no conflicting reports to consolidate for a scoped rendering fix
deterministic_checks:
  - "npx vitest run --no-file-parallelism (ReconciliationScreen + reconciliationResolutions + reconciliationTriage + reconciliationReport) → 151 passed"
  - "npm run lint → 0 errors"
human_gates:
  - "Owner: R7 quick close, 2026-08-17"
completion_evidence:
  - "151 focused tests green; the acknowledge-only resolution proven to write no priority field (regex on the ingestCommit payload)"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-08-10-legacy-import-priority-backfill.md, docs/adr/2026-08-17-onescreen-reconciliation-merge.md]
related_runs: [docs/work/runs/2026-08-17-reconciliation-onescreen-merge.md]
archive_when: "superseded by a later reconciliation run record"
---

# R7 — legacy-priority (verify + render)

## Verify-first finding
Legacy-priority is already correctly modeled and carried into the one-workspace flow: a SINGLE
consolidated `review_legacy_priority` decision (`reconciliationReport.js:509-526`) — not a wizard
(satisfies handoff §14) — that is acknowledge-only and NEVER auto-clears (honoring the rejected
backfill decision, `2026-08-10-legacy-import-priority-backfill.md`). Wired end-to-end
(reportToLanes / applyResolutions `continue` / triage / render) and tested.

**But** the card was under-rendered: the decision carries `count`, `activities: [{entityId,name}]`,
and a clear `reason`, yet `entityName` is null so `questionFor` fell through to the generic path —
the card read "Review activity priority for 'this record'" with a bare Acknowledge button and no
body. The director acknowledged a batch they couldn't see.

## Fix (rendering only)
`questionFor` uses `decision.count` ("Review priority for N activities carried over from an earlier
import"); a new `LegacyPriorityBody` renders `decision.reason` + a disclosable list of the affected
activity names (reusing `useMaxHeightReveal`, no new stylesheet). The acknowledge-only resolution
and `applyResolutions`' `continue` are unchanged — it still writes nothing.

## Outcome
R7 CLOSED. Remaining initiative work: R6′ facility honesty (needs a location-bearing source),
the Undo slice (gated — Architect revision + 2nd Red Hat), R9′ Roots (prototype-first).
