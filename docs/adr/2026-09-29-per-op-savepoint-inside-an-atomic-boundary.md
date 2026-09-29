---
title: "A per-op savepoint inside an atomic boundary — who owns rollback for one op"
document_type: adr
authority: normative
status: proposed
implementation_state: in_progress
date: 2026-09-29
program: op-log
related_adrs:
  - docs/adr/2026-09-08-flat-record-shape.md
related_tickets:
  - docs/work/tickets/T309-op-log-import-write-cost.md
  - docs/work/tickets/T226-camper-preference-import.md
affects:
  - electron/ops/operations.js
  - electron/ops/restore.js
---

# A per-op savepoint inside an atomic boundary — who owns rollback for one op

## Status

Proposed, 2026-09-29. Touches `appendOp`, which `graphify god-nodes` ranks third in the repository
(105 edges) and which `CLAUDE.md` names as the choke point for every mutation in the app. Mandatory
Red Hat review on op-log and Trash/Restore/undo semantics before it ships.

## Context

`appendOp` makes two writes that must land together or not at all: the `INSERT INTO operations`
row, and `applyProjection`'s write of that value into the projection table. It has always achieved
that by wrapping both in its own `db.transaction(...)`.

Almost every real write path calls `appendOp` many times inside `runAtomic`, whose contract is
already that **all three stores share one rollback boundary** — any throw rolls back SQLite, the op
log, and the buffered Automerge document writes together. better-sqlite3 implements a nested
`db.transaction` as a `SAVEPOINT`, so on those paths every op opens and releases a savepoint inside
a transaction that is already guaranteeing the same thing.

That nesting is not free, and not free in the way it first looks. Measured on the 100-camper
preference-sheet commit (8,564 ops), removing the inner transaction cuts the commit's CPU from
1,566 ms to 740 ms of CPU on an idle machine — **−53%**, and −55% of wall clock, with the wall/CPU
ratio at ~1.0 confirming the work is genuinely CPU-bound. Making the savepoint statements cheaper
does nothing: issuing
`SAVEPOINT`/`RELEASE` through the existing `getStmt` cache was measured at **zero** improvement. The
cost is not preparing or executing the savepoint statements; it is that **an open savepoint obliges
SQLite to keep sub-journal undo records for every write made inside it**. The only way to stop
paying is to stop opening it.

## Decision

**`appendOp` keeps its own transaction when it is the outermost writer, and skips it while a
`runAtomic` frame is open on that database handle.**

`runAtomic` maintains a depth counter keyed on the db handle. `appendOp` consults it. When the
depth is greater than zero — and SQLite confirms a transaction really is open — `appendOp` runs its
insert-and-project body directly, letting `runAtomic`'s boundary own rollback for it. Otherwise it
behaves exactly as it does today.

### Why an explicit `runAtomic` signal and not `db.inTransaction`

Because they are not the same question, and the difference is load-bearing.

`db.inTransaction` answers "is *a* transaction open". The decision we need is "has a boundary that
**promises all-or-nothing** taken responsibility for this op". `runAtomic` makes that promise in its
contract. A bare `db.transaction` does not, and five modules are explicitly permitted to open one
(`confirmAlias.js`, `confirmCompoundCellPattern.js`, `migrationReviews.js`,
`openReconciliationDecisions.js`, `projectionRepair.js`) on the grounds that they write only
host-local tables. None calls `appendOp` today, but keying off `db.inTransaction` would silently
change `appendOp`'s guarantee for any future one that did. The explicit counter makes the
suppression opt-in by the only boundary whose contract already covers it.

### What this does not change

`appendOp` called with no transaction open — the top-level single write, the IPC path, and
`commitElectiveCandidates` in `electron/ops/ingest.js` — is unchanged. It still opens its own
transaction, and a throw still leaves neither an `operations` row nor a projected row.

That last case is the one that decided the design. `commitElectiveCandidates` catches an `appendOp`
throw and **continues its loop**, recording the failure and moving to the next candidate. It is the
only genuine catch-and-continue around `appendOp` in the repository, and its call site runs it
*deliberately outside* the commit transaction. Under this decision it keeps the per-op transaction
it depends on.

## The invariant this rests on, stated so it can be checked

> No write path may catch an `appendOp` throw and continue while inside a `runAtomic` body.

Every call site was read before this was written, and none does (the ticket lists them). A caller
that did would already be violating `runAtomic`'s contract — "the camp is either fully imported or
untouched" cannot survive a caller stepping over a failed write — but before this decision it would
have failed *quietly and half-correctly* (the savepoint would undo that one op), and after it the
op row would survive without its projection.

So the invariant gets a structural guard alongside the existing
`no write path opens its own transaction around an op append` check in
`electron/ops/operations.transactionBoundary.test.js`.

The same honesty applies to it, and the first draft earned it. Red hat review extracted that
draft's algorithm, ran it against planted violations, and found it blind to two shapes — both
re-confirmed by planting them in real files. It matched only the literal tokens
`appendOp(`/`appendBulkReplaceOp(`, missing this repo's dominant **alias** idiom (`write`, `remove`);
and it located the callback body as the first `{` after `runAtomic(`, which is the *parameter*
braces for a destructured arrow and the *object literal* for a concise body, so it scanned the
wrong span entirely. It now resolves per-file aliases and scans the whole `runAtomic( … )` call
expression by paren matching, and is verified red against both shapes and green on the clean tree.

What it still cannot see: a `catch` inside a helper defined in **another** file and called from a
`runAtomic` body (`slotOccupants.js`'s `clearSlotOccupant` is such a helper); `runAtomic` itself
under an alias; an alias assigned by destructuring or reassigned after declaration. It is a lexical
scan over four directories, not a call-graph proof.

Also worth recording, because a reader checking this decision will hit it: `appendOp`'s own doc
comments still name a second top-level caller, "the Host's WS submit_op path (`syncServer.js`'s
`handleSubmitOp`)". That file and that function have not existed since the Stage 6c cutover. The
live remote-write path is `electron/sync/automerge/syncNode.js` applying a merged document through
`electron/automerge/projector.js`, which never calls `appendOp` or `runAtomic` — so it is untouched
by this decision. The stale comments span ~20 files and are spun off rather than fixed here.

## Consequences

**Good.** A 100-camper import costs roughly half what it did — on a quiet machine, 1.6 s becomes
0.7 s. The saving is proportional to op count, so it grows with the sheet, and the op count is what
a director's sheet size drives. Every multi-write path benefits, not just this import: delete
cascades, week duplication, restore, undo, and the whole ingest route all run `appendOp` in a loop
inside `runAtomic`.

**Proportion, stated so nobody over-reads it.** The ticket this came from opened with "a director
importing 100 campers waits ~30s on a blocked main thread". That figure was measured on a machine
saturated by ~211 concurrent test processes; quiet, the operation was 1.6 s all along. This is a 2×
on a second-and-a-half, not a rescue from a freeze. It is worth doing because it halves the cost of
the choke point every mutation goes through and because the reasoning is simple and reversible —
not because the app was unusable.

**Cost.** `appendOp`'s atomicity now depends on *where it is called from* rather than being
unconditional. That is a real reduction in local reasoning — reading `appendOp` alone no longer
tells you whether one op can roll back on its own. The guard test and this ADR are what pay for it,
and the behaviour is the same in both branches for every caller that does not catch-and-continue
mid-boundary.

**Not addressed.** The import still blocks the main thread; it is now blocked for less time. Moving
it off-thread, or reducing the 8,564 rows an entity/field op log necessarily writes for 1,000
preferences, are separate questions this does not open.

## Alternatives rejected

**Cache the savepoint statements.** Measured: zero gain. The cost is the open savepoint's
sub-journal bookkeeping, not statement preparation. Recorded because it is the intuitive fix and
the repository's own `stmtCache.js` history makes it the one a reader will reach for first.

**Drop the inner transaction unconditionally.** Same performance, but it silently removes the
guarantee `commitElectiveCandidates` relies on — a failed `elective_sets` name write would leave an
`operations` row with no projected row, and the loop would commit that and carry on.

**Branch on `db.inTransaction`.** Cheaper to write, and correct for every caller that exists today.
Rejected for the reason given above: it ties `appendOp`'s guarantee to a fact about SQLite rather
than to a promise some caller has actually made.

**Batch the op rows into multi-row INSERTs.** A much larger change to the shape of the write path,
and it would not remove the savepoint, which is the measured cost. Out of scope.
