---
title: "The two unattended jobs delete directories and write memory, and neither has a test"
document_type: ticket
status: open
created: 2026-09-14
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/WORKING_COPY_STANDARD.md]
archive_when: integration.sh's prune predicate and run.sh's failure classification are each exercised by an automated test against fixture inputs, with no real worktree or memory directory involved
---

# T168 — The two unattended jobs have no test

`scripts/integration.sh` runs at 06:30 and **removes worktree directories**. The nightly
`run.sh` runs at 03:00 and writes memory proposals. Both run unattended, with permission to
modify the working copy, and neither has a single automated test.

Every defect found in them on 2026-09-14 was found by reading, and each was a predicate that
looked right:

- the self-heal checked for a log header that `run.sh` writes *before* doing any work, so
  "started" read as "succeeded" and eight consecutive failures were silent;
- the prune rule's `ephemeral && clean && 0-ahead && idle` is bit-for-bit the shape of a *pooled*
  Claude Desktop worktree, which the application still expects to reuse;
- an unguarded `$MEMDIR` reference under `set -u` would have been a hard runtime failure at 06:30,
  caught only because someone happened to grep for the variable's definition.

Testing shell is awkward, which is why this has not happened. The tractable subset is the pure
predicates: given a fixture worktree table and a fixture ledger, is this path pruned? Given a
fixture failure body, is it retried or halted? Both are decidable without touching a real
worktree or a real memory directory, and both are where the damage lives.
