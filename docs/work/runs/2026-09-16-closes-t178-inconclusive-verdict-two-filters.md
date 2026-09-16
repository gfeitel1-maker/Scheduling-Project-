---
task: closes T178 — INCONCLUSIVE verdict two filters (load-sensitive + slow only)
document_type: run
date: 2026-09-16
round: 1
status: pass
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T178-inconclusive-verdict-metric-hardening.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, verifier]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no schema/module-boundary/protocol change — two guard conditions added to an existing pure verdict fn
  - agent: designer
    reason: not-applicable
    note: developer-facing gate verdict; no UI
  - agent: code-reviewer
    reason: no-predicate
    note: solo focused change; the driving evidence came from a peer's field measurements, reviewed inline against them
  - agent: tester
    reason: not-applicable
    note: no director-facing behavior
  - agent: security
    reason: not-applicable
    note: no auth/secrets/PIN/LAN/IPC/packaging surface
  - agent: red-hat
    reason: not-applicable
    note: no stored-data/op-log/sync/migration change
  - agent: grader
    reason: no-predicate
    note: single-dimension test-infra change
deterministic_checks: [eslint scripts/verify.js, scripts/verify.test.js, check:governance]
human_gates: []
verdict: PASS
completion_evidence:
  - commit 2184065 (verify.js two-filter downgrade + { step, ms }; verify.test.js; T178 flip)
  - "eslint scripts/verify.js scripts/verify.test.js — 0 errors"
  - "scripts/verify.test.js — 18 passed (incl. the 295ms and check:governance laundered-defect cases pinned as regressions, + the honest slow-load-sensitive downgrade)"
  - "check:governance — no findings"
archive_when: T178 is merged and the two-filter verdict is covered by tests
---

# Run: T178 — INCONCLUSIVE verdict two filters

## Brief

**Product outcome:** the quality gate never launders a real defect into "probably fine." A red only
becomes INCONCLUSIVE when it is genuinely a machine-load artifact.

**Success predicate:** a failure is downgraded to INCONCLUSIVE only if the step is load-sensitive
(test/test:integration) AND the failing step ran long enough to be a plausible load timeout
(≥ 10s); every other failure stays a plain FAILED (exit 1).

**What does not count as done:** downgrading a fast failure, downgrading a deterministic step, or
otherwise masking a real red.

## Task class and what it pulls in

`test-infrastructure`. The relevant discipline is the "absence/masking read as success" family this
repo keeps hitting; the fix keys the third answer (INCONCLUSIVE) on the step's own measured duration,
not raw loadavg alone.

## Agents

Governor + Maker + Verifier. Two guard conditions on a pure function plus a duration measurement in
`runVerify`, all unit-tested. The change was driven by a peer's two field measurements (a 295ms
`test` failure and a load-9.8 `check:governance` failure, both real defects the old verdict would
have laundered), reviewed inline against those; the other roster agents are not-applicable /
no-predicate as noted in frontmatter.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| eslint (changed files) | pass | 0 errors |
| unit tests | pass | scripts/verify.test.js — 18 passed |
| check:governance | pass | no findings |

Note on scope: the full `npm run verify` suite was not re-run in isolation for this record — the
change is confined to the verify wrapper's own pure logic, which its unit tests exercise directly,
including the two real-world laundered-defect cases as regressions.

## Verifier verdict

PASS — eslint clean; 18/18 in scripts/verify.test.js pinning both filters (load-sensitive-only,
slow-only), the two measured laundered-defect regressions, the preserved honest downgrade, and the
`{ step, ms }` duration measurement; check:governance clean.

## Findings carried forward

A persisted per-step duration baseline (vs the fixed 10s threshold) remains a possible future
refinement; not load-bearing now that the verdict keys on the step's own measured duration.

## Decision

PASS.
