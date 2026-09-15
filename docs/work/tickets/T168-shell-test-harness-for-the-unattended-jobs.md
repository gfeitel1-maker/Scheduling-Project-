---
title: "The two unattended jobs delete directories and write memory, and neither has a test"
document_type: ticket
status: in-progress
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

## Slice 1 shipped (2026-09-14)

The ledger reader — the single guard between the 06:30 prune and a directory Claude Desktop still
expects to reuse — is extracted from an inline heredoc into `scripts/readWorktreeLeases.py` and
tested by `test/worktreeLeases.test.js` (7 tests) against fixtures under
`test/fixtures/ledgers/`: healthy, empty, torn, schema-drift, ragged entries, and a path
containing a space.

The exit code is the contract, and the test that matters asserts drift and empty are
**distinguishable**: both print nothing, and only `rc` separates "nothing is leased" from "the
schema moved and protection is off". `integration.sh` now has an explicit arm for each code plus
a catch-all, so an unexpected exit (127, the reader missing from a stale checkout) reports loudly
instead of silently disabling protection.

**Still open:** the prune predicate itself (`ephemeral && clean && 0-ahead && idle`) and the
self-heal's four-way branch are still untested — both were verified by hand against real history.
Testing them needs a fixture `git worktree list --porcelain` table and a fixture `_pending`
directory, which is tractable but bigger than this slice. The failure classifiers in `run.sh` and
`mineFromPacket.sh` remain duplicated and untested because those files live outside the repo;
that is T165's problem to unblock.
