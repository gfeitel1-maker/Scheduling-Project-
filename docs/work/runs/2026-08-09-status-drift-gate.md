---
task: T76+T77 — work-record status-drift commit gate
document_type: run
date: 2026-08-09
round: 2
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets:
  - docs/work/tickets/T76-status-drift-commit-gate.md
  - docs/work/tickets/T77-completion-reference-vocabulary.md
related_adrs:
  - docs/adr/2026-08-09-work-record-status-drift-prevention.md
related_specs: []
selected_agents: [governor, maker, verifier, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: architecture is already decided and product-owner-approved in the ADR being implemented
  - agent: designer
    reason: not-applicable
    note: no UI surface — a dev-time governance script and standard prose
  - agent: security
    reason: not-applicable
    note: no auth, secrets, PIN, LAN protocol, IPC or packaging surface; reads git log and local docs only
  - agent: tester
    reason: not-applicable
    note: no user-facing flow to exercise as a camp director
deterministic_checks: [test, lint, build]
human_gates: [product-owner review of the branch before merge]
verdict: pass
completion_evidence:
  - "npx vitest run scripts/check-governance.test.js: 48 passed"
  - "npm run check:governance: 0 status-drift findings, 0 index-stale (2 pre-existing s1b field-missing, out of scope)"
  - "npm run build: built in 6.22s"
archive_when: T76 and T77 land on main and the gate is green
---

# Run — work-record status-drift commit gate (T76 + T77)

Governor-orchestrated, test-first implementation of
`docs/adr/2026-08-09-work-record-status-drift-prevention.md` (product-owner approved).

## Success predicate

`checkStatusDrift` is implemented in `scripts/check-governance.js`, wired into `checkAll()`, and
fails `npm run check:governance` when a commit ahead of `origin/main` references a ticket/ADR/spec
whose frontmatter is not closed, or references a nonexistent ID. Tests cover both failure modes and
the pass case. `WORK_RECORD_STANDARD.md` defines the vocabulary normatively;
`GOVERNANCE_INDEX.md` points to it. The change dogfoods its own gate.

## Non-goals

No retroactive re-validation of history. No new npm script or CI job. No edits to the s1b ADRs that
carry pre-existing baseline findings on origin/main.
