---
task: <ticket id or one-line description>
document_type: run
date: <YYYY-MM-DD>
round: 1
status: in-progress
task_class: <architecture | ui-ux-design | security-auth | scheduling-engine | database-sync | copy-terminology | documentation-governance>
governing_docs: []
related_tickets: []
related_specs: []
related_adrs: []
selected_agents: []
omitted_agents:
  - agent: <name>
    reason: <no-predicate | not-applicable | human-waived>
    note: <required for human-waived; quote the user verbatim>
deterministic_checks: []
human_gates: []
verdict: null
completion_evidence: []
archive_when: <condition>
---

# Run: <task title>

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** <what the user gets — not what the code does>

**Success predicate:** <the observable condition that makes this done>

**What does not count as done:** <the near-misses this must not be confused with>

## Task class and what it pulls in

`<task_class>` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | |
| Mandatory gates | |
| Human gate | |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | | |
| Designer | | |
| Maker | | |
| Code Reviewer | | |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | | |
| Security | | |
| Red Hat | | |
| Grader | | |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| | | |

## Verifier verdict

PASS / FAIL / UNVERIFIED —

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

<Anything real that this run did not fix. A finding with no ticket is a finding that will be
rediscovered.>

## Decision

PASS / RETRY / ESCALATE —

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
