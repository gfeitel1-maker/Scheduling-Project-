---
task: T283: CI checks out full history and fails without origin/main; close T291 (superseded by #752) and T272 (wont-fix)
document_type: run
date: 2026-10-12
round: 1
status: pass
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T283-board-truth-audit-gate.md, docs/work/tickets/T291-data-relay-fallback.md, docs/work/tickets/T272-derived-id-stability-cannot-be-inferred-from-v.md, docs/work/tickets/T368-sigterm-during-slow-boot-exceeds-quit-bound.md, docs/work/tickets/T209-rendezvous-worker-phase-a.md, docs/work/tickets/T290-dcutr-holepunch.md]
related_specs: []
related_adrs: []
selected_agents: [maker, code-reviewer]
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: the keeper session (Artifact board review) held the goal and relayed owner rulings; no separate Governor pass for a governance-script slice.
  - agent: architect
    reason: not-applicable
    note: one pure function added beside checkStatusDrift in scripts/check-governance.js plus a checkout depth; no schema, sync or module-boundary change.
  - agent: designer
    reason: not-applicable
    note: no UI.
  - agent: verifier
    reason: not-applicable
    note: CI (gate.yml, full history) is the gate of record on PR #957; locally only scripts/check-governance.test.js ran, one file at a time under the keeper load throttle.
  - agent: tester
    reason: not-applicable
    note: no director-facing surface.
  - agent: security
    reason: not-applicable
    note: reads git log and ticket frontmatter only; no auth, IPC, secrets or transport.
  - agent: red-hat
    reason: not-applicable
    note: no stored data, op log, sync or migration touched.
  - agent: grader
    reason: not-applicable
    note: gate is Code Review plus CI per the keeper standing rule.
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - commit f17ea207
  - commit b75405fa
  - scripts/check-governance.test.js 92/92 (red first for checkMergedTicketStatus, the later-edit remedy, and the CI-missing-origin/main failure)
  - plant: CI=1 on a checkout of origin/main fires merged-ticket-status-unflipped on T209 (exit 1); CI=1 on a depth-1 clone fires merged-ticket-status-unchecked (exit 1); local depth-1 skips with a stderr line
  - full npm run verify is CI's job (gate of record) on PR #957 — not cited here to avoid self-invalidation
archive_when: PR #957 merged to main with CI green
---

# T283: CI checks out full history and fails without origin/main; close T291 (superseded by #752) and T272 (wont-fix)

## What shipped

- T283: CI checks out full history and fails without origin/main; close T291 (superseded by #752) and T272 (wont-fix)
- T283: main-side gate flags a merged ticket whose status never flipped; board truth (T368, T209, T290)

## Evidence

- commit f17ea207
- commit b75405fa
- CI gate.yml on PR #957 is the gate of record.

## Agents

Maker: this session. Code Review: the PR review gate. Every other agent is omitted with a reason in the frontmatter.
