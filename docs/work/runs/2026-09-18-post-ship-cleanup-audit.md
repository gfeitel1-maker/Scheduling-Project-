---
task: Post-ship cleanup audit — ticket status reconciliation, T173 archival, branch and worktree reclamation
document_type: run
date: 2026-09-18
round: 1
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T62-engine-schedules-anchor-activities-as-regular-slots.md, docs/work/tickets/T182-stale-anchor-duplicate-finding.md, docs/work/tickets/T185-payload-addressed-finding-dismissal.md, docs/work/tickets/T193-overlay-reconstruction-and-route-validator.md, docs/work/tickets/T194-participant-data-substrate.md, docs/work/tickets/T215-libp2p-3x-upgrade.md]
related_specs: []
related_adrs: []
selected_agents: [governor, architect, verifier]
omitted_agents:
  - agent: designer
    reason: no-predicate
    note: no user-visible surface changes in this run
  - agent: maker
    reason: not-applicable
    note: documentation and repository hygiene only; no source changes
  - agent: code-reviewer
    reason: no-predicate
    note: no source diff to review
  - agent: tester
    reason: no-predicate
    note: no director-facing behaviour changes
  - agent: security
    reason: no-predicate
    note: no auth, secrets, transport, IPC or packaging surface touched
  - agent: red-hat
    reason: not-applicable
    note: no stored data shape, op log, sync/replay or migration change
  - agent: grader
    reason: not-applicable
    note: single-round documentation reconciliation with no competing agent reports to consolidate
deterministic_checks: [check:governance, index:work]
human_gates: [owner approved the four-step cleanup plan in session]
verdict: pass
completion_evidence: ["check:governance — no findings", "index:work — no drift", "git ls-remote --heads origin → refs/heads/main only"]
archive_when: the five drifted ticket statuses are flipped with their evidence recorded, T215's unmet condition and its owner are visible in the ticket, the T173 design is preserved outside the deleted branches, and the reclaimed branches and worktrees are gone
---

# Run: Post-ship cleanup audit

> Written before the gate per `WORK_RECORD_STANDARD.md` §5.1. The verdict line is filled in
> afterwards and nothing else is.

## Brief

**Product outcome:** the owner can look at the ticket backlog and the branch list and see what is
actually true. After a large ship, neither described reality.

**Success predicate:** every ticket whose work has shipped reads `completed` with the evidence that
settles it; every ticket whose work has NOT shipped stays open with the unmet condition and its
owner named; no branch or worktree survives whose content is already on `main`; and nothing that
existed only on a deleted branch is lost.

**What does not count as done:** flipping statuses on the strength of a merged PR title. Three of
the five flips below were verified in code; two came from the sessions that built them, who read
their own `archive_when` clauses back to me. T215 looked exactly like the other five and is the one
that must NOT close — a PR merging is not the same as a ticket's conditions being met.

## Task class and what it pulls in

`documentation-governance` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `WORK_RECORD_STANDARD.md`, the descriptive-doc path guard (`check:governance`) |
| Mandatory gates | `check:governance`, `index:work` |
| Human gate | owner approved the plan; the licensing PR is left unmerged for the owner |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing; also dispatched to land the stranded licensing branch |
| Architect | yes | the T173 keep-or-archive call needed a schema-collision assessment |
| Designer | no | no-predicate — no user-visible surface |
| Maker | no | not-applicable — no source changes |
| Code Reviewer | no | no-predicate — no source diff |
| Verifier | yes | always |
| Tester | no | no-predicate — no director-facing behaviour |
| Security | no | no-predicate — no auth/transport/IPC/packaging surface |
| Red Hat | no | not-applicable — no data shape, op log, sync or migration change |
| Grader | no | not-applicable — single round, no competing reports |

## What was decided, and on what evidence

**Closed — verified in code by this session:**

| Ticket | Shipped | Evidence read |
|---|---|---|
| T62 | #443 | `src/engine/anchorActivityLink.js` resolves by NAME; `buildSchedule.test.js` pins the real-row-shape regression; `fixtureSchemaParity.test.js` now blocks the synthetic `activity_id` that hid the defect for a month |
| T182 | #445 | `ANCHOR_DUPLICATE` emitted from `buildSchedule.js`, keyed via `schedule/findingKey.js`, rendered in `ScheduleScreen.jsx` |
| T185 | #448 | `findingDismissKey` is the single key source; both the filter (`ScheduleScreen.jsx:571`) and the dismiss write (`:629`) route through it; `findingKey.test.js` pins the masking scenario |

**Closed — on the direct evidence of the sessions that built them:**

| Ticket | Shipped | Who, and what they checked |
|---|---|---|
| T193 | #465 | the building session confirmed `src/engine/routeConflicts.js` and the renamed T202 ticket are both on `main` |
| T194 | #473 | the building session read its `archive_when` ("the five entities ship with full registry parity") and confirmed #473 met it. T194 is **not** an umbrella — T195–T199 and T202 are siblings with their own clauses; the programme's completion lives in the ADR |

**Left open, deliberately:** T215. See the ticket — two of three `archive_when` conditions met, the
third (mixed-version 2.10 ↔ 3.x replication) not demonstrated and not surfaced. Two live sessions
were asked independently and agreed. The condition was explicitly NOT moved onto T217, because
doing so would make both tickets closeable while the demonstration never happens.

**Archived:** the T173 design spec and ticket, which existed only on two unmerged branches.
Preserved at `docs/archive/completed-specs/`. Slice 1 shipped (#418, byte-identical to the branch
copy); slices 2–4 were never built and their premise is disproven by #434 — eight real workbooks
produced zero journal rows because the importer asks nothing. Rebasing was rejected: both branches
minted schema v62–v64 for device-side journal tables and `main` converged on a different
consolidated shape, so this is re-authoring, not conflict resolution.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| check:governance | PASS | `check:governance — no findings.` against this exact tree |
| index:work | PASS | `docs/work/INDEX.md` regenerated and already current — no drift |

Both gate scripts import only `node:` builtins (`node:fs`, `node:path`, `node:url`,
`node:child_process`) — verified — so the absent local `node_modules` in this worktree could not
silently have changed what ran. The full suite is CI's job and CI is the gate of record.

## Verifier verdict

**PASS (scoped).** The two gates this documentation-only change can fail both pass. `npm run verify`
was NOT run locally: this worktree has no `node_modules`, the change touches no source, and CI is
the gate of record for merging. Recording that as a scoped pass rather than a full one, because
"the gate is green" and "the two gates I ran are green" are different claims.

## Findings carried forward

1. **`check:governance`'s status-drift check is skipped entirely in CI** — the shallow clone has no
   `origin/main` to diff against. A green CI run is therefore not evidence that status drift was
   checked; it is evidence that it was not. This is plausibly how a six-ticket backlog accumulated
   unnoticed. **No ticket yet — needs one.**
2. **T194's frontmatter says five entities; seven shipped.** The count grew during design and was
   never updated. Recorded in the ticket rather than silently corrected, so a later reader does not
   mistake it for a missing pair.
3. **The libp2p cross-version demonstration (T215 condition 3) is real, unmet work** that no merged
   PR covers. Claimed by the session on `claude/shoresh-rendezvous-wan-handoff-5f211b`, queued
   behind the merge train. If that branch is abandoned the condition becomes unowned.
4. **`@chainsafe/libp2p-quic` had been guarded accidentally** — it was uninstallable under
   `@libp2p/interface@^2.11.0`, so the dependency graph, not the Tier-4 guard, was keeping it out.
   The 3.x bump removed that accidental protection; #472 added both it and `@libp2p/webrtc-direct`
   to the guard list explicitly.

## Decision

**PASS.** Six ticket statuses now say what is true, the one that must stay open says why and names
its owner, the T173 design survives the branches it lived on, and 19 branches plus 9 worktrees
(3.5 GB) are reclaimed with the remote down to `main` alone.
