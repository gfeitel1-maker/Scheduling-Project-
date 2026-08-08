---
title: T48-branch-cleanup
document_type: ticket
status: completed
created: 2026-08-05
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: []
archive_when: all stale branches deleted and verified clean
---

# T48 — Branch cleanup

**Status: open.**

---

## What it is

Fourteen local branches exist that have zero commits ahead of main and serve no further purpose.
Two have commits that have not yet landed on main and need disposition before deletion.

## Branches with commits not yet on main (need review before delete)

| Branch | Commits ahead | Notes |
|---|---|---|
| `work/architecture-audit` | 2 | Architecture auditor agent + first audit doc. Check whether the agent file was merged with the rest of the architecture work before deleting. |
| `work/slice-1-hardening` | 1 | A slice-1 hardening fix. Confirm whether this was intentionally left off main or is just a missing merge. |

## Branches that are fully merged (safe to delete)

All have 0 commits ahead of main:

`work/T37-flicker-fix`, `work/T39-flaky-tests`, `work/architecture-decisions-r2-r5`,
`work/decouple-main-ipc`, `work/flag-review-import-dev-loop`, `work/ingest-fixed-events`,
`work/ingest-methodology`, `work/multi-week-slice-1`, `work/r1-projections-guard`,
`work/r2-ipc-parity`, `work/r3-restructure`, `work/r4-use-weeks`, `work/r5-docs-closure`,
`work/slice-2-data`, `work/slice-2-ui`, `work/slice-3-delete`, `work/t44-flakiness`

Also clean up the dangling worktree ref: `worktree-agent-a6c7394e00e0e2d02`.

## Remote branches

Several branches exist only on `origin` and not locally:
`origin/backup/wip-2026-07-27`, `origin/work/schedule-decoupling-analysis`

Confirm with product owner before deleting `backup/wip-2026-07-27` — it may be a deliberate
safety copy.

## Acceptance

- [ ] `work/architecture-audit` and `work/slice-1-hardening` dispositioned (merged or intentionally abandoned)
- [ ] All fully-merged local branches deleted
- [ ] Stale remote tracking refs pruned (`git remote prune origin`)
- [ ] `work/t46-week-failure-handling` and `work/t44-flakiness` (in-flight) left intact until their PRs land
