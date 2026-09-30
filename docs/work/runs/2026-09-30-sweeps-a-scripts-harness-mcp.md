---
task: "Sweeps PR A — five small test-infrastructure sweeps: agents:check manifest isolation, mining-lock expiry, harness join broadcaster, NUL guard widening + check:governance wiring, MCP dispatch hardening + README parity"
document_type: run
date: 2026-09-30
round: 1
status: in-progress
task_class: test-infrastructure
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_tickets:
  - docs/work/tickets/T221-agents-check-spurious-differs.md
  - docs/work/tickets/T169-gate-evidence-is-not-bound-to-the-commit-it-verifies.md
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, security, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no persistent data shape, no cross-module contract change — scripts, guards and test harness wiring only
  - agent: designer
    reason: not-applicable
    note: no renderer or visual surface is touched
  - agent: tester
    reason: no-predicate
    note: nothing here is observable to a camp director in the running app
deterministic_checks:
  - "npx vitest run scripts/generateAgentProfiles.test.js scripts/check-governance.test.js test/governance.test.js no-literal-nul.test.js test/gateResultCode.test.js test/lockIsStale.test.js scripts/mcp/serverDispatch.test.js scripts/mcp/readmeParity.test.js"
  - "npm run check:governance"
  - "npm run agents:check"
  - "npx eslint scripts test no-literal-nul.test.js"
  - "integration scenario for a joined device's appendOp write"
  - "red-then-green proof: NUL guard over .jsx"
  - "red-then-green proof: harness join broadcaster"
human_gates: []
verdict: null
completion_evidence: []
archive_when: the PR carrying this branch is merged and the five sweeps are visible on main
---

# Run: Sweeps PR A — scripts, harness and MCP

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** five known test-infrastructure defects stop being live. None is
director-visible; each one is a way a green verdict currently lies, or a way a tool damages the
repository it inspects.

**Success predicate:** all five land as described, each with the red-first proof recorded; the
named gates exit 0; the footprint stays inside `scripts/`, `test/`, the repo-root
`no-literal-nul.test.js`, `scripts/mcp/README.md`, `test/integration/harnessAutomerge.js`, this
run record and `docs/work/INDEX.md`.

**What does not count as done:**
- a widened NUL glob without the `check:governance` wiring behind it
- a lock expiry without a separately tested predicate
- a README table updated without a parity test that stops it drifting again
- a "green" claim on a check that abstained rather than passed

## The five sub-items

| # | Defect | Fix |
|---|---|---|
| 1 | `scripts/generateAgentProfiles.test.js` corrupts the **real committed** `docs/governance/agent-bindings/manifest.json` and leans on `afterEach` to put it back | `SHORESH_AGENT_MANIFEST` env override (mirroring the existing `SHORESH_ORG_DIR` precedent at `scripts/generateAgentProfiles.js:38`); the test corrupts a temp **copy** |
| 2 | `scripts/consolidation/mineFromPacket.sh` takes a `mkdir` lock that a `kill -9` leaves forever | extract a `lockIsStale` shell predicate (precedent: `scripts/gateResultCode.sh`), unit-test it, and have the miner remove a >86400s lock and say so on stderr |
| 3 | `test/integration/harnessAutomerge.js` wires `setLocalWriteBroadcaster` in `start()` and `restart()` but not in `join()` — a joined device's appendOp writes never push until a restart | wire it in `join()`; add an integration scenario proving a joined device's write reaches the host with no intervening restart |
| 4 | the repo-root `no-literal-nul.test.js` globs only `*.js`; and `checkDocFacts` **warns** on a null derivation inside a BLOCKING check | widen to `.js .jsx .mjs .cjs`, move the scan into `scripts/check-governance.js` as a blocking check with the vitest file delegating to it, and make a null doc-fact derivation a finding rather than a warning |
| 5 | `scripts/mcp/server.js:381` dispatches `tool.handler(...)` with no `try/catch` — a throw ends the stdio session; `scripts/mcp/README.md` documents 10 of 18 registered tools | wrap dispatch into the same `{ok:false, error}` envelope the unknown-tool branch uses (stack to stderr only), unit-test with a throwing stub, add the eight missing README rows and a registry⊆README parity test |

## Premise correction found before dispatch

The brief's sub-item 4 asserted that `scripts/doc-facts.js` **currently** emits
`doc-fact \`verify_step_count\` skipped (could not derive ...)`. It does not. Measured at
`3ceee575`: both derivations resolve (`schema_version => "83"`, `verify_step_count => "8"`) and
`npm run check:governance` prints no skip line. The **structural** defect is real and stays in
scope — a null derivation warns instead of failing, which is an abstention inside a blocking
check — but there is no broken regex to repair. No change to `scripts/verify.js`.

A pre-existing advisory `platform-state-stale` finding is present at `3ceee575` and is not this
run's to fix: `docs/current/PLATFORM_STATE.md` is another concurrent PR's footprint.

## Task class and what it pulls in

`test-infrastructure` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `docs/governance/standards/TESTING_STANDARD.md` |
| Mandatory gates | test · lint · build (scoped here to named files plus the touched integration scenario — the full suite is the merging worker's/CI's gate of record) |
| Human gate | changing a shared harness, setup file, or gate budget — `test/integration/harnessAutomerge.js` is a shared harness, and `check:governance` gains a blocking check |

Both human-gate triggers are recorded for the worker to carry to the owner with the PR; neither is
a new accepted tradeoff, a standard change, or an irreversible operation, so neither stops this
run under `CONSTITUTION.md` Article IV.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | not-applicable — no schema, no contract other modules call |
| Designer | no | not-applicable — no renderer surface |
| Maker | yes | five disjoint code changes |
| Code Reviewer | yes | five guards and a shared harness; plan alignment and maintainability |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | no-predicate — nothing director-visible |
| Security | yes | MCP error envelope (no stack/paths to the client) and an env-var-driven file path |
| Red Hat | yes | what still evades the widened NUL guard; what lock expiry does to a legitimately long mine; what the MCP catch swallows |
| Grader | yes | score from the four opinion reports |

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
