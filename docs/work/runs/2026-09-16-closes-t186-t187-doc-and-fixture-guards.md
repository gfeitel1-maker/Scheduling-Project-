---
task: "T186 + T187 — gate descriptive docs against deleted paths, and engine fixtures against the real schema"
document_type: run
date: 2026-09-16
round: 1
status: in-progress
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T186-claude-md-goes-stale-by-construction.md, docs/work/tickets/T187-engine-fixtures-have-no-schema-parity-guard.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, red-hat, verifier]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: no new seam — both changes add a guard inside an existing gate/test boundary
  - agent: designer
    reason: not-applicable
    note: no user-visible surface
  - agent: tester
    reason: not-applicable
    note: no director-facing behaviour changes
  - agent: security
    reason: no-predicate
    note: no auth, secrets, IPC, transport or packaging surface touched
  - agent: grader
    reason: human-waived
    note: "owner instruction, verbatim — 'merge both once the gate is green and I will take you up on the recommendations above'"
deterministic_checks: []
human_gates: []
verdict: null
completion_evidence: []
archive_when: "T186 and T187 are both status completed on main and the guards they add have survived one subsequent structural change"
---

# Run: two guards for the same defect family

## Brief

**Product outcome:** the two documents a new session trusts most — `CLAUDE.md` and the engine's own
test fixtures — can no longer drift silently away from the code they describe.

**Success predicate:** a descriptive doc naming a path that does not exist fails the build; an engine
fixture carrying a column `anchor_activities`/`template_slots` does not have fails the suite.

**What does not count as done:** a rewritten `CLAUDE.md` with no mechanism behind it (that resets the
clock and guarantees the next instance), or a guard whose own tests pass while it cannot see the
defect it exists to catch.

## Why these two are one run

Both close the same family: **a check structurally incapable of returning the answer it is trusted
for.** T62 was a fixture inventing a column the schema never had, green for a month. The stale
`CLAUDE.md` named three files deleted in Stage 6 with nothing to notice. Neither had a guard on the
side of the seam where the defect actually lived.

## Task class and what it pulls in

`documentation-governance` — per `GOVERNANCE_INDEX.md` §3–8:

| | |
|---|---|
| Standards | WORK_RECORD_STANDARD.md, GOVERNANCE_INDEX.md |
| Mandatory gates | lint, agents:check, test, test:integration, security, check:governance |
| Human gate | owner approval to merge to trunk |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, one per ticket |
| Architect | no | no new seam (see omitted_agents) |
| Designer | no | no user-visible surface |
| Maker | yes | both implementations |
| Code Reviewer | yes | found 2 of the 6 round-2 gaps in T186 |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | no director-facing behaviour |
| Security | no | no auth/secrets/IPC/transport surface |
| Red Hat | yes | found 4 more in T186 and 4 in T187, including both silent cases |
| Grader | no | human-waived (owner instruction quoted above) |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| lint | PASS | `eslint .` clean in the integration gate |
| agents:check | PASS | 14 profiles byte-identical |
| test | | |
| test:integration | | |
| security | | |
| check:governance | | |

## Anti-vacuity — the substance of this run

Both guards were adversarially planted against, and **both failed shapes they were not designed for
before they passed.** This is recorded because a guard whose author reports only success is the
defect this run exists to close.

- **T186.** The recovered prior art (`archive/grpc-doc-gate`) missed **6 of 6** planted shapes,
  including resolving `electron/sync/discovery.js` clean against the real
  `electron/sync/automerge/discovery.js` — basename resolution cannot tell a wrong directory from a
  right one, so it would have passed the exact claim it exists to catch. The reworked version then
  gave up **6 more** to the review panel against an already-green 26/26 suite. A later independent
  plant of 8 fresh shapes: 8/8 caught.
- **T187.** First implementation caught the phantom column and the wrong-table key but **missed the
  helper-built fixture** — T184's exact blind spot. Red Hat then found 4 more, one of which
  (a shadowed same-name fixture) failed **completely silently** while the file's own comment claimed
  that direction "fails loud." The comment was wrong.
- The structural fix in T187 is the transferable one: `unresolved`/`computedKeys` were computed and
  asserted **nowhere** — telemetry wired to nothing, which is what made the silent case silent. They
  are now a pinned-empty list, so an authoring idiom that removes fixtures from coverage fails the
  suite instead of shrinking it invisibly.

## Verifier verdict

<!-- filled from the integration gate's printed verdict line, not an exit code -->

## Grader score

Not scored — human-waived (see `omitted_agents`).

## Findings carried forward

Both are documented in the code rather than buried, and both were accepted by the owner as stated
tradeoffs rather than filed as follow-up tickets:

1. **T186** — the check sees *deleted* paths only: a file that still exists but now behaves
   differently passes. And a bare filename is checked for existence *somewhere*, not at the location
   the sentence implies. Red Hat rates the second HIGH; tightening it would flag every legitimate
   mention of `buildSchedule.js`, and a gate that cries wolf gets disabled.
2. **T187** — fixture classification is by name. A fixture named nothing like an anchor or a slot is
   never classified, and the guard never learns the site exists. Closing it would mean inferring
   fixture-hood from data shape, trading a silent miss for a false-alarm rate.

## Decision

<!-- filled after the gate -->
