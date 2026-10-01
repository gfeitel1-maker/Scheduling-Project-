---
title: "A per-op savepoint inside an atomic boundary — who owns rollback for one op"
document_type: adr
authority: normative
status: accepted
implementation_state: implemented
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
  - electron/sync/automerge/liveDoc.js
  - electron/automerge/campDocument.js
---

# A per-op savepoint inside an atomic boundary — who owns rollback for one op

## Status

Accepted and implemented 2026-09-29, landed in `c4144454` (#630). Touches `appendOp`, which `graphify god-nodes` ranks third in the repository
(105 edges) and which `CLAUDE.md` names as the choke point for every mutation in the app. Red Hat review on op-log and
Trash/Restore/undo semantics was mandatory and was done before it shipped; it found two blind spots
in this decision's own structural guard, both fixed (see below).

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

## Amendment — 2026-10-01: the document half of the same per-item cost

The decision above removed the per-op SAVEPOINT and left the statement that "the import still
blocks the main thread; it is now blocked for less time." This amendment names what the
remaining block actually was, removes one layer of it at the same choke point, and — because
the measurement refused to agree with the design — records plainly which layer is left.

**Measured.** The harness at `electron/electiveFreeze.perf.mjs` drives the
real `commitElectiveRun`/`finalizeElectiveRun` through the real `makeHandlers`, in interleaved
arms, measuring `process.cpuUsage()` deltas; the difference between the op-log arm and the
automerge arm isolates the document flush. Finalize, document-flush CPU (user+sys µs):

| n   | ops  | flush CPU before | cpu/op before | flush CPU after | cpu/op after |
|-----|------|------------------|---------------|-----------------|--------------|
| 40  | 565  | 1,675,538        | 2,966         | 599,208         | 1,061        |
| 80  | 1125 | 5,453,835        | 4,848         | 2,203,253       | 1,958        |
| 160 | 2245 | 21,426,318       | 9,544         | 8,396,349       | 3,740        |
| 312 | 4373 | 81,320,640       | 18,595        | 31,881,242      | 7,291        |

cpu-per-op doubled when n doubled before (×1.63, ×1.97, ×1.95), so the total was **O(n²)**. The
SQLite + op-log + `applyProjection` half — the half this ADR's original decision addressed — is
**flat** at 87.9 → 55.6 µs/op and totals 0.24 s at n=312. The document flush was **99.7%** of
finalize. The director saw the app frozen for minutes after Finalize and over a minute after
Commit.

**Mechanism.** A `runAtomic` body appends many ops; each `appendOp` defers its document write
(`recordLocalWrite`), and `commitDeferredDocWrites` then replayed them **one at a time** through
`applyLocalWriteNow` → `applyWrite`, which is **one `A.change` per field**. Each `A.change`
re-materialises the patched collections, and `applyWrite` touches the entity collection plus a
provenance key and an author key — so 15 fields on one row is 45 keys across three growing
collections. Finalize is the loudest caller, not the only one: every `runAtomic` body pays this,
including imports, `duplicateWeek`, delete cascades and `commitElectiveRun`.

**Decision.** Batch the replay at the choke point. `commitDeferredDocWrites` partitions its queue
into maximal **contiguous runs by kind** and applies each `write` run through one `A.change`
(`applyWrites` in `campDocument.js`, which reuses `applyWrite`'s per-field body verbatim rather
than forking it — `applyWrite` becomes `applyWrites(doc, [write])`). `bulk` items stay per-item,
because `applyBulkReplace` is a different change against a different collection and throws rather
than returning for an unregistered entity. Contiguity is what preserves order across the mix.

### What the measurement actually said — the acceptance condition was NOT met

The acceptance condition set for this change was **flatness** of cpu-per-op across the four
sizes. It is not met. After the fix the growth factors are ×1.85, ×1.91, ×1.95 — still a
doubling per doubling, still **O(n²)**. What the change bought is a constant factor:
**2.55× less CPU at n=312** (81.3 s → 31.9 s of flush CPU), 2.8× at n=40. That is real, it is
the per-change ceremony this ADR named, and it is worth keeping. It is not the fix the design
predicted.

**Where the remaining quadratic lives, measured rather than guessed.** A `--cpu-prof` run of the
n=160 automerge cell attributes **~22 s of 31.8 s** to one frame:
`automerge::transaction::inner::TransactionInner::exid_to_obj` inside `automerge_wasm`. That is
the object-id resolution every property access through a change proxy pays, and its cost grows
with the document. Batching reduces the number of **changes**; it does not reduce the number of
**proxy accesses**, which is one per key written and therefore still O(n) accesses each costing
O(document). Three independent synthetic benchmarks (growing collection, growing document,
growing change history, repeated overwrites) were all flat at ~0.2–0.8 ms per write, so the
superlinearity is specific to the real seeded camp document and is not reproduced by any
simplified fixture — which is the honest reason it is not closed here.

Hoisting the three collection proxies (`d[entity]`, `d[field_provenance]`, `d[field_author]`) out
of the per-field body, so each is resolved once per change instead of once per write, was
implemented and measured: **31.86 s vs 31.88 s at n=312 — no effect.** The cost is in the
mutating accesses, which are irreducible at one per key. It was reverted rather than kept as
complexity that buys nothing.

So the next step, if finalize is still too slow for a real camp, is not another batching layer.
It is either a document shape that writes fewer keys per row, or moving the flush off the IPC
reply path, and both are their own decisions.

**What stays identical, and why each one is not a shrug.**

- *Materialised document state.* Same writes, same order, same actor. Within one change a later
  write to a key overwrites an earlier one, exactly as a later same-actor change does; same-actor
  changes are causally ordered and never conflict with each other. Pinned by a document-equality
  test whose fixture exercises every branch of the per-field body (plain write, `source:'import'`,
  `source` omitted, `author_user_id: null`, delete, re-write after delete, unknown field, lazy
  collection top-up, repeated write to one field), compares the entity **and** provenance **and**
  author collections, deliberately does **not** compare saved bytes (they legitimately differ),
  and carries a mutation check: reversing the batch order must make the test fail. Both arms are
  built with `A.load(bytes, { actor })` against one explicit actor, because neither two
  `createEmptyDoc()` calls nor two `A.load(A.save(base))` calls share an actor — each mints a
  fresh random one, measured.
- *Conflict granularity.* `reconcile.js`, `reconcileForProjection.js`, `conflictStore.js` and
  `uniqueConflicts.js` were read for this: all four are pure functions of document **state**.
  `reconcile.js` walks keys and calls `A.getConflicts(collection, key)`; `conflictStore.js` keys
  rows on `(entity, entity_id, field)`. None counts changes or reads heads. The only
  change-boundary reasoning in the repo is `A.getHeads`/`synthesizeOpEvents` in `syncNode.js`,
  whose sole non-test call site is the **remote-merge receive** path, which local writes never
  reach. Peers never observed a partial window anyway: the broadcast is debounced to the end of it.
  Pinned by a test that merges the same concurrent third-party edit into the N-change arm and the
  1-change arm and requires the same winner and the same `A.getConflicts` entry set.
- *Per-item failure containment.* Read against the installed version, `@automerge/automerge`
  **3.4.1** (`package-lock.json`, not the `^3.4.1` range): a throw inside the `A.change` callback
  runs `state.handle.rollback()` and rethrows **without** reaching `progressDocument`
  (`dist/mjs/implementation.js`). So there is no partial-batch state, and the original document is
  neither consumed nor marked outdated. A failed batch therefore falls back to the existing
  per-item loop, re-read from the registry, applying each write exactly once — contained and
  attributed to its own `op_id` exactly as before. Pinned by a test that injects a real fault
  (a symbol value, which Automerge refuses) mid-batch and requires every other write in the run to
  land **exactly once** — asserted on the change count, not just the value.
- *`DOCUMENT_OUTCOME`.* A run that commits stamps `'applied'` on every op in it, which is true
  because the change is atomic. A run that fails is retried per item, so the per-op verdict is
  restored. **No path stamps a batch-wide `'failed'`** — that invariant is the thing to protect.
- *`scheduleSave`'s `opIds`.* Still called once per op id. Collapsing it to one call per batch
  would drop n−1 ids from the ledger `flushPendingWrites` uses to attribute an fsync failure, and
  a disk failure would then name one op out of four thousand. The call is a `Map`/`Set` write; it
  is not where the cost was. Pinned by a test that fails the save after a batched flush and
  requires every op id in the window to be recorded.
- *Crash window.* Two windows exist: SQLite-committed→document-correct-in-memory (was the 81 s
  replay, now 32 s) and in-memory→on-disk (`SAVE_DEBOUNCE_MS`, unchanged). The first narrows by
  2.55×. Nothing widens.
- *Schema.* None. No table, column, migration or `PROJECTIONS` change.

**Scope.** The fix lands only at `commitDeferredDocWrites`, which fixes every caller. Moving
finalize's post-write work off the IPC reply path was considered and **deferred, not rejected**:
the original reasoning ("with the quadratic gone the projected finalize is about one second")
does not hold, because the quadratic is not gone. It reopens as its own ticket, alongside the
document-shape question, and this amendment is the evidence both would start from.

**What it did fix outright.** The small-commit-after-a-large-finalize case — the "Committing…"
that appeared never to end — improves by **6–7×**: 58 ops into a camp already carrying a 312-camper
finalized run went from 11,086 µs/op (~665 ms wall) to a median 1,700 µs/op (~120 ms wall). That
one is dominated by the per-change constant rather than by document size, which is exactly what
batching removes.

**Reversibility.** Additive: one new export, one new private function, one branch across two files.
`applyWrite` keeps its signature and every caller is untouched, so rollback is a plain revert of
the single commit. No feature flag — shipping both paths would mean testing neither.

**This amendment stretches the ADR's title**, which names the savepoint. It is filed here because
it is the same finding at the next layer down — the per-item ceremony inside one `runAtomic` body
is the cost, measured the same way — and because this ADR's own "Not addressed" paragraph is the
sentence it continues.

### Alternatives rejected (amendment)

**Chunked batching, K writes per change.** Still O(n²/K): a 10× gain that the next camp size eats,
and a per-chunk verdict is a coarser failure report than per-op with no recovery path.

**Hoisting the collection proxies out of the per-write body.** Implemented and measured: no
effect (see above). Rejected on evidence, not on taste.

**Shadow document: clone, batch, merge back.** A clone takes a fresh actor id, so every batched
write becomes concurrent with itself on merge — it manufactures `getConflicts` entries from writes
that were causally ordered. It also copies the whole document per flush. Recorded because it reads
as the clever answer.

**Collapsing repeated writes to the same field before replay.** Orthogonal: finalize writes each
field exactly once, so it buys nothing on the measured workload.

**Reshaping the stored document (per-field objects, lazy collection views).** That is the flat
record shape fixed by `docs/adr/2026-09-08-flat-record-shape.md`, and a document-shape change is a
different decision — but it is now the leading candidate for the remaining quadratic, because the
number of keys written per row is what the measured cost is proportional to.

**Applying ops below `A.change`, or `saveIncremental`/`loadIncremental` tricks.** Bypasses the
provenance, authorship and tombstone semantics `applyWrite` owns, on API surface Automerge does
not document as public.
