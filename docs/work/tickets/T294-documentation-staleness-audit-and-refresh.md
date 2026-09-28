---
title: "Documentation staleness audit and high-priority refresh"
document_type: ticket
status: in-progress
task_class: documentation-governance
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
archive_when: "A prioritized staleness inventory exists (each finding citing the doc line and the contradicting code/current truth) AND the high-priority refreshes in the agent-read priority tier (CLAUDE.md, docs/current/**, docs/governance/**, SECURITY.md) have landed on main; ADR/README-layer findings that are lower priority may remain as tracked follow-up"
---

# T294 — Documentation staleness audit and high-priority refresh

## Why

The owner is concerned that documentation across the repo has drifted from reality and that agents
are making decisions off stale docs. Recent WAN/sync work shipped a lot (join-secret hardening,
v2 encrypted rendezvous record, the WAN-connectivity hardening-ladder ADR) — `PLATFORM_STATE.md`
and related descriptive docs likely lag it.

## Success predicate

1. A documented, **prioritized** inventory of stale/contradictory docs exists, each finding citing
   the doc line **and** the contradicting code or current truth.
2. The high-priority refreshes (agent-read priority tier) have actually landed on `main`.

Priority order = docs agents actually read to act:
`CLAUDE.md` → `docs/current/**` (esp. `PLATFORM_STATE.md`, `WHERE_DATA_LIVES.md`) →
`docs/governance/**` → `SECURITY.md` → ADRs and READMEs.

## Non-goals / ground rules (from CLAUDE.md, MUST honor)

- **Descriptive docs describe what IS** (CLAUDE.md, docs/current/**): where a doc disagrees with
  code, the CODE is right and the doc is stale — refresh the doc.
- **A standard is NOT overridden by code.** A standard/code contradiction is a **gap to report**,
  not license to amend either. Surface it for an owner decision.
- **`docs/archive/**` and `legacy/**` are historical** and must stay historical — do NOT rewrite
  history in ADRs/archive.
- When a sentence names something in order to say it is **GONE**, mark it historical
  (`_Prior:` / strikethrough / `doc-refs:historical`) rather than deleting.

## Method

Governor owns per the owner's engineering-workflow defaults: fan out parallel subagents across
non-overlapping doc domains (descriptive/current, governance/standards, security, ADR/README),
audit concurrently, converge on a single prioritized inventory, then land high-priority refreshes
in small reviewable PRs, each merged on green.

## Gates

`npm run index:work` · `npm run check:governance` (doc-refs + status-drift) · PR + merge on green
(CI is the gate of record).

## Remaining

Open until the success predicate is discharged. Findings that turn out to be a doc/standard/code
three-way contradiction are escalated to the owner rather than resolved unilaterally.
