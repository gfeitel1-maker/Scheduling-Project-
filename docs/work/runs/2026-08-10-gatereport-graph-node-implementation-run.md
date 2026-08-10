---
task: GateReport graph node — implement migration steps 1–3 (ADR 2026-08-09-gate-stack-as-fixed-fanin-graph)
document_type: run
date: 2026-08-10
round: 2
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T79-declare-gatereport-schema-and-reducer-spec.md]
related_specs: [docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md, docs/work/specs/2026-08-10-gatereport-implementation-brief.md]
related_adrs: [docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md]
selected_agents: [governor, architect, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no UI surface — governance/harness tooling only (scripts + agent-definition + standards docs)
  - agent: tester
    reason: not-applicable
    note: no running-app/UX surface to evaluate; the reducer is a pure function verified by unit tests, not a director-facing feature
  - agent: security
    reason: not-applicable
    note: touches no auth/secrets/PIN/LAN-protocol/IPC surface. The only risk surface is audit-trail gaming (turning a real BLOCK into a pass), which is Red Hat's anti-laundering brief — and Red Hat exercised it, finding and clearing exactly such a vector (see below)
deterministic_checks: [test, lint, check:governance]
human_gates: [adr-acceptance]
verdict: pass
completion_evidence: [scripts/gateReportReduce.js, scripts/gateReportReduce.test.js, scripts/gateReportSchema.js, scripts/gateReportSchema.test.js, scripts/gateReportPersist.js, scripts/gateReportPersist.test.js, scripts/gateReportCli.js, scripts/gateReportCli.test.js, docs/work/runs/gate-reports/T79-impl-r2.json]
archive_when: ADR 2026-08-09-gate-stack-as-fixed-fanin-graph implementation_state is implemented and migration step 4 (Model B vs C) is separately decided or explicitly dropped
---

# GateReport graph node — migration steps 1–3 implementation run

Implements the owner-approved ADR `docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md`
(Model A — gate stack as a fixed fan-in graph node), migration steps 1–3 from the exploration
doc §10, against the contract in `docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md`.
Step 4 (extend structure toward Model B vs. persist routing trace toward Model C) is a deferred
future decision and was explicitly out of scope.

## What was built

- **Step 1 (schema + reducer, contract as code):** `scripts/gateReportSchema.js` (PerGateReport
  validation + shared enums) and `scripts/gateReportReduce.js` (`reduceGateReport(...)`, a pure,
  deterministic total function implementing spec §5.1–§5.8). Test-first: `gateReportReduce.test.js`
  covers the worked example (§10), the `verifier_pass=false` absolute hard block across FAIL /
  UNVERIFIED / missing / malformed Verifier, the missing→incomplete path, malformed→BLOCK,
  self-declared N/A, cross-gate flags, anti-laundering L1–L7, and edges E1–E5.
- **Step 2 (persist, additive/reversible):** `scripts/gateReportPersist.js` writes one JSON record
  per `(task_id, round)` under `docs/work/runs/gate-reports/` with an injected `runsDir`;
  `scripts/gateReportCli.js` is the thin CLI Grader invokes and returns the record path as
  `gate_report_ref`. H1 (expected gate set frozen before dispatch) is satisfied by existing
  Governor practice — `selected_agents`/`omitted_agents` written pre-dispatch — and reinforced by a
  one-line freeze rule added to `WORK_RECORD_STANDARD.md` §5.1 (placed there, not the brief's
  literal "§2", because §2 is Common fields and §5.x is the Schema section that actually defines
  those fields; the deviation is disclosed inline in that file).
- **Step 3 (Grader input swap):** `.claude/agents/grader.md` now receives Verifier as a fifth
  input, transcribes each report to a `PerGateReport`, invokes `gateReportCli.js`, sources its
  verdict from `decision_eligibility`, drops the now-redundant Pass A/Pass B bias-mitigation
  protocol (arithmetic mean over a fixed list has no position bias), and surfaces
  `incomplete`/`gap`/`self_declared_na` to Governor.

## Review loop (2 rounds)

- **Round 1:** Verifier PASS (0 new lint/governance findings; scoped tests green). Code Reviewer
  PASS with two LOW findings (evidence_ref null-vs-undefined; H1 §5.1-vs-§2 placement disclosure).
  Red Hat **BLOCKED** on a real, reproduced HIGH: the reducer's scoring set iterated all four
  opinion gates rather than `expectedOpinionGates`, so a stray/unexpected well-formed report could
  silently inflate `overall_score` and flip BLOCK→PASS_ELIGIBLE — a laundering vector the spec's own
  §2/L1 intent forbids but §5.3 text failed to enforce.
- **Round 2 fix:** an unexpected opinion-gate report is now treated as an anomaly → recorded in
  `malformed[]` (with its evidence_ref) → excluded from scoring → forces BLOCK. Fixed in both code
  and the settled spec (§5.1/§5.3 + new property L7 in §11), with a red-green test (fails without
  the fix, passes with it) plus the previously-missing duplicate-`gate_name` regression test. The
  two Code Reviewer LOWs were also resolved.
- **Round 2 re-review:** Verifier re-confirmed green (61/61 scoped tests, eslint clean, governance
  at the 5 pre-existing unrelated findings). Red Hat re-attacked and returned **CLEARED** — HIGH
  and MEDIUM genuinely closed (structural fix, no side-door bypass, totality holds).
- **Grader (scored through the new mechanism — this is the step-3 dogfood):** transcribed the five
  reports, ran `gateReportCli.js`, and scored from the returned typed record:
  `verifier_pass: true`, `overall_score: 4`, `lowest_dimension: 4`, `decision_eligibility:
  PASS_ELIGIBLE` → **PASS**. Persisted record: `docs/work/runs/gate-reports/T79-impl-r2.json`.

## Human gate

ADR acceptance (Constitution Article IV) — owner approved Model A and instructed implementation on
2026-08-10; the ADR was flipped `status: proposed→accepted`, `implementation_state: not
started→implemented`, and a Completion-evidence section was added, all in this branch.

## Deterministic evidence

- `npx vitest run scripts/gateReport*.test.js` → 4 files, 61 tests, all pass.
- `npx eslint scripts/gateReport*.js` → clean, exit 0. Full `npm run lint` → 0 new errors.
- `npm run check:governance` → 5 findings, all pre-existing and unrelated (ingestion-* /
  schedule-drag-*); this work introduces none.
