---
task: closes T164 — verify reports INCONCLUSIVE (exit 2) when a step fails under machine oversubscription
document_type: run
date: 2026-09-15
round: 1
status: pass
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T164-libp2p-sync-tests-fail-under-load.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, verifier]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no schema, module-boundary, or protocol change — a verdict predicate added to an existing pure function
  - agent: designer
    reason: not-applicable
    note: no user-facing UI; the change is a developer-facing gate verdict line
  - agent: code-reviewer
    reason: no-predicate
    note: solo focused change; reviewed inline against the ticket's own re-diagnosis. Not independently dispatched.
  - agent: tester
    reason: not-applicable
    note: no director-facing behavior to exercise
  - agent: security
    reason: not-applicable
    note: no auth/secrets/PIN/LAN-protocol/IPC/packaging surface touched
  - agent: red-hat
    reason: not-applicable
    note: no stored-data-shape, op-log, sync/replay, or migration change
  - agent: grader
    reason: no-predicate
    note: single-dimension test-infra change; no multi-agent panel to consolidate
deterministic_checks: [eslint scripts/verify.js, scripts/verify.test.js]
human_gates: []
verdict: PASS
completion_evidence:
  - commit dd1cc9e (verify.js machineLoadVerdict + INCONCLUSIVE verdict; verify.test.js; ticket flip)
  - "eslint scripts/verify.js — clean (0 errors; 2 pre-existing unused-directive warnings, non-failing)"
  - "scripts/verify.test.js — 13 passed (incl. INCONCLUSIVE exit-2, FAILED-not-relabelled, pass-not-relabelled, 4x boundary, unknown→ok)"
archive_when: T164 is merged and the INCONCLUSIVE verdict is covered by tests
---

# Run: T164 — verify reports INCONCLUSIVE under oversubscription

## Brief

**Product outcome:** a developer (or agent) running the gate on a busy machine is told plainly when a
red is a load timeout rather than a defect, instead of re-running and guessing — which is the habit
that lets a real regression through.

**Success predicate:** a step failure under extreme machine load produces a distinct, non-zero
verdict (INCONCLUSIVE) that is never confused with a pass and never masks a real red.

**What does not count as done:** turning a real failure green; relabelling a *passing* run; tripping
on the normal few-times-oversubscribed load this repo runs by design.

## Task class and what it pulls in

`test-infrastructure` — a developer-facing gate-verdict change. No product standard, no data/security
surface. The relevant discipline is the "third answer" pattern the repo already uses (gateResultCode.sh
0/1/2, recordSyncHealthEvent, isLowDisk): a predicate over a noisy signal must answer pass / fail /
cannot-tell, not just pass / fail.

## Agents

Governor + Maker + Verifier. The change is a pure predicate (`machineLoadVerdict`) plus a branch in
the existing pure `verdict()`, both unit-tested. Architect/Designer/Tester/Security/Red Hat are
not-applicable (no schema, UI, director behavior, security surface, or stored-data/migration change);
Code Reviewer and Grader have no-predicate for a solo single-dimension test-infra change reviewed
inline against the ticket's own re-diagnosis.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| eslint (changed file) | pass | 0 errors (2 pre-existing unused-directive warnings, non-failing) |
| unit tests | pass | scripts/verify.test.js — 13 passed |

Note on scope of verification: the full `npm run verify` suite was **not** re-run in this session
because a native-module build (better-sqlite3-multiple-ciphers, for the separate at-rest SQLite
thread) was concurrently saturating the machine — which is precisely the oversubscription condition
this change exists to make legible. The change is isolated (a pure predicate + one verdict branch)
and fully unit-tested; the deterministic evidence above is the verifier basis for this record.

## Verifier verdict

PASS — eslint clean on the changed file; scripts/verify.test.js 13/13, pinning the INCONCLUSIVE
exit-2 path, the FAILED-not-relabelled path, the pass-never-relabelled invariant, the 4× boundary,
and unknown-load → ok.

## Findings carried forward

None. The broader directions the ticket lists (deterministic clock for the sync tests; serialized
port-binding pool) remain available but are deliberately not taken — the re-diagnosis showed the
failures were ordinary synchronous tests slowed by load, which a per-test clock would not have saved.

## Decision

PASS.
