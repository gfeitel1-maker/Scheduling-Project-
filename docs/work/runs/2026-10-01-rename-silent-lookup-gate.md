---
task: q-rename-silent-lookup-gate — three scripts/ detectors for the "wide rename, lookup silently returns nothing" class (#696 shipped five instances)
document_type: run
date: 2026-10-01
round: 1
status: in-progress
task_class: test-infrastructure
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: []
related_specs: []
related_adrs: []
selected_agents: [governor, architect, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no UI surface; the deliverable is scripts/ governance checks.
  - agent: tester
    reason: not-applicable
    note: no director-facing UX/visual surface; the deliverable is test/governance infrastructure.
  - agent: security
    reason: not-applicable
    note: no auth/PIN/secret/IPC/LAN-protocol/packaging change; checks are read-only static analyzers over committed test/scripts/schema text. (Revisit only if Architect finds detector C touches a security surface.)
deterministic_checks:
  - planted-defect red/green per detector shape on a scratch copy (cmd; echo EXIT=$?, unpiped)
  - each detector run against the full current clean tree -> zero false positives
  - the three new *.test.js unit tests beside each check (vitest, exit 0)
  - npm run check:governance exit 0 on the clean tree (new checks wired, blocking unless Architect justifies advisory)
  - npx eslint scripts (exit 0 — orphaned-import backstop)
  - footprint git diff --name-only origin/main (scripts/, optionally docs/governance/standards/TESTING_STANDARD.md, this run record; nothing under src/ or electron/)
human_gates: []
verdict: null
completion_evidence: []
archive_when: merged to main and the board item q-rename-silent-lookup-gate is closed
---

# Run: rename-silent-lookup gate (three detectors)

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** a wide rename (like #696 anchor→events) can no longer ship a lookup that keeps compiling and silently returns nothing without a gate catching it. Three static detectors, each wired BLOCKING into `npm run check:governance`, cover the three shapes #696 proved invisible to CI.

**Success predicate:** three checks exist under `scripts/`, each wired into `check:governance`, each proven to go RED on a planted instance of its shape and GREEN when removed, each producing ZERO false positives on the current clean tree, each stating what it cannot see; `check:governance` exits 0 on the clean tree; eslint clean; run record filled with canonical agent names.

**What does not count as done:** a detector with false positives on good code; a detector widened to catch a plant at the cost of real noise; a general-static-analysis claim that is not sound; any production-code change (src/, electron/).

## The three detector shapes (from #696)

- (A) A caller passing an object-literal argument key the callee no longer destructures/reads (shapes 1,2: findRouteConflicts call sites; scheduleInputNormalization key). HARD — Architect scopes the SOUND tractable subset and states what it cannot see.
- (B) A vacuous-assertion detector for test files: `expect(...)` over a statically empty/undefined selection (shape 3: ingest.t267 identity guard). Target the detectable subset; report the uncovered cases.
- (C) A renamed/dropped column name as a string in test/scenario/script SQL literals, checked against the LIVE schema (shape 5: `is_anchor` in 19-retire-orphan-slots.automerge.js). Parse CREATE TABLE columns from electron/db/schema.sql; denylist of known-migrated columns acceptable as the sound core.

## Task class and what it pulls in

`test-infrastructure` — governance/test tooling under `scripts/`.

| | |
|---|---|
| Standards | TESTING_STANDARD.md (gate list; one new sentence may describe the gate), CONSTITUTION.md Art. VII |
| Mandatory gates | check:governance (the checks wire in here), eslint, the new unit tests |
| Human gate | none |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | scopes the SOUND form of each of the three detectors + writes what each cannot see |
| Designer | no | not-applicable — no UI |
| Maker | yes | implements each check test-first |
| Code Reviewer | yes | read-only — are the three checks SOUND (zero FP on the clean tree)? |
| Verifier | yes | always — plants each shape on a scratch copy, red/green, FP sweep, footprint |
| Tester | no | not-applicable — no director-facing surface |
| Security | no | not-applicable — read-only static analyzers; no threat surface |
| Red Hat | yes | read-only — what rename shape does each detector miss? can C FP on migration-down files/aliases? can A be fooled by a spread/renamed param? |
| Grader | yes | calibrated score; a Grader FAIL ends the loop |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| planted red/green (A,B,C) | pending | |
| FP sweep on clean tree | pending | |
| new unit tests | pending | |
| check:governance exit 0 | pending | |
| eslint scripts | pending | |
| footprint | pending | |

## Architecture (detector design — recorded here, no ADR needed for a gate)

<filled from Architect's return>

## Verifier verdict

PASS / FAIL / UNVERIFIED — <pending>

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

<pending>

## Decision

PASS / RETRY / ESCALATE — <pending>

> A Grader FAIL ends this loop and escalates to the worker; it does not become a round 2.
