---
title: "A hundred-camper import stops paying for a rollback boundary it already has"
document_type: ticket
status: open
created: 2026-09-29
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md]
related_tickets: [docs/work/tickets/T226-camper-preference-import.md]
archive_when: "committing the 100-camper preference sheet costs materially less CPU than it does today, with appendOp's atomicity unchanged at the top level, no change to op-log semantics (entity/field granularity, idempotent client_write_id retries, Trash/Restore/history/ingest-undo), and a structural guard that fails if a write path catches an appendOp throw inside a runAtomic body"
---

# T309 — A hundred-camper import stops paying for a rollback boundary it already has

## What a director hits

They import a 100-camper ranked-preference sheet. The main thread blocks for the whole commit —
and in Electron the main process is also serving IPC, so every screen is frozen and, in a paired
camp, every connected staff device is waiting too. `electron/ops/stmtCache.js`'s own header already
records this as a known harm (T66): a 400-group camp once blocked for 37 seconds.

## What is actually true, measured

Measured 2026-09-29 in this worktree, through `runPreferenceSheetCli` against the real
`docs/work/specs/samples/fabricated-camper-preferences-100.csv`, on a machine **saturated by ~211
concurrent vitest processes from other sessions (load average 430–550)**. That saturation is why
every number below is **CPU time (`process.cpuUsage()`, user+sys)** and not wall clock: wall clock
for the identical workload swung between 11s and 38s run to run, while CPU time held within ±10%.

The commit writes **8,564 field-level op rows** (1,000 `elective_preferences` × 8 fields, 100
campers × 5, 18 choices × 3, plus the run).

Arms were run **interleaved** (before/after/before/after/before/after in one shell, swapping only
`electron/ops/operations.js`) so that drift in machine load hits both equally — an earlier
non-interleaved sweep is exactly how the "super-linear" claim below got manufactured.

| | CPU for the whole commit | wall | µs/op |
|---|---|---|---|
| before | 2461 / 2469 / 2417 ms | 14.0 / 14.9 / 14.0 s | ~286 |
| after | 1031 / 1018 / 1021 ms | 6.3 / 6.4 / 6.5 s | ~119 |

**−58% CPU and −55% wall, with no overlap between the arms across three pairs.** CPU and wall agree
and the wall/CPU ratio held steady at ~6 throughout, which is what says the machine was in the same
state for both arms rather than the result being a scheduling accident.

### Root cause

`appendOp` wraps every single op in `db.transaction(() => …)`. Inside `runAtomic`'s outer
transaction, better-sqlite3 issues that as a nested **SAVEPOINT**. Holding a savepoint open makes
SQLite maintain sub-journal undo records for every write that happens inside it, so the cost is
paid by the whole import, not just by the savepoint statements.

This is **not** a statement-preparation cost and cannot be cached away. Replacing
`db.transaction()` with `SAVEPOINT`/`RELEASE` statements routed through `getStmt` was measured and
produced **zero** improvement (2640/2889/3149 ms CPU against a 2686 ms baseline). The savepoint has
to stop being opened, not be made cheaper.

## Three premises from the original brief that did not survive measurement

Recorded because each one would have sent the work somewhere wrong.

1. **"SUPER-LINEAR in document size" — not reproduced.** Per-op CPU is flat to slightly
   *decreasing* as the document grows: 6 campers 395 µs/op, 12 → 358, 25 → 335, 50 → 345, 100 →
   313. The reported climb (2.15 → 3.60 ms/op) was wall clock on a machine whose load was rising
   during the sweep. There is no page-cache spill to fix; `PRAGMA cache_size` was tested at 2 MB,
   8 MB, 64 MB and 256 MB and made no consistent difference. Wall-clock ms/op in a clean sweep runs
   the *other* way (6.27 → 3.15) as fixed startup cost amortises.

2. **"`latestOpForEntity` in `electron/ops/restore.js` has no non-test callers" — it has three:**
   `electron/ops/ingest.js`, `electron/ops/fieldProvenance.js`, and `restore.js` itself. It does use
   a bare `db.prepare`, which is worth routing through `getStmt` for consistency with
   `stmtCache.js`'s stated contract — but doing so was measured at **no** gain on this path
   (3049/3179/3200 ms against a 2686 ms baseline). It is a tidy-up, not a fix, and this ticket does
   not claim otherwise.

3. **"likely an inline copy in `electron/ops/projections.js`" — there is none.** All five
   `SELECT value FROM operations … ORDER BY seq DESC LIMIT 1` sites in that file already call
   `getStmt`.

Also ruled out, consistent with the brief: no scrypt or key derivation on this path; at-rest
encryption defaults OFF (`SHORESH_AT_REST_ENCRYPTION`) so no page cipher is involved; no subprocess.

## One thing the harness under-measures

`runPreferenceSheetCli` prints `liveDoc: userDataDir not configured — Automerge dual-write is inert`.
Every number above is therefore **SQLite only**. In the packaged app the Automerge dual-write is
live, so the real director's import is slower than these figures, and the savepoint saving is a
floor rather than a ceiling.

## Why the savepoint is removable inside `runAtomic`, and only there

`runAtomic`'s documented contract is already that all three stores share **one** rollback boundary:
any throw inside it rolls back SQLite, the op log, and the buffered document writes together. A
per-op savepoint nested inside that boundary can only matter to a caller that **catches an
`appendOp` throw and continues while still inside the transaction** — which would be violating
`runAtomic`'s contract anyway.

Every call site was read. No such caller exists:

- `setElectivePreference.js`, `finalizeElectiveRun.js`, `attributeElectiveSubject.js`,
  `setElectiveAssignment.js`, `commitElectiveRun.js`, `deleteRecord.js` — all catch **outside**
  `runAtomic`, reporting whole-transaction failure.
- `electron/ops/ingest.js`'s two inner `try`/`catch` blocks inside `runAtomic` guard `JSON.parse`,
  not `appendOp`.
- `electron/db/migrationDomainState.js` does not catch; it inspects `appendOp`'s **return value**.
- `commitElectiveCandidates` in `electron/ops/ingest.js` **is** a genuine catch-and-continue around
  `appendOp` — and it runs **deliberately outside any transaction** (its call site says so). There
  `appendOp` is the outermost boundary and **keeps its own transaction**, unchanged.

That last case is the reason the suppression must be scoped to `runAtomic` explicitly rather than
inferred from `db.inTransaction`: top-level `appendOp` atomicity is load-bearing and stays.

**The remote-write path does not reach `appendOp` at all.** Worth stating because it is the first
place a reader will worry about, and because `appendOp`'s own doc comments still describe a
retired architecture that says otherwise. A merge arriving from another device is applied by
`electron/sync/automerge/syncNode.js` through `electron/automerge/projector.js`, which opens its own
transactions and never calls `appendOp` or `runAtomic`. The `syncServer.js` / `handleSubmitOp` "Host
WS submit_op" caller those comments name has not existed since the Stage 6c cutover. That staleness
is real and misleading but spans ~20 files, so it is spun off rather than bundled into a
performance change.

## Review findings folded in

A red-hat review extracted the first draft of the structural guard's algorithm and ran it against
planted violations. It found two blind spots, **both re-confirmed here by planting them in real
files and watching the guard stay green**, and both now fixed and re-verified red:

1. The guard matched only the literal tokens `appendOp(` / `appendBulkReplaceOp(` — but this repo's
   dominant idiom is a local alias (`write`, `remove` in `ingest.js`, `commitElectiveRun.js`,
   `finalizeElectiveRun.js`, `attributeElectiveSubject.js`). A `try { write(db, …) } catch {}` inside
   `runAtomic` passed. Aliases are now collected per file and matched as call tokens.
2. It located the callback body as "the first `{` after `runAtomic(`", which is the *parameter*
   braces for `runAtomic(db, ({ x }) => …)` and the *object literal* for a concise body like
   `attributeElectiveSubject.js`'s. It scanned the wrong span and reported nothing even for a
   direct, unaliased violation. The scan is now the whole `runAtomic( … )` call expression, found by
   paren matching.

Also noted: `electron/ops/operations.js` already carries its own module-private
`latestOpForEntity` twin of `restore.js`'s, already using `getStmt` — so the consistency argument
for the `restore.js` tidy-up was already half-true of the codebase.

## Scope

In: `appendOp` skips its inner transaction only while a `runAtomic` frame is open on that db handle.
`latestOpForEntity` routed through `getStmt` (labelled as idiom consistency, not performance).

Out: `appendBulkReplaceOp` and `applyBulkReplaceProjection` keep their own transactions — they run
once per bulk op, not per row, and no cost was measured there. `runAtomic`'s deferred-document-write
mechanism is untouched.

## Success predicate

Committing the 100-camper sheet costs materially less CPU, **and**:

- an `appendOp` throw at the top level still leaves no `operations` row and no projected row;
- an `appendOp` throw inside `runAtomic` still rolls back the entire boundary;
- a top-level catch-and-continue caller still sees the failed op leave nothing behind and the next
  op succeed;
- op-log semantics unchanged: entity/field granularity, idempotent `client_write_id` retries,
  Trash/Restore/entity history/ingest-undo;
- a structural guard fails if a write path catches an `appendOp` throw inside a `runAtomic` body;
- the full gate is green.

## Non-goals

Not making the import asynchronous or moving it off the main thread. Not batching op rows into
fewer INSERTs. Not changing op-log granularity from entity/field. Not touching any SECURITY.md
parameter — none is on this path.

## Known limit at close

The 120 s per-test timeout override on `'commits the sheet and writes exactly the rows the fixture
describes'` in `scripts/preferenceSheetCli.test.js`, which this work is meant to let us delete,
**is not in `main`** — it is an uncommitted change in a sibling worktree
(`claude/objective-babbage-980cc9`). It cannot be deleted from here without taking that session's
unlanded work. It must be removed by whoever lands that change, once this one is in.
