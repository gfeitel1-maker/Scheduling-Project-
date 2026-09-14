---
title: "Two review follow-ups: resolve a deferred outcome, and stop hand-listing the modeled tables"
document_type: ticket
status: completed
created: 2026-09-13
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: an op appended inside runAtomic reports its real document outcome once the boundary returns, and the migration source-scan derives the modeled-table list from the registry rather than a hand-typed copy
---

# T158 — Two review follow-ups

From an independent maintainability review of the four PRs that closed the
external architecture review. Both findings were real, neither was a
merge-blocker, and both are cheap — which is the argument for doing them now
rather than logging them.

## 1. `'deferred'` never became an answer

`runAtomic` flushes the buffered document writes **before it returns**, so by the
time any caller has the op back the real outcome is known — but the op still said
`'deferred'` forever, because the flush had no reference to the op object. A
value that looks like an answer is worse than no value, and T153's whole point
was to stop "buffered" being reported as "done".

The queued item now carries the op, and the flush stamps `'applied'` or
`'failed'` on it. A **rolled-back** boundary deliberately leaves it `'deferred'`:
the write settled nowhere, and claiming either outcome would be the lie. All
three cases are tested.

`DOCUMENT_OUTCOME` moved into `electron/ops/documentOutcome.js` to make this
possible — `operations.js` already imports `liveDoc.js`, so the symbol could not
live in either without one importing backwards. `operations.js` re-exports it, so
no caller changes.

## 2. The migration source-scan had its own copy of the registry

`migrationDomainState.test.js` hand-listed the modeled tables it scans for — a
second copy of "which tables the document owns", which is exactly the drift the
guard exists to prevent. It was already wrong: it omitted `camp_maps` and every
parent-scoped child, so a migration writing one of those inline would have passed
silently.

Now derived from `DIRECT_CAMP_ENTITIES` and `PARENT_SCOPED_ENTITIES`. Still
passes with the wider list, which is itself the useful result: no schema-only
migration writes any of them inline.
