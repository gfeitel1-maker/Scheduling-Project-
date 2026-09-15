---
title: "Make the agent-team activity report a standing measurement, not an ad-hoc probe"
document_type: ticket
status: open
created: 2026-09-15
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: observeRun reports, per Grader dispatch, whether gateReportCli was invoked and where it wrote, and the number is produced by a tested instrument rather than a throwaway script
---

# T170 — Make the activity report standing, not ad-hoc

## Why this ticket exists at all

On 2026-09-15 the question "why do ~74 Grader dispatches yield ~25 committed gate reports" was
attacked three times in twenty minutes with throwaway scripts. It produced three different
answers, each stated confidently:

| attempt | method | claim | status |
|---|---|---|---|
| 1 | co-location in the same transcript | 3 of 74 ran the CLI | **invalid** — subagent transcripts live in separate `subagents/agent-<id>.jsonl` files, so "same file" was the wrong join key |
| 2 | text heuristic over subagent transcripts | 34 of 72 — "about half skip it" | over-matched what counts as a Grader run |
| 3 | exact join on `toolUseResult.agentId` | 28 of 36 — ~78% **do** run it | covers only 36 of 74 dispatches; the rest carry no resolvable `agentId` |

Each attempt contradicted the last. That is not convergence, it is plausible stories being
generated faster than they can be invalidated — the same failure that produced the retracted
"grader 3 vs verifier 21" claim earlier the same day.

**No cause is asserted here.** What is robust, from git rather than transcripts: 292 commits on
`origin/main` since 2026-08-25 produced 1 run record and 2 gate reports.

## The actual work

Extend `scripts/observeRun.js` — which is tested, versioned, and already verified against an
independent walk — to record per Grader dispatch:

- the `agentId` from `toolUseResult`, and whether a subagent transcript exists for it;
- whether that transcript invoked `gateReportCli.js`;
- where it wrote, if it did — the `runsDir` matters, since a scratch path leaves no artifact;
- dispatches with no resolvable `agentId`, counted explicitly rather than silently dropped.

That last point is the one that matters most. Every probe so far silently excluded part of the
population and reported a percentage as though it covered all of it. The instrument must report
its own coverage, or it will mislead exactly the way the throwaway scripts did.

## Constraint

Do not add a general transcript query engine. One report, extended by a few fields, with its
coverage stated.
